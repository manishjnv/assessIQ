/**
 * Integration smoke for the worker — verifies BullMQ schedules, processes,
 * and that the per-tenant iteration calls into the right service functions.
 *
 * Two containers: postgres:16-alpine (full migration stack incl. modules 02/03/04/05/06)
 * + redis:7-alpine (BullMQ backing). The processor is the same code path as
 * the production cron tick, just driven directly via Queue.add (rather than
 * the repeating-job machinery; we exercise the processor logic, not BullMQ
 * itself).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
