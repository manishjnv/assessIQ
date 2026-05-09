/**
 * Route-level integration tests for GET /api/admin/generation-attempts.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Auth is stubbed (empty preHandler array + session-injecting decorator) —
 * auth integration is exercised in 01-auth's own tests.
 *
 * Migration apply order:
 *   tenancy (0001-0003) → users (020 only) → question-bank (0010+)
 *   → ai-grading 0042_generation_attempts.sql (the table we query)
 *
 * Each test group inserts its own generation_attempts rows and asserts the
 * response shape returned by the new endpoint.
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

const THIS_DIR       = toFsPath(new URL(".", import.meta.url));
const QB_MODULE_ROOT = join(THIS_DIR, "..", "..");          // modules/04-question-bank/
const MODULES_ROOT   = join(QB_MODULE_ROOT, "..");          // modules/

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR   = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR      = join(QB_MODULE_ROOT, "migrations");
const AI_GRADING_MIGRATIONS_DIR = join(MODULES_ROOT, "07-ai-grading", "migrations");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
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
  await client.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, name]);
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

async function insertAdminUser(client: Client, id: string, tenantId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

/** Insert a generation_attempts row via the super client (bypasses RLS). */
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
    model?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    stderrTail?: string | null;
    skillSha?: string | null;
    chunksPlanned?: number | null;
    chunksFailed?: number | null;
    durationMs?: number | null;
    startedAt?: string;
  },
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await client.query(
    `INSERT INTO generation_attempts
       (id, tenant_id, pack_id, level_id, user_id, status,
        count_requested, count_inserted, model, error_code, error_message,
        stderr_tail, skill_sha, chunks_planned, chunks_failed, duration_ms, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             COALESCE($17::timestamptz, now()))`,
    [
      id,
      opts.tenantId,
      opts.packId,
      opts.levelId,
      opts.userId,
      opts.status ?? "success",
      opts.countRequested ?? 10,
      opts.countInserted ?? 10,
      opts.model ?? null,
      opts.errorCode ?? null,
      opts.errorMessage ?? null,
      opts.stderrTail ?? null,
      opts.skillSha ?? null,
      opts.chunksPlanned ?? null,
      opts.chunksFailed ?? null,
      opts.durationMs ?? null,
      opts.startedAt ?? null,
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Build a minimal Fastify test app — auth is stubbed via a preHandler that
// decorates req.session with the given tenantId and userId.
// ---------------------------------------------------------------------------

async function buildTestApp(sessionTenantId: string, sessionUserId: string) {
  const app = Fastify({ logger: false });

  // Stub session — routes read req.session.tenantId / req.session.userId.
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
      POSTGRES_DB: "aiq_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;

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

  // Only 020_users.sql — skip 021_invitations.sql (requires auth tables)
  const usersSorted = usersFiles
    .filter((f) => f.endsWith(".sql") && f.startsWith("020_"))
    .sort()
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));

  const qbSorted = qbFiles
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ dir: QB_MIGRATIONS_DIR, file: f }));

  // Only 0042_generation_attempts.sql — the table we exercise here.
  // 0040_gradings.sql is skipped (requires 01-auth tables not present).
  // 0041_tenant_grading_budgets.sql is skipped (depends on 0040).
  const aiGradingSorted = aiGradingFiles
    .filter((f) => f.endsWith(".sql") && f === "0042_generation_attempts.sql")
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
  packA   = randomUUID();
  levelA  = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-a", "Tenant A");
    await insertTenant(client, tenantB, "tenant-b", "Tenant B");
    await insertAdminUser(client, adminA, tenantA, "admin-a@example.com");
    // Insert a dummy admin for tenantB (for RLS isolation test)
    const adminB = randomUUID();
    await insertAdminUser(client, adminB, tenantB, "admin-b@example.com");

    // Seed attempts for tenantA
    await insertAttempt(client, {
      tenantId: tenantA, packId: packA, levelId: levelA, userId: adminA,
      status: "success", countRequested: 10, countInserted: 10,
      model: "claude-sonnet-4", durationMs: 12_000,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
    });
    await insertAttempt(client, {
      tenantId: tenantA, packId: packA, levelId: levelA, userId: adminA,
      status: "partial", countRequested: 15, countInserted: 12,
      model: "claude-sonnet-4", durationMs: 8_500,
      errorCode: "PARTIAL_CHUNK_FAIL", errorMessage: "2 of 5 chunks failed",
      stderrTail: "Error: rate limit hit",
      startedAt: new Date(Date.now() - 7_200_000).toISOString(), // 2h ago
    });
    await insertAttempt(client, {
      tenantId: tenantA, packId: packA, levelId: levelA, userId: adminA,
      status: "failed", countRequested: 5, countInserted: 0,
      model: "claude-haiku", durationMs: 2_000,
      errorCode: "SKILL_NOT_FOUND",
      startedAt: new Date(Date.now() - 86_400_000).toISOString(), // 1d ago
    });

    // Seed one attempt for tenantB — must NOT appear in tenantA responses
    const packB = randomUUID();
    const levelB = randomUUID();
    const adminB2 = randomUUID();
    await insertAdminUser(client, adminB2, tenantB, "admin-b2@example.com");
    await insertAttempt(client, {
      tenantId: tenantB, packId: packB, levelId: levelB, userId: adminB2,
      status: "success",
    });
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ===========================================================================
// Tests
// ===========================================================================

