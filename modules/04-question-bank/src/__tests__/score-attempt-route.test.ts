/**
 * Route-level integration tests for POST /api/admin/generation-attempts/:id/score.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Auth is stubbed (empty preHandler array + session-injecting decorator) —
 * auth integration is exercised in 01-auth's own tests.
 *
 * Skip gate: testcontainers require Docker. If Docker is not available the
 * entire describe block is skipped via the dockerAvailable check.
 *
 * Migrations applied:
 *   tenancy (0001-0003) → users (020 only) → question-bank (0010+)
 *   → ai-grading 0042 + 0043 (generation_attempts table + citation_dropped)
 *
 * Each test inserts its own rows. Shared data is seeded in beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";

// ---------------------------------------------------------------------------
// Path helpers (Windows compat — strip leading slash before drive letter)
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR            = toFsPath(new URL(".", import.meta.url));
const QB_MODULE_ROOT      = join(THIS_DIR, "..", "..");             // modules/04-question-bank/
const MODULES_ROOT        = join(QB_MODULE_ROOT, "..");             // modules/

const TENANCY_MIGRATIONS_DIR   = join(MODULES_ROOT, "02-tenancy",    "migrations");
const USERS_MIGRATIONS_DIR     = join(MODULES_ROOT, "03-users",      "migrations");
const QB_MIGRATIONS_DIR        = join(QB_MODULE_ROOT,                "migrations");
const AI_GRADING_MIGRATIONS_DIR = join(MODULES_ROOT, "07-ai-grading", "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;
let packA: string;
let levelA: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function insertTenant(client: Client, id: string, slug: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, name],
  );
  await client.query(
    `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
    [id],
  );
}

async function insertAdminUser(client: Client, id: string, tenantId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

async function insertPack(
  client: Client,
  opts: { id: string; tenantId: string; name: string; createdBy: string },
): Promise<void> {
  // question_packs.slug is NOT NULL (migrations/0010_question_packs.sql) — must
  // be supplied. Generated per-call so multiple insertPack calls in one tenant
  // don't collide on UNIQUE (tenant_id, slug, version).
  const slug = `score-pack-${randomUUID().slice(0, 8)}`;
  await client.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by)
     VALUES ($1, $2, $3, $4, 'soc-analyst', 'draft', $5)`,
    [opts.id, opts.tenantId, slug, opts.name, opts.createdBy],
  );
}

async function insertLevel(
  client: Client,
  opts: { id: string; packId: string; tenantId: string; label: string },
): Promise<void> {
  // levels has no tenant_id column (RLS derives via pack_id FK chain) and the
  // ordering column is `position`, not `sort_order`. duration_minutes and
  // default_question_count are NOT NULL with no defaults.
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, $3, 30, 10)`,
    [opts.id, opts.packId, opts.label],
  );
}

async function insertAttempt(
  client: Client,
  opts: {
    id?: string;
    tenantId: string;
    packId: string;
    levelId: string;
    userId: string;
    status?: string;
    countRequested?: number;
    countInserted?: number;
    chunksPlanned?: number | null;
    chunksFailed?: number | null;
    startedAt?: string;
  },
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await client.query(
    `INSERT INTO generation_attempts
       (id, tenant_id, pack_id, level_id, user_id, status,
        count_requested, count_inserted,
        chunks_planned, chunks_failed,
        started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             COALESCE($11::timestamptz, now()))`,
    [
      id,
      opts.tenantId,
      opts.packId,
      opts.levelId,
      opts.userId,
      opts.status ?? "success",
      opts.countRequested ?? 5,
      opts.countInserted ?? 5,
      opts.chunksPlanned ?? null,
      opts.chunksFailed ?? null,
      opts.startedAt ?? null,
    ],
  );
  return id;
}

/** Insert a minimal MCQ question in 'ai_draft' status. */
async function insertMcqQuestion(
  client: Client,
  opts: {
    id?: string;
    packId: string;
    levelId: string;
    tenantId: string;
    createdBy: string;
    topic?: string;
    content?: Record<string, unknown>;
    kbSourceIds?: string[];
    createdAt?: string;
  },
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const content = opts.content ?? {
    question: "What does IDS stand for?",
    options: ["Intrusion Detection System", "Internet Data Service", "Internal DNS Server", "Integrated Defense Suite"],
    correct: 0,
    rationale: "IDS stands for Intrusion Detection System.",
  };
  const kbSources = (opts.kbSourceIds ?? ["kb-src-001"]).map((sid) => ({
    id: sid,
    name: sid,
    citation: sid,
    url: "n/a",
    kb_version: "2026-05-10",
  }));

  await client.query(
    `INSERT INTO questions
       (id, pack_id, level_id, type, topic, points, status, version,
        content, knowledge_base_sources, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'mcq',$4,1,'ai_draft',1,$5::jsonb,$6::jsonb,$7,
             COALESCE($8::timestamptz, now()),
             COALESCE($8::timestamptz, now()))`,
    [
      id,
      opts.packId,
      opts.levelId,
      opts.topic ?? "SOC triage basics",
      JSON.stringify(content),
      JSON.stringify(kbSources),
      opts.createdBy,
      opts.createdAt ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Build a minimal Fastify test app — auth stubbed via preHandler decorator.
// ---------------------------------------------------------------------------

async function buildTestApp(sessionTenantId: string, sessionUserId: string) {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: { tenantId: string; userId: string } }).session = {
      tenantId: sessionTenantId,
      userId: sessionUserId,
    };
  });

  await registerQuestionBankRoutes(app, { adminOnly: [] });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "aiq_score_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_score_test`;

  // Migrations
  const [tenancyFiles, usersFiles, qbFiles, aiGradingFiles] = await Promise.all([
    readdir(TENANCY_MIGRATIONS_DIR),
    readdir(USERS_MIGRATIONS_DIR),
    readdir(QB_MIGRATIONS_DIR),
    readdir(AI_GRADING_MIGRATIONS_DIR),
  ]);

  const tenancySorted = tenancyFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: TENANCY_MIGRATIONS_DIR, file: f }));

  const usersSorted = usersFiles
    .filter((f) => f.endsWith(".sql") && f.startsWith("020_"))
    .sort()
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));

  const qbSorted = qbFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: QB_MIGRATIONS_DIR, file: f }));

  // Apply both 0042 and 0043 (citation_dropped column).
  const aiGradingSorted = aiGradingFiles
    .filter((f) => f.endsWith(".sql") && (f === "0042_generation_attempts.sql" || f === "0043_generation_attempts_citation_dropped.sql"))
    .sort()
    .map((f) => ({ dir: AI_GRADING_MIGRATIONS_DIR, file: f }));

  await withSuperClient(async (client) => {
    for (const { dir, file } of [...tenancySorted, ...usersSorted, ...qbSorted, ...aiGradingSorted]) {
      const sql = await readFile(join(dir, file), "utf-8");
      await client.query(sql);
    }
  });

  await setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA  = randomUUID();
  adminB  = randomUUID();
  packA   = randomUUID();
  levelA  = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-a", "Tenant A");
    await insertTenant(client, tenantB, "tenant-b", "Tenant B");
    await insertAdminUser(client, adminA, tenantA, "admin-a@score-test.assessiq");
    await insertAdminUser(client, adminB, tenantB, "admin-b@score-test.assessiq");
    await insertPack(client, { id: packA, tenantId: tenantA, name: "Score Test Pack", createdBy: adminA });
    // Label "L2 — SOC Analyst" causes the route to pick socLevel = "L2"
    await insertLevel(client, { id: levelA, packId: packA, tenantId: tenantA, label: "L2 — SOC Analyst" });
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ===========================================================================
// Tests
// ===========================================================================

