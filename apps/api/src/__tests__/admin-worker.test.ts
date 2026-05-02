/**
 * Integration tests for admin-worker routes.
 *
 * Testcontainer setup mirrors worker.test.ts (redis:7-alpine). No postgres
 * container needed — the route module only touches BullMQ/Redis.
 *
 * Auth is stubbed (empty preHandler array) — admin auth integration is
 * exercised in 01-auth's own tests.
 *
 * Queue injection: each `buildTestApp` call receives a pre-built Queue pointed
 * at the test container. This sidesteps the module-init problem where
 * config.REDIS_URL is frozen before testcontainer startup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import Fastify from 'fastify';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { registerAdminWorkerRoutes } from '../routes/admin-worker.js';

let redisContainer: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const redisPort = redisContainer.getMappedPort(6379);
  const redisHost = redisContainer.getHost();
  redisUrl = `redis://${redisHost}:${redisPort}`;
}, 60_000);

afterAll(async () => {
  if (redisContainer !== undefined) await redisContainer.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Isolated Redis + Queue for a single test. Each test gets its own queue name
 * (suffixed with a uuid) so tests don't pollute each other's job lists. */
function makeQueuePair(suffix?: string): { redis: Redis; queue: Queue } {
  const queueName = suffix !== undefined ? `assessiq-cron-${suffix}` : 'assessiq-cron';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue(queueName, { connection: redis });
  return { redis, queue };
}

/** Build a minimal Fastify app with admin-worker routes, injecting the given
 * Queue so no module-level singleton is created. */
async function buildTestApp(queue: Queue) {
  const app = Fastify({ logger: false });
  await registerAdminWorkerRoutes(app, { adminOnly: [], queue });
  await app.ready();
  return app;
}

/** Poll queue.getJobCounts('failed') until count >= min, or throw on timeout. */
async function waitForFailedCount(
  queue: Queue,
  min: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts('failed');
    if ((counts['failed'] ?? 0) >= min) return;
    await new Promise<void>((res) => setTimeout(res, 150));
  }
  throw new Error(`Timed out waiting for failed count >= ${min}`);
}

/** Poll queue.getJobCounts('completed') until count >= min, or throw. */
async function waitForCompletedCount(
  queue: Queue,
  min: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts('completed');
    if ((counts['completed'] ?? 0) >= min) return;
    await new Promise<void>((res) => setTimeout(res, 150));
  }
  throw new Error(`Timed out waiting for completed count >= ${min}`);
}

// ---------------------------------------------------------------------------
// Test 1 — Stats endpoint returns current queue counts + caching
// ---------------------------------------------------------------------------