describe("GET /api/admin/generation-attempts — response shape", () => {
  it("returns items array, total, limit, offset with defaults", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/generation-attempts" });
      expect(res.statusCode).toBe(200);

      const body = res.json<{ items: unknown[]; total: number; limit: number; offset: number }>();
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("each item has the expected columns", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/generation-attempts" });
      const body = res.json<{ items: Record<string, unknown>[] }>();
      expect(body.items.length).toBeGreaterThan(0);

      const item = body.items[0]!;
      expect(typeof item["id"]).toBe("string");
      expect(typeof item["status"]).toBe("string");
      expect(typeof item["count_requested"]).toBe("number");
      expect(typeof item["count_inserted"]).toBe("number");
      expect(typeof item["started_at"]).toBe("string");
      expect(typeof item["pack_id"]).toBe("string");
      expect(typeof item["level_id"]).toBe("string");
      // nullable columns may be null
      expect("error_code" in item).toBe(true);
      expect("error_message" in item).toBe(true);
      expect("stderr_tail" in item).toBe(true);
      expect("skill_sha" in item).toBe(true);
      expect("model" in item).toBe(true);
      expect("chunks_planned" in item).toBe(true);
      expect("chunks_failed" in item).toBe(true);
      expect("dedupe_dropped" in item).toBe(true);
      expect("duration_ms" in item).toBe(true);
      expect("finished_at" in item).toBe(true);
      expect("user_id" in item).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns attempts sorted by started_at DESC (most recent first)", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/generation-attempts" });
      const body = res.json<{ items: Array<{ started_at: string }> }>();
      expect(body.items.length).toBeGreaterThan(1);

      const times = body.items.map((i) => new Date(i.started_at).getTime());
      for (let idx = 1; idx < times.length; idx++) {
        expect(times[idx]!).toBeLessThanOrEqual(times[idx - 1]!);
      }
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — status filter", () => {
  it("status=success returns only success rows", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?status=success",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ status: string }> }>();
      for (const item of body.items) {
        expect(item.status).toBe("success");
      }
    } finally {
      await app.close();
    }
  });

  it("status=partial returns only partial rows", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?status=partial",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ status: string }> }>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.status).toBe("partial");
      }
    } finally {
      await app.close();
    }
  });

  it("status=failed returns only failed rows and NOT partial", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?status=failed",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ status: string }> }>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.status).toBe("failed");
        // Confirm partial is NOT included
        expect(item.status).not.toBe("partial");
      }
    } finally {
      await app.close();
    }
  });

  it("invalid status value is ignored — returns all rows", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?status=bogus",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: unknown[]; total: number }>();
      // total should equal the full tenantA row count (3 seeded above)
      expect(body.total).toBe(3);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — model filter", () => {
  it("model=sonnet returns only rows with 'sonnet' in model", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?model=sonnet",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ model: string | null }> }>();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.model?.toLowerCase()).toContain("sonnet");
      }
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — pack_id / level_id filter", () => {
  it("pack_id filter returns only rows for that pack", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/generation-attempts?pack_id=${packA}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ pack_id: string }>; total: number }>();
      expect(body.total).toBe(3);
      for (const item of body.items) {
        expect(item.pack_id).toBe(packA);
      }
    } finally {
      await app.close();
    }
  });

  it("level_id filter returns only rows for that level", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/generation-attempts?level_id=${levelA}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ level_id: string }> }>();
      for (const item of body.items) {
        expect(item.level_id).toBe(levelA);
      }
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — since filter", () => {
  it("since=30m returns only recent attempts", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      // since=30 minutes ago; only the 1h-ago attempt is in range (not 2h, not 1d)
      // Correct: seeded 1h ago IS older than 30 min. Expect 0 items.
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/generation-attempts?since=${encodeURIComponent(since)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ total: number }>();
      expect(body.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("since=3h returns the 1h-ago and 2h-ago attempts but not 1d-ago", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/generation-attempts?since=${encodeURIComponent(since)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ total: number }>();
      expect(body.total).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — pagination", () => {
  it("limit=1 returns at most 1 item", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?limit=1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: unknown[]; total: number; limit: number; offset: number }>();
      expect(body.items.length).toBe(1);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("limit=1 offset=1 returns the second row", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const resPage1 = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?limit=1&offset=0",
      });
      const resPage2 = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?limit=1&offset=1",
      });
      const p1 = resPage1.json<{ items: Array<{ id: string }> }>();
      const p2 = resPage2.json<{ items: Array<{ id: string }> }>();
      expect(p1.items[0]!.id).not.toBe(p2.items[0]!.id);
    } finally {
      await app.close();
    }
  });

  it("limit > 100 is clamped to 50 (default)", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/generation-attempts?limit=999",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ limit: number }>();
      expect(body.limit).toBe(50);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/admin/generation-attempts — RLS tenant isolation", () => {
  it("tenantA admin cannot see tenantB attempts", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/generation-attempts" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ pack_id: string }>; total: number }>();

      // tenantA has 3 seeded attempts (packA); total must not include tenantB's
      expect(body.total).toBe(3);
      for (const item of body.items) {
        expect(item.pack_id).toBe(packA);
      }
    } finally {
      await app.close();
    }
  });
});
