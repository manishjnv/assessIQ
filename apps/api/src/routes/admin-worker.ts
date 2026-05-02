/**
 * Admin routes for BullMQ worker observability.
 *
 * Three endpoints, all admin-gated:
 *   GET  /api/admin/worker/stats          — queue depth snapshot (5s TTL cache)
 *   GET  /api/admin/worker/failed         — recent failed jobs, capped at 50
 *   POST /api/admin/worker/failed/:id/retry — re-enqueue a failed job
 *
 * Tenant scoping note: queue stats are infra-global. BullMQ has no per-tenant
 * column — the assessiq-cron queue is a single queue shared by all tenants.
 * The route is admin-only and returns global counts intentionally. The two
 * current job types (assessment-boundary-cron, attempt-timer-sweep) iterate
 * over all tenants internally — they are NOT tenant-scoped at the job level, so
 * job payloads do not carry a top-level tenant_id. This is by design per the
 * Phase 1 worker architecture.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '@assessiq/core';

// ---------------------------------------------------------------------------
// Constants — mirror worker.ts without importing it (avoids pulling the worker
// boot logic into the API process).
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'assessiq-cron';

// ---------------------------------------------------------------------------
// Queue factory — builds a module-level singleton on first use. Deferred so
// that tests can inject a ready-built Queue (pointing at a test container)
// via AdminWorkerRoutesOpts.queue instead of relying on config.REDIS_URL at
// import time (which is frozen before testcontainer startup).
//
// Production path: opts.queue is undefined → _getQueue() builds once from
// config.REDIS_URL and caches the result for the lifetime of the process.
// Test path: opts.queue is provided → the module-level singleton is never
// created, avoiding the cold config read entirely.
// ---------------------------------------------------------------------------

let _defaultQueue: Queue | null = null;

function _getDefaultQueue(): Queue {
  if (_defaultQueue === null) {
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _defaultQueue = new Queue(QUEUE_NAME, { connection: redis });
  }
  return _defaultQueue;
}

// ---------------------------------------------------------------------------
// 5-second in-process TTL cache for /stats.
// Simple closure — no new dep, no Redis round-trip on every dashboard poll.
// ---------------------------------------------------------------------------

interface StatsCacheEntry {
  fetched: number; // Date.now() at fetch time
  data: StatsPayload;
}

interface StatsPayload {
  queue: string;
  fetched_at: string;
  cached: boolean;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  };
}

const STATS_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Redaction helper.
//
// Mirrors LOG_REDACT_PATHS from @assessiq/core/log-redact.ts and
// BLOCKED_KEY_SUBSTRINGS from apps/web/src/lib/logger.ts. Does NOT import
// either — we copy the key list here so this file stays self-contained and
// the FE logger module is never pulled into the API bundle.
//
// Depth cap at 3: cron job payloads are shallow by design; deeper recursion
// is a footgun for malformed payloads.
// ---------------------------------------------------------------------------

const REDACTED_KEY_SUBSTRINGS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'recovery',
  'cookie',
  'authorization',
  'auth',
  'session',
  'aiq_sess',     // literal cookie name; not caught by 'session' substring
  'id_token',
  'refresh_token',
  'client_secret',
  'totp',
  'answer',
  'candidate',    // covers candidateText / candidate_text / etc.
];

function redactPayload(obj: unknown, depth = 0): unknown {
  if (depth > 3) return obj;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactPayload(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const keyLower = key.toLowerCase();
    const isSensitive = REDACTED_KEY_SUBSTRINGS.some((sub) => keyLower.includes(sub));
    result[key] = isSensitive ? '[Redacted]' : redactPayload(value, depth + 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route shapes
// ---------------------------------------------------------------------------

type FastifyHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

interface AdminWorkerRoutesOpts {
  // Injected admin-only auth chain — same DI shape as registerQuestionBankRoutes.
  adminOnly: FastifyHook[];
  // Optional pre-built Queue for testing against a testcontainer. When absent,
  // the module builds its own from config.REDIS_URL on first request.
  queue?: Queue;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminWorkerRoutes(
  app: FastifyInstance,
  { adminOnly, queue: injectedQueue }: AdminWorkerRoutesOpts,
): Promise<void> {
  // Resolve queue once per registration — either the injected test instance
  // or the lazy module-level default built from config.REDIS_URL.
  const q = injectedQueue ?? _getDefaultQueue();

  // Per-registration stats cache. When a Queue is injected (tests), each
  // test app gets its own independent cache — no cross-test bleed.
  let localStatsCache: StatsCacheEntry | null = null;

  // GET /api/admin/worker/stats — queue depth snapshot with 5s TTL cache
  app.get(
    '/api/admin/worker/stats',
    { preHandler: adminOnly },
    async (): Promise<StatsPayload> => {
      const now = Date.now();
      if (localStatsCache !== null && now - localStatsCache.fetched < STATS_TTL_MS) {
        // Return a copy with cached: true so the caller can see it was a hit.
        return { ...localStatsCache.data, cached: true };
      }

      // Single round-trip — getJobCounts batches all state buckets in one call.
      const counts = await q.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      );

      const payload: StatsPayload = {
        queue: q.name,
        fetched_at: new Date(now).toISOString(),
        cached: false,
        counts: {
          waiting: counts['waiting'] ?? 0,
          active: counts['active'] ?? 0,
          delayed: counts['delayed'] ?? 0,
          completed: counts['completed'] ?? 0,
          failed: counts['failed'] ?? 0,
        },
      };

      localStatsCache = { fetched: now, data: payload };
      return payload;
    },
  );

  // GET /api/admin/worker/failed — recent failed jobs, capped at 50
  //
  // Tenancy forward-looking note: the assessiq-cron queue is shared across all
  // tenants. Today's two jobs (assessment-boundary-cron, attempt-timer-sweep)
  // iterate all tenants internally and carry NO tenant_id at the job-data level,
  // so this endpoint reveals no cross-tenant data. When a future job ships that
  // DOES carry a tenant_id payload (e.g. a per-tenant export), this handler
  // MUST gain a `WHERE job.data.tenant_id = req.session.tenantId` filter on
  // those job names. Keep this comment in sync with `apps/api/src/worker.ts`'s
  // JOB_RETRY_POLICY table — every entry there should be reviewed for tenancy
  // shape before the table grows.
  app.get(
    '/api/admin/worker/failed',
    { preHandler: adminOnly },
    async () => {
      const jobs = await q.getJobs(['failed'], 0, 49);
      const now = new Date().toISOString();

      return {
        queue: q.name,
        fetched_at: now,
        jobs: jobs.map((job) => {
          // Stack is an array of strings; take the last entry and truncate to
          // 1024 chars — a full stack over the wire can be 100KB+.
          const lastStack =
            Array.isArray(job.stacktrace) && job.stacktrace.length > 0
              ? job.stacktrace[job.stacktrace.length - 1]!.slice(-1024)
              : null;

          return {
            id: job.id ?? null,
            name: job.name,
            attempts_made: job.attemptsMade,
            failed_reason: job.failedReason ?? null,
            stacktrace_tail: lastStack,
            data: redactPayload(job.data),
            timestamp: job.timestamp,
            processed_on: job.processedOn ?? null,
            finished_on: job.finishedOn ?? null,
          };
        }),
      };
    },
  );

  // POST /api/admin/worker/failed/:id/retry — re-enqueue a failed job
  app.post(
    '/api/admin/worker/failed/:id/retry',
    { preHandler: adminOnly },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const job = await q.getJob(id);

      if (job === undefined) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'job not found' },
        });
      }

      // Job.retry() throws if the job is not in failed state. Catch and map
      // to 409 so the caller gets a meaningful status rather than a 500.
      try {
        await job.retry('failed');
      } catch {
        return reply.code(409).send({
          error: { code: 'INVALID_STATE', message: 'job is not in failed state' },
        });
      }

      return reply.code(200).send({ id, retried: true });
    },
  );
}