describe('GET /api/admin/worker/stats', () => {
  it(
    'returns shaped counts and caches on the second call within 5s',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const { redis, queue } = makeQueuePair(suffix);
      const app = await buildTestApp(queue);

      try {
        // Add a job so the queue has something in it.
        await queue.add('assessment-boundary-cron', { _test: true });

        // First call — must be a cache miss.
        const res1 = await app.inject({ method: 'GET', url: '/api/admin/worker/stats' });
        expect(res1.statusCode).toBe(200);
        const body1 = res1.json<{
          queue: string;
          fetched_at: string;
          cached: boolean;
          counts: Record<string, number>;
        }>();

        expect(body1.queue).toBe(`assessiq-cron-${suffix}`);
        expect(typeof body1.fetched_at).toBe('string');
        expect(body1.cached).toBe(false);
        expect(typeof body1.counts['waiting']).toBe('number');
        expect(typeof body1.counts['active']).toBe('number');
        expect(typeof body1.counts['delayed']).toBe('number');
        expect(typeof body1.counts['completed']).toBe('number');
        expect(typeof body1.counts['failed']).toBe('number');

        // Second call within 5s — must be a cache hit.
        const res2 = await app.inject({ method: 'GET', url: '/api/admin/worker/stats' });
        expect(res2.statusCode).toBe(200);
        expect(res2.json<{ cached: boolean }>().cached).toBe(true);
      } finally {
        await app.close();
        await queue.close();
        await redis.quit();
      }
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Test 2 — Failed-job inspection redacts sensitive payload keys
// ---------------------------------------------------------------------------

describe('GET /api/admin/worker/failed', () => {
  it(
    'redacts password and token but preserves tenant_id and some_field',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const { redis, queue } = makeQueuePair(suffix);
      const app = await buildTestApp(queue);

      // Worker that always throws → job lands in failed state.
      const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      const worker = new Worker(
        `assessiq-cron-${suffix}`,
        async () => { throw new Error('forced failure'); },
        { connection: workerRedis, concurrency: 1 },
      );

      try {
        const testJobName = `test-fail-${randomUUID().slice(0, 8)}`;
        await queue.add(testJobName, {
          password: 'super-secret',
          token: 'abc-tok',
          tenant_id: 't-safe-001',
          some_field: 'should-survive',
        });

        await waitForFailedCount(queue, 1);

        const res = await app.inject({ method: 'GET', url: '/api/admin/worker/failed' });
        expect(res.statusCode).toBe(200);

        const body = res.json<{
          queue: string;
          jobs: Array<{ name: string; data: Record<string, unknown> }>;
        }>();

        expect(body.queue).toBe(`assessiq-cron-${suffix}`);

        const job = body.jobs.find((j) => j.name === testJobName);
        expect(job).toBeDefined();

        // Sensitive keys must be redacted.
        expect(job!.data['password']).toBe('[Redacted]');
        expect(job!.data['token']).toBe('[Redacted]');

        // Non-sensitive keys must pass through intact.
        expect(job!.data['tenant_id']).toBe('t-safe-001');
        expect(job!.data['some_field']).toBe('should-survive');
      } finally {
        await worker.close();
        await app.close();
        await queue.close();
        await redis.quit();
        await workerRedis.quit();
      }
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Test 3a — Retry returns 200 on a genuinely failed job
// ---------------------------------------------------------------------------

describe('POST /api/admin/worker/failed/:id/retry', () => {
  it(
    'returns 200 when retrying a failed job',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const { redis, queue } = makeQueuePair(suffix);
      const app = await buildTestApp(queue);

      const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      const worker = new Worker(
        `assessiq-cron-${suffix}`,
        async () => { throw new Error('forced failure for retry test'); },
        { connection: workerRedis, concurrency: 1 },
      );

      try {
        const testJobName = `test-retry-${randomUUID().slice(0, 8)}`;
        // BullMQ will retry by default; set attempts=1 so it goes straight to failed.
        await queue.add(testJobName, {}, { attempts: 1 });
        await waitForFailedCount(queue, 1);

        const failedJobs = await queue.getJobs(['failed'], 0, 49);
        const target = failedJobs.find((j) => j.name === testJobName);
        expect(target).toBeDefined();

        const res = await app.inject({
          method: 'POST',
          url: `/api/admin/worker/failed/${target!.id}/retry`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ id: string; retried: boolean }>();
        expect(body.retried).toBe(true);
        expect(body.id).toBe(target!.id);
      } finally {
        await worker.close();
        await app.close();
        await queue.close();
        await redis.quit();
        await workerRedis.quit();
      }
    },
    20_000,
  );

  // ---------------------------------------------------------------------------
  // Test 3b — Retry returns 409 on non-failed (completed) job
  // ---------------------------------------------------------------------------

  it(
    'returns 409 when retrying a job that is not in failed state',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const { redis, queue } = makeQueuePair(suffix);
      const app = await buildTestApp(queue);

      const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      // Worker that succeeds — job ends up in completed state (or removed if
      // removeOnComplete is set; add without it so we can find the id).
      let completedJobId: string | undefined;
      const worker = new Worker(
        `assessiq-cron-${suffix}`,
        async (job: Job) => { completedJobId = job.id; },
        { connection: workerRedis, concurrency: 1 },
      );

      try {
        const testJobName = `test-409-${randomUUID().slice(0, 8)}`;
        await queue.add(testJobName, {}, { removeOnComplete: false });
        await waitForCompletedCount(queue, 1);

        expect(completedJobId).toBeDefined();

        const res = await app.inject({
          method: 'POST',
          url: `/api/admin/worker/failed/${completedJobId}/retry`,
        });
        expect(res.statusCode).toBe(409);
        const body = res.json<{ error: { code: string } }>();
        expect(body.error.code).toBe('INVALID_STATE');
      } finally {
        await worker.close();
        await app.close();
        await queue.close();
        await redis.quit();
        await workerRedis.quit();
      }
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Test 4 — Retry returns 404 on missing job id
// ---------------------------------------------------------------------------

describe('POST /api/admin/worker/failed/:id/retry — 404', () => {
  it(
    'returns 404 when the job id does not exist',
    async () => {
      const suffix = randomUUID().slice(0, 8);
      const { redis, queue } = makeQueuePair(suffix);
      const app = await buildTestApp(queue);

      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/admin/worker/failed/nonexistent-${randomUUID()}/retry`,
        });
        expect(res.statusCode).toBe(404);
        const body = res.json<{ error: { code: string; message: string } }>();
        expect(body.error.code).toBe('NOT_FOUND');
        expect(typeof body.error.message).toBe('string');
      } finally {
        await app.close();
        await queue.close();
        await redis.quit();
      }
    },
    10_000,
  );
});
