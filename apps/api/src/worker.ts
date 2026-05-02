/**
 * AssessIQ background worker — BullMQ scheduler.
 *
 * Runs as a separate process (apps/api Docker image, second container) and
 * schedules two repeating jobs per the current Phase 1 surface:
 *
 *   1. assessment-boundary-cron — every 60s.
 *      Drives module 05's processBoundariesForTenant for every active tenant.
 *      Transitions assessments published → active (when opens_at passes) and
 *      active → closed (when closes_at passes). Idempotent: zero-rowcount on
 *      successive runs is the steady state.
 *
 *   2. attempt-timer-sweep — every 30s.
 *      Drives module 06's sweepStaleTimersForTenant for every active tenant.
 *      Auto-submits in_progress attempts whose ends_at has passed. Idempotent
 *      via the partial WHERE filter on attempts.status='in_progress'.
 *
 * Multi-tenant strategy: list all active tenants via the 02-tenancy
 * listActiveTenantIds() helper (system-role bypass for cross-tenant read),
 * then iterate per-tenant calling the (RLS-scoped) service functions. The
 * service functions wrap their own withTenant context.
 *
 * Concurrency: each repeating job runs at most one in-flight execution
 * (concurrency: 1). If a tick takes longer than the interval (unlikely but
 * possible at ~1000 tenants), the next tick simply queues; BullMQ does not
 * pile up duplicate ticks past one in-flight + one queued.
 *
 * Graceful shutdown: SIGINT / SIGTERM close the BullMQ Worker (drains
 * in-flight jobs), close the Redis connection, then close the pg pool.
 */

import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { config, streamLogger } from "@assessiq/core";
import { listActiveTenantIds, closePool } from "@assessiq/tenancy";
import { processBoundariesForTenant } from "@assessiq/assessment-lifecycle";
import { sweepStaleTimersForTenant } from "@assessiq/attempt-engine";

const log = streamLogger("worker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_NAME = "assessiq-cron";
const BOUNDARY_JOB_NAME = "assessment-boundary-cron";
const TIMER_SWEEP_JOB_NAME = "attempt-timer-sweep";

const BOUNDARY_INTERVAL_MS = 60_000;
const TIMER_SWEEP_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function buildRedis(): Redis {
  // BullMQ requires `maxRetriesPerRequest: null` on the shared connection —
  // a strict request retry cap can drop blocking BRPOPLPUSH commands the
  // worker relies on, surfacing as ECONNRESET-shaped errors at random.
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// ---------------------------------------------------------------------------
// Job processors
// ---------------------------------------------------------------------------

/**
 * Iterate every active tenant and call processBoundariesForTenant. Returns
 * the totals so BullMQ can include them in the job result for debugging.
 */
async function processBoundaryTick(): Promise<{
  tenants: number;
  activated: number;
  closed: number;
}> {
  const tenants = await listActiveTenantIds();
  const now = new Date();
  let activated = 0;
  let closed = 0;
  for (const tenantId of tenants) {
    try {
      const result = await processBoundariesForTenant(tenantId, now);
      activated += result.activated;
      closed += result.closed;
    } catch (err) {
      log.error(
        { err, tenantId, job: BOUNDARY_JOB_NAME },
        "boundary-cron tenant error",
      );
      // Continue with other tenants — one tenant's failure should not block
      // the cron for the rest. The error is logged for ops triage.
    }
  }
  if (activated + closed > 0) {
    log.info({ tenants: tenants.length, activated, closed }, "boundary-cron tick");
  }
  return { tenants: tenants.length, activated, closed };
}

async function processTimerSweepTick(): Promise<{
  tenants: number;
  autoSubmitted: number;
}> {
  const tenants = await listActiveTenantIds();
  let autoSubmitted = 0;
  for (const tenantId of tenants) {
    try {
      const result = await sweepStaleTimersForTenant(tenantId);
      autoSubmitted += result.autoSubmitted;
    } catch (err) {
      log.error(
        { err, tenantId, job: TIMER_SWEEP_JOB_NAME },
        "timer-sweep tenant error",
      );
    }
  }
  if (autoSubmitted > 0) {
    log.info({ tenants: tenants.length, autoSubmitted }, "timer-sweep tick");
  }
  return { tenants: tenants.length, autoSubmitted };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  log.info(
    {
      queue: QUEUE_NAME,
      boundary_interval_ms: BOUNDARY_INTERVAL_MS,
      timer_sweep_interval_ms: TIMER_SWEEP_INTERVAL_MS,
    },
    "assessiq-worker starting",
  );

  const redis = buildRedis();

  // Producer: schedules the two repeating jobs. BullMQ deduplicates on
  // jobId per-tick; the `every` repeat option drives the cadence.
  const queue = new Queue(QUEUE_NAME, { connection: redis });

  // Drain any prior repeatables so interval changes between deploys take
  // effect immediately — repeatables persist in Redis and the obvious
  // operational footgun is "I changed the interval and nothing happened
  // because the old repeatable is still ticking on the old cadence".
  const existing = await queue.getRepeatableJobs();
  for (const r of existing) {
    if (r.name === BOUNDARY_JOB_NAME || r.name === TIMER_SWEEP_JOB_NAME) {
      await queue.removeRepeatableByKey(r.key);
    }
  }

  await queue.add(
    BOUNDARY_JOB_NAME,
    {},
    {
      repeat: { every: BOUNDARY_INTERVAL_MS },
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  await queue.add(
    TIMER_SWEEP_JOB_NAME,
    {},
    {
      repeat: { every: TIMER_SWEEP_INTERVAL_MS },
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );

  // Consumer: processes any job that lands on the queue. Concurrency 1 — we
  // never want two boundary ticks running simultaneously (would race on the
  // bulk UPDATE) or two timer sweeps (same reason).
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case BOUNDARY_JOB_NAME:
          return processBoundaryTick();
        case TIMER_SWEEP_JOB_NAME:
          return processTimerSweepTick();
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    { connection: redis, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    log.error({ err, jobName: job?.name, jobId: job?.id }, "worker job failed");
  });

  log.info("assessiq-worker ready");

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "assessiq-worker shutting down");
    try {
      await worker.close();
      await queue.close();
      await redis.quit();
      await closePool();
    } catch (err) {
      log.error({ err }, "shutdown error");
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// CLI entrypoint — same pattern as apps/api/src/server.ts.
const isCliEntry =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isCliEntry) {
  start().catch((err: unknown) => {
    log.error({ err }, "assessiq-worker boot failed");
    process.exit(1);
  });
}
