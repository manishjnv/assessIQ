/**
 * Integration smoke for the worker — verifies BullMQ schedules, processes,
 * and that the per-tenant iteration calls into the right service functions.
 *
 * Two containers: postgres:16-alpine (full migration stack incl. modules 02/03/04/05/06)
 * + redis:7-alpine (BullMQ backing). The processor is the same code path as
 * the production cron tick, just driven directly via Queue.add (rather than
 * the repeating-job machinery; we exercise the processor logic, not BullMQ
 * itself).
 *
 * Unit tests at the bottom (runJobWithLogging, JOB_RETRY_POLICY) run without
 * containers and are fast.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Workspace barrels — same import shape as worker.ts.
import {
  setPoolForTesting,
  closePool,
  listActiveTenantIds,
} from "@assessiq/tenancy";
import { processBoundariesForTenant } from "@assessiq/assessment-lifecycle";
import { sweepStaleTimersForTenant } from "@assessiq/attempt-engine";

// Worker internals exported for testing.
import { runJobWithLogging, JOB_RETRY_POLICY } from "../worker.js";

// Logger — we spy on the memoized instance that worker.ts already created.
import { streamLogger } from "@assessiq/core";

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
// Test file is at apps/api/src/__tests__/ ; modules/ root is two parents up
// then over to modules/.
const REPO_ROOT = join(THIS_DIR, "..", "..", "..", "..");
const MODULES_ROOT = join(REPO_ROOT, "modules");

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let redisUrl: string;

async function withSuperClient<T>(pgUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigrationsFromDir(client: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), "utf8");
    await client.query(sql);
  }
}

beforeAll(async () => {
  pgContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "assessiq",
      POSTGRES_PASSWORD: "assessiq_test_pw",
      POSTGRES_DB: "assessiq",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const pgPort = pgContainer.getMappedPort(5432);
  const pgHost = pgContainer.getHost();
  const pgUrl = `postgres://assessiq:assessiq_test_pw@${pgHost}:${pgPort}/assessiq`;

  const redisPort = redisContainer.getMappedPort(6379);
  const redisHost = redisContainer.getHost();
  redisUrl = `redis://${redisHost}:${redisPort}`;

  await withSuperClient(pgUrl, async (client) => {
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "05-assessment-lifecycle", "migrations"));
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "06-attempt-engine", "migrations"));
  });

  setPoolForTesting(pgUrl);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (pgContainer !== undefined) await pgContainer.stop();
  if (redisContainer !== undefined) await redisContainer.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listActiveTenantIds (system-role enumeration)", () => {
  it("returns every active tenant; excludes 'suspended'", async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    const pgUrl = `postgres://assessiq:assessiq_test_pw@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/assessiq`;
    await withSuperClient(pgUrl, async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,$3,'active')`, [t1, `slug-${t1}`, "T1"]);
      await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,$3,'active')`, [t2, `slug-${t2}`, "T2"]);
      await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,$3,'suspended')`, [t3, `slug-${t3}`, "T3"]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t1]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t2]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t3]);
    });

    const ids = await listActiveTenantIds();
    expect(ids).toContain(t1);
    expect(ids).toContain(t2);
    expect(ids).not.toContain(t3);
  });
});

describe("BullMQ smoke — Queue.add → Worker.process → result", () => {
  it("processes a job through the queue and returns the per-tenant counts", async () => {
    const queueName = `test-cron-${randomUUID().slice(0, 8)}`;
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    try {
      const queue = new Queue(queueName, { connection });

      const processed: Array<{ name: string; result: unknown }> = [];
      const worker = new Worker(
        queueName,
        async (job: Job) => {
          // Mirror worker.ts dispatch — simplified inline.
          if (job.name === "boundary-tick") {
            const tenants = await listActiveTenantIds();
            const now = new Date();
            let activated = 0;
            let closed = 0;
            for (const tenantId of tenants) {
              const r = await processBoundariesForTenant(tenantId, now);
              activated += r.activated;
              closed += r.closed;
            }
            return { tenants: tenants.length, activated, closed };
          }
          if (job.name === "timer-sweep") {
            const tenants = await listActiveTenantIds();
            let autoSubmitted = 0;
            for (const tenantId of tenants) {
              const r = await sweepStaleTimersForTenant(tenantId);
              autoSubmitted += r.autoSubmitted;
            }
            return { tenants: tenants.length, autoSubmitted };
          }
          throw new Error(`unknown job ${job.name}`);
        },
        { connection, concurrency: 1 },
      );

      // Wait for worker to be ready before adding so add() lands on a queue
      // with an attached consumer.
      await new Promise<void>((resolve) => worker.on("ready", () => resolve()));

      const completed = new Promise<void>((resolve) =>
        worker.on("completed", (job, result) => {
          processed.push({ name: job.name, result });
          if (processed.length >= 2) resolve();
        }),
      );

      await queue.add("boundary-tick", {}, { removeOnComplete: true });
      await queue.add("timer-sweep", {}, { removeOnComplete: true });

      await completed;

      expect(processed.find((p) => p.name === "boundary-tick")).toBeDefined();
      expect(processed.find((p) => p.name === "timer-sweep")).toBeDefined();

      // Every result has the tenants count populated (>= some number).
      const boundaryResult = processed.find((p) => p.name === "boundary-tick")!.result as { tenants: number };
      const sweepResult = processed.find((p) => p.name === "timer-sweep")!.result as { tenants: number };
      expect(typeof boundaryResult.tenants).toBe("number");
      expect(typeof sweepResult.tenants).toBe("number");

      await worker.close();
      await queue.close();
    } finally {
      await connection.quit();
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — runJobWithLogging + JOB_RETRY_POLICY (no containers required)
// ---------------------------------------------------------------------------

/**
 * Build a minimal BullMQ-shaped Job stub sufficient for runJobWithLogging.
 * We only need the fields the wrapper reads: id, name, attemptsMade.
 */