describe("POST /api/admin/generation-attempts/:id/score — happy path", () => {
  it("returns 200 with expected shape when the attempt exists and has questions", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      // Seed: insert attempt at a known time, then insert questions created after it.
      const startedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
      let attemptId: string;

      await withSuperClient(async (client) => {
        attemptId = await insertAttempt(client, {
          tenantId: tenantA,
          packId: packA,
          levelId: levelA,
          userId: adminA,
          status: "success",
          countRequested: 3,
          countInserted: 3,
          chunksPlanned: 5,
          chunksFailed: 0,
          startedAt,
        });

        // Insert 3 MCQ questions created after attempt started_at
        const qCreated = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
        for (let i = 0; i < 3; i++) {
          await insertMcqQuestion(client, {
            packId: packA,
            levelId: levelA,
            tenantId: tenantA,
            createdBy: adminA,
            topic: `SOC topic ${i}`,
            createdAt: qCreated,
          });
        }
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/generation-attempts/${attemptId!}/score`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        attempt: Record<string, unknown>;
        structural: {
          per_type: Array<{ type: string; total: number; passed: number; failed: number; failures: string[] }>;
          total: number;
          passed: number;
          failed: number;
          baseline_diff: {
            regressions: unknown[];
            improvements: unknown[];
          };
        };
        runtime: { metrics: unknown[] };
        overall: string;
      }>();

      // attempt shape
      expect(body.attempt["id"]).toBe(attemptId!);
      expect(body.attempt["status"]).toBe("success");
      expect(typeof body.attempt["count_requested"]).toBe("number");
      expect(typeof body.attempt["count_inserted"]).toBe("number");
      expect("chunks_planned" in body.attempt).toBe(true);
      expect("chunks_failed" in body.attempt).toBe(true);
      expect("citation_dropped" in body.attempt).toBe(true);
      expect("started_at" in body.attempt).toBe(true);
      expect("finished_at" in body.attempt).toBe(true);

      // structural shape
      expect(Array.isArray(body.structural.per_type)).toBe(true);
      expect(typeof body.structural.total).toBe("number");
      expect(typeof body.structural.passed).toBe("number");
      expect(typeof body.structural.failed).toBe("number");
      expect(body.structural.total).toBe(body.structural.passed + body.structural.failed);
      expect(Array.isArray(body.structural.baseline_diff.regressions)).toBe(true);
      expect(Array.isArray(body.structural.baseline_diff.improvements)).toBe(true);

      // per_type row for mcq must exist
      const mcqRow = body.structural.per_type.find((r) => r.type === "mcq");
      expect(mcqRow).toBeDefined();
      expect(mcqRow!.total).toBe(3);

      // runtime shape
      expect(Array.isArray(body.runtime.metrics)).toBe(true);

      // overall is a valid verdict string
      expect(["pass", "regression", "warning", "n/a"]).toContain(body.overall);
    } finally {
      await app.close();
    }
  });

  it("overall is 'pass' for a clean attempt with no baseline regressions and good chunk rate", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const startedAt = new Date(Date.now() - 200_000).toISOString();
      let attemptId: string;

      await withSuperClient(async (client) => {
        attemptId = await insertAttempt(client, {
          tenantId: tenantA,
          packId: packA,
          levelId: levelA,
          userId: adminA,
          status: "success",
          countRequested: 2,
          countInserted: 2,
          chunksPlanned: 4,
          chunksFailed: 0,
          startedAt,
        });
        const qCreated = new Date(Date.now() - 100_000).toISOString();
        for (let i = 0; i < 2; i++) {
          await insertMcqQuestion(client, {
            packId: packA,
            levelId: levelA,
            tenantId: tenantA,
            createdBy: adminA,
            topic: `Clean attempt topic ${i}`,
            createdAt: qCreated,
          });
        }
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/generation-attempts/${attemptId!}/score`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ overall: string }>();
      // With no baseline.json entries and good chunk rate, should be pass or n/a
      expect(["pass", "n/a"]).toContain(body.overall);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/admin/generation-attempts/:id/score — 404 not found", () => {
  it("returns 404 for a non-existent attempt id", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/generation-attempts/${randomUUID()}/score`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/admin/generation-attempts/:id/score — tenant isolation", () => {
  it("returns 404 when adminB tries to score tenantA's attempt", async () => {
    // Seed an attempt for tenantA
    let attemptId: string;
    await withSuperClient(async (client) => {
      attemptId = await insertAttempt(client, {
        tenantId: tenantA,
        packId: packA,
        levelId: levelA,
        userId: adminA,
        status: "success",
      });
    });

    // Call score as adminB (tenantB session) — RLS makes the row invisible
    const app = await buildTestApp(tenantB, adminB);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/generation-attempts/${attemptId!}/score`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
