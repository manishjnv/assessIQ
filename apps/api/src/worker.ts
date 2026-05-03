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

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { config, streamLogger } from "@assessiq/core";
import { listActiveTenantIds, closePool } from "@assessiq/tenancy";
import { processBoundariesForTenant } from "@assessiq/assessment-lifecycle";
import { sweepStaleTimersForTenant } from "@assessiq/attempt-engine";
import {
  processEmailSendJob,
  type EmailSendJobData,
  processWebhookDeliverJob,
  type WebhookDeliverJobData,
  webhookBackoffStrategy,
} from "@assessiq/notifications";
import {
  processRefreshMvJob,
  ANALYTICS_REFRESH_MV_JOB_NAME,
} from "@assessiq/analytics";

const log = streamLogger("worker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_NAME = "assessiq-cron";
const BOUNDARY_JOB_NAME = "assessment-boundary-cron";
const TIMER_SWEEP_JOB_NAME = "attempt-timer-sweep";
const EMAIL_SEND_JOB_NAME = "email.send";
const WEBHOOK_DELIVER_JOB_NAME = "webhook.deliver";
// Phase 3 G3.C — nightly MV refresh at 02:00 UTC
const MV_REFRESH_JOB_NAME = ANALYTICS_REFRESH_MV_JOB_NAME; // 'analytics:refresh_mv'
// 02:00 UTC daily, expressed as a cron string (BullMQ uses cron-parser)
const MV_REFRESH_CRON = "0 2 * * *";

const BOUNDARY_INTERVAL_MS = 60_000;
const TIMER_SWEEP_INTERVAL_MS = 30_000;

/**
 * Per-job retry policy.
 *
 * Cron jobs are idempotent at the SQL level (bulk UPDATE WHERE status IN (...)
 * — re-running on already-transitioned rows is a no-op), so retries are safe.
 *
 * email.send: 5 attempts, exponential base 5s (SMTP transient retries, not a
 *   published external contract — exponential is fine here).
 *
 * webhook.deliver: 5 attempts, custom backoff via WEBHOOK_RETRY_DELAYS_MS
 *   literal schedule [1m, 5m, 30m, 2h, 12h] per P3.D12. This IS a published
 *   API contract per docs/03-api-contract.md:324 — must remain literal.
 *   Registered as the 'webhook-literal' custom backoff strategy below.
 */
export const JOB_RETRY_POLICY: Record<
  string,
  | { attempts: number; backoff: { type: "exponential"; delay: number } }
  | { attempts: number; backoff: { type: "custom" } }
> = {
  [BOUNDARY_JOB_NAME]: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
  [TIMER_SWEEP_JOB_NAME]: { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
  [EMAIL_SEND_JOB_NAME]: { attempts: 5, backoff: { type: "exponential", delay: 5000 } },
  [WEBHOOK_DELIVER_JOB_NAME]: { attempts: 5, backoff: { type: "custom" } },
  // analytics:refresh_mv — 3 attempts, exponential base 60s.
  // CONCURRENTLY refresh is idempotent; retry on transient DB errors is safe.
  [MV_REFRESH_JOB_NAME]: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
};

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
// Logging wrapper
// ---------------------------------------------------------------------------

/**
 * Result shape emitted in the success log. Contains only integer counts —
 * never raw row data — so the redaction layer at pino is purely defence-in-depth.
 *
 * `tenant_id` is null at this wrapper level because boundary-cron and
 * timer-sweep iterate ALL tenants in a single tick rather than targeting one.
 * Future per-tenant jobs will populate this field.
 */
type JobResult = Record<string, number>;

/**
 * Wraps a job processor `fn` with structured start/end log lines and
 * rethrows on failure so BullMQ's retry/failed-job machinery still fires.
 *
 * Emits exactly two lines per execution:
 *   - worker.job.start  (level=info)  immediately before fn() is called
 *   - worker.job.finished (level=info|error) after fn() resolves or throws
 */
export async function runJobWithLogging(
  job: Job,
  fn: () => Promise<JobResult>,
): Promise<JobResult> {
  const startedAt = new Date().toISOString();

  log.info({
    msg: "worker.job.start",
    job_id: job.id,
    job_name: job.name,
    queue: QUEUE_NAME,
    started_at: startedAt,
    // tenant_id is null at the wrapper level — these jobs iterate all tenants.
    // Future per-tenant jobs will populate this field.
    tenant_id: null,
    retry_count: job.attemptsMade,
  });

  const startMs = Date.now();

  try {
    const result = await fn();
    const finishedAt = new Date().toISOString();

    log.info({
      msg: "worker.job.finished",
      job_id: job.id,
      job_name: job.name,
      queue: QUEUE_NAME,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - startMs,
      status: "succeeded",
      // tenant_id: null — see note on start line above.
      tenant_id: null,
      retry_count: job.attemptsMade,
      result,
    });

    return result;
  } catch (err: unknown) {
    const finishedAt = new Date().toISOString();
    const error = err instanceof Error ? err : new Error(String(err));

    log.error({
      msg: "worker.job.finished",
      job_id: job.id,
      job_name: job.name,
      queue: QUEUE_NAME,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - startMs,
      status: "failed",
      // tenant_id: null — see note on start line above.
      tenant_id: null,
      retry_count: job.attemptsMade,
      error_class: error.constructor.name,
      error_message: error.message,
      stack: error.stack,
    });

    // Rethrow so BullMQ's retry and failed-job machinery still fires.
    throw err;
  }
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
    if (r.name === BOUNDARY_JOB_NAME || r.name === TIMER_SWEEP_JOB_NAME || r.name === MV_REFRESH_JOB_NAME) {
      await queue.removeRepeatableByKey(r.key);
    }
  }

  // Both keys are guaranteed present in JOB_RETRY_POLICY — the Record type
  // with noUncheckedIndexedAccess makes them T|undefined at the call site, so
  // we assert non-null here. A missing entry is a programmer error caught at
  // startup, not a runtime edge case.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const boundaryPolicy = JOB_RETRY_POLICY[BOUNDARY_JOB_NAME]!;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const timerSweepPolicy = JOB_RETRY_POLICY[TIMER_SWEEP_JOB_NAME]!;

  await queue.add(
    BOUNDARY_JOB_NAME,
    {},
    {
      repeat: { every: BOUNDARY_INTERVAL_MS },
      attempts: boundaryPolicy.attempts,
      backoff: boundaryPolicy.backoff,
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );
  await queue.add(
    TIMER_SWEEP_JOB_NAME,
    {},
    {
      repeat: { every: TIMER_SWEEP_INTERVAL_MS },
      attempts: timerSweepPolicy.attempts,
      backoff: timerSweepPolicy.backoff,
      removeOnComplete: 50,
      removeOnFail: 50,
    },
  );

  // Phase 3 G3.C — nightly MV refresh at 02:00 UTC.
  // REFRESH MATERIALIZED VIEW CONCURRENTLY is safe to run while readers are
  // active (needs the UNIQUE index on attempt_summary_mv which 0060 creates).
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const mvRefreshPolicy = JOB_RETRY_POLICY[MV_REFRESH_JOB_NAME]!;
  await queue.add(
    MV_REFRESH_JOB_NAME,
    {},
    {
      repeat: { pattern: MV_REFRESH_CRON },
      attempts: mvRefreshPolicy.attempts,
      backoff: mvRefreshPolicy.backoff,
      removeOnComplete: 10,
      removeOnFail: 20,
    },
  );

  // Consumer: processes any job that lands on the queue.
  // Concurrency: cron jobs run at 1 (never two boundary/timer ticks simultaneously
  // — would race on the bulk UPDATE). Email + webhook jobs can run at higher
  // concurrency but share the same worker process for simplicity in Phase 3.
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      switch (job.name) {
        case BOUNDARY_JOB_NAME:
          return runJobWithLogging(job, processBoundaryTick);
        case TIMER_SWEEP_JOB_NAME:
          return runJobWithLogging(job, processTimerSweepTick);
        case EMAIL_SEND_JOB_NAME:
          return runJobWithLogging(job, () =>
            processEmailSendJob(job.data as EmailSendJobData).then((r) => ({
              emailLogId: r.emailLogId.length,
              status: r.status === 'sent' ? 1 : 0,
            })),
          );
        case WEBHOOK_DELIVER_JOB_NAME:
          return runJobWithLogging(job, () =>
            processWebhookDeliverJob(job as Job<WebhookDeliverJobData>).then((r) => ({
              deliveryId: r.deliveryId.length,
              status: r.httpStatus ?? 0,
            })),
          );
        case MV_REFRESH_JOB_NAME:
          return runJobWithLogging(job, processRefreshMvJob);
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      connection: redis,
      concurrency: 1,
      settings: {
        // Custom backoff strategy for webhook.deliver — literal [1m,5m,30m,2h,12h]
        // per P3.D12. NOT exponential. This is a published API contract.
        backoffStrategy: webhookBackoffStrategy,
      },
    },
  );

  // Fires only when ALL retries are exhausted — distinct from the per-retry
  // failure log emitted by runJobWithLogging which fires on every failed attempt.
  worker.on("failed", (job, err) => {
    log.error({
      msg: "worker.job.failed.permanent",
      jobName: job?.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err,
    });
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