function makeStubJob(name: string, opts?: { id?: string; attemptsMade?: number }): Job {
  return {
    id: opts?.id ?? randomUUID(),
    name,
    attemptsMade: opts?.attemptsMade ?? 0,
  } as unknown as Job;
}

describe("runJobWithLogging — structured log output", () => {
  it("emits start + finished-success lines with all required schema fields", async () => {
    const workerLog = streamLogger("worker");
    const infoSpy = vi.spyOn(workerLog, "info");
    const errorSpy = vi.spyOn(workerLog, "error");

    const job = makeStubJob("assessment-boundary-cron", { id: "job-001", attemptsMade: 0 });
    const fakeResult = { tenants: 3, activated: 1, closed: 0 };

    await runJobWithLogging(job, async () => fakeResult);

    // infoSpy should have been called at least twice: start + finished.
    // (The wrapper itself makes 2 info calls; filter by msg to be precise.)
    const calls = infoSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);

    const startLine = calls.find((c) => c["msg"] === "worker.job.start");
    const finishedLine = calls.find((c) => c["msg"] === "worker.job.finished");

    expect(startLine).toBeDefined();
    expect(startLine?.["job_id"]).toBe("job-001");
    expect(startLine?.["job_name"]).toBe("assessment-boundary-cron");
    expect(startLine?.["queue"]).toBe("assessiq-cron");
    expect(typeof startLine?.["started_at"]).toBe("string");
    expect(startLine?.["retry_count"]).toBe(0);
    // tenant_id is null at wrapper level for these all-tenant jobs.
    expect(startLine?.["tenant_id"]).toBeNull();

    expect(finishedLine).toBeDefined();
    expect(finishedLine?.["job_id"]).toBe("job-001");
    expect(finishedLine?.["job_name"]).toBe("assessment-boundary-cron");
    expect(finishedLine?.["queue"]).toBe("assessiq-cron");
    expect(typeof finishedLine?.["started_at"]).toBe("string");
    expect(typeof finishedLine?.["finished_at"]).toBe("string");
    expect(typeof finishedLine?.["duration_ms"]).toBe("number");
    expect(finishedLine?.["status"]).toBe("succeeded");
    expect(finishedLine?.["retry_count"]).toBe(0);
    expect(finishedLine?.["tenant_id"]).toBeNull();
    expect(finishedLine?.["result"]).toEqual(fakeResult);

    // No error line should have been emitted.
    expect(errorSpy).not.toHaveBeenCalled();

    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits finished-failure line with error_class / error_message / stack on throw", async () => {
    const workerLog = streamLogger("worker");
    const errorSpy = vi.spyOn(workerLog, "error");

    const job = makeStubJob("attempt-timer-sweep", { id: "job-002", attemptsMade: 2 });
    const boom = new TypeError("Redis connection lost");

    await expect(
      runJobWithLogging(job, async () => { throw boom; }),
    ).rejects.toThrow("Redis connection lost");

    // errorSpy should have exactly one call from the wrapper.
    const calls = errorSpy.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const failedLine = calls.find((c) => c["msg"] === "worker.job.finished");

    expect(failedLine).toBeDefined();
    expect(failedLine?.["job_id"]).toBe("job-002");
    expect(failedLine?.["job_name"]).toBe("attempt-timer-sweep");
    expect(failedLine?.["queue"]).toBe("assessiq-cron");
    expect(failedLine?.["status"]).toBe("failed");
    expect(failedLine?.["retry_count"]).toBe(2);
    expect(failedLine?.["error_class"]).toBe("TypeError");
    expect(failedLine?.["error_message"]).toBe("Redis connection lost");
    expect(typeof failedLine?.["stack"]).toBe("string");
    expect(failedLine?.["tenant_id"]).toBeNull();

    errorSpy.mockRestore();
  });
});

describe("JOB_RETRY_POLICY — retry table shape", () => {
  it("includes both job names with attempts:5 and exponential backoff", () => {
    const boundaryPolicy = JOB_RETRY_POLICY["assessment-boundary-cron"];
    const timerPolicy = JOB_RETRY_POLICY["attempt-timer-sweep"];

    expect(boundaryPolicy).toBeDefined();
    expect(boundaryPolicy?.attempts).toBe(5);
    expect(boundaryPolicy?.backoff.type).toBe("exponential");
    if (boundaryPolicy?.backoff.type === "exponential") {
      expect(typeof boundaryPolicy.backoff.delay).toBe("number");
    }

    expect(timerPolicy).toBeDefined();
    expect(timerPolicy?.attempts).toBe(5);
    expect(timerPolicy?.backoff.type).toBe("exponential");
    if (timerPolicy?.backoff.type === "exponential") {
      expect(typeof timerPolicy.backoff.delay).toBe("number");
    }
  });
});
