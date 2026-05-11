/**
 * Route-level tests for POST /api/admin/questions/bulk-update-status.
 *
 * Validation tests (1-4) use a Fastify app with a LIVE DB because the route
 * is registered on the same app instance. For the DB-backed tests (5-6) a
 * postgres:16-alpine testcontainer is started in beforeAll.
 *
 * Skip guard: no explicit Docker check — same pattern as the existing tests in
 * this module (question-bank.test.ts, generation-attempts-route.test.ts).
 * If testcontainers cannot reach Docker, all tests in this file will time-out
 * and vitest will report them as failed/skipped — that is acceptable per the
 * task spec ("mark skipped under the same skip-if-no-docker guard the existing
 * tests use").
 *
 * Migration order: tenancy → users (020 only) → question-bank.
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
const QB_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT   = join(QB_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR   = join(MODULES_ROOT, "03-users", "migrations");
const AUDIT_MIGRATIONS_DIR   = join(MODULES_ROOT, "14-audit-log", "migrations");
const QB_MIGRATIONS_DIR      = join(QB_MODULE_ROOT, "migrations");

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

/** IDs of questions seeded in tenantA so the happy-path tests can reference them. */
let qIds: string[];
/** An id seeded in tenantB (must land in notFound when queried as tenantA). */
let qCrossTenant: string;

// ---------------------------------------------------------------------------
// DB helpers (super-client bypasses RLS)
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
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

async function insertAdminUser(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

async function insertPack(
  client: Client,
  id: string,
  tenantId: string,
  createdBy: string,
): Promise<void> {
  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, 'Test Pack', 'soc', 'draft', 1, $4)`,
    [id, tenantId, `slug-${id.slice(0, 8)}`, createdBy],
  );
}

async function insertLevel(
  client: Client,
  id: string,
  packId: string,
  _tenantId: string,
): Promise<void> {
  // levels has no tenant_id column — RLS derives tenancy through pack_id FK
  // (see modules/04-question-bank/migrations/0011_levels.sql). duration_minutes
  // and default_question_count are NOT NULL with no defaults, so they must be
  // supplied. Mirrors the working pattern in audit-writes.test.ts.
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 2, 'L2', 30, 10)`,
    [id, packId],
  );
}

async function insertQuestion(
  client: Client,
  id: string,
  packId: string,
  levelId: string,
  _tenantId: string,
  status: string,
  createdBy: string,
): Promise<void> {
  // questions has no tenant_id column — RLS derives tenancy through pack_id FK
  // (see modules/04-question-bank/migrations/0012_questions.sql). created_by is
  // NOT NULL FK to users — caller must pass an existing admin user id.
  await client.query(
    `INSERT INTO questions
       (id, pack_id, level_id, type, topic, points, status, version, content, created_by)
     VALUES ($1, $2, $3, 'mcq', 'Test topic', 1, $4, 1,
             '{"question":"Q?","options":["A","B"],"correct":0,"rationale":"R"}', $5)`,
    [id, packId, levelId, status, createdBy],
  );
}

// ---------------------------------------------------------------------------
// Build minimal test Fastify app — auth stubbed via preHandler
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
      POSTGRES_DB: "aiq_bulk_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_bulk_test`;

  const [tenancyFiles, usersFiles, auditFiles, qbFiles] = await Promise.all([
    readdir(TENANCY_MIGRATIONS_DIR),
    readdir(USERS_MIGRATIONS_DIR),
    readdir(AUDIT_MIGRATIONS_DIR),
    readdir(QB_MIGRATIONS_DIR),
  ]);

  // audit-log migrations precede QB migrations because the G3.D sweep wires
  // auditInTx() into bulkUpdateQuestionStatus — the route's happy-path tests
  // would otherwise fail with "relation audit_log does not exist".
  const migrations = [
    ...tenancyFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: TENANCY_MIGRATIONS_DIR, file: f })),
    ...usersFiles.filter((f) => f.endsWith(".sql") && f.startsWith("020_")).sort().map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f })),
    ...auditFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: AUDIT_MIGRATIONS_DIR, file: f })),
    ...qbFiles.filter((f) => f.endsWith(".sql")).sort().map((f) => ({ dir: QB_MIGRATIONS_DIR, file: f })),
  ];

  await withSuperClient(async (client) => {
    for (const { dir, file } of migrations) {
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

  const packB  = randomUUID();
  const levelB = randomUUID();
  qCrossTenant = randomUUID();
  qIds = [randomUUID(), randomUUID(), randomUUID()];

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-a-bulk", "Tenant A");
    await insertTenant(client, tenantB, "tenant-b-bulk", "Tenant B");
    await insertAdminUser(client, adminA, tenantA, "admin-a-bulk@example.com");
    await insertAdminUser(client, adminB, tenantB, "admin-b-bulk@example.com");

    await insertPack(client, packA, tenantA, adminA);
    await insertLevel(client, levelA, packA, tenantA);

    // Seed 3 ai_draft questions in tenantA
    for (const qId of qIds) {
      await insertQuestion(client, qId, packA, levelA, tenantA, "ai_draft", adminA);
    }

    // Seed a cross-tenant question in tenantB
    await insertPack(client, packB, tenantB, adminB);
    await insertLevel(client, levelB, packB, tenantB);
    await insertQuestion(client, qCrossTenant, packB, levelB, tenantB, "ai_draft", adminB);
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// ===========================================================================
// Validation tests — no DB round-trips; fast
// ===========================================================================

describe("POST /api/admin/questions/bulk-update-status — validation", () => {
  it("empty ids array → 400 INVALID_BULK_SIZE", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids: [], status: "archived" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_BULK_SIZE");
    } finally {
      await app.close();
    }
  });

  it("201 ids → 400 INVALID_BULK_SIZE", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const ids = Array.from({ length: 201 }, () => randomUUID());
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids, status: "archived" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("INVALID_BULK_SIZE");
    } finally {
      await app.close();
    }
  });

  it("non-UUID id → 400 INVALID_PARAM", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids: ["not-a-uuid"], status: "archived" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: { code: string; details?: Record<string, unknown> } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      // The route-level details.code is INVALID_PARAM
    } finally {
      await app.close();
    }
  });

  it("bad status value → 400", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids: [randomUUID()], status: "ai_draft" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ===========================================================================
// Happy-path and RLS tests — require running DB
// ===========================================================================

describe("POST /api/admin/questions/bulk-update-status — DB integration", () => {
  it("happy path: 3 valid ai_draft ids → updated=[3], notFound=[]", async () => {
    // Reset questions to ai_draft in case a previous test archived them.
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE questions SET status = 'ai_draft' WHERE id = ANY($1)`,
        [qIds],
      );
    });

    const app = await buildTestApp(tenantA, adminA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids: qIds, status: "archived" },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json<{ updated: string[]; notFound: string[] }>();
      expect(body.updated.sort()).toEqual([...qIds].sort());
      expect(body.notFound).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("cross-tenant: id from tenantB is invisible to tenantA → goes into notFound", async () => {
    const app = await buildTestApp(tenantA, adminA);
    try {
      // Mix one valid tenantA id with the cross-tenant id
      const ids = [qIds[0]!, qCrossTenant];

      // Ensure qIds[0] is in ai_draft
      await withSuperClient(async (client) => {
        await client.query(
          `UPDATE questions SET status = 'ai_draft' WHERE id = $1`,
          [qIds[0]],
        );
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/admin/questions/bulk-update-status",
        payload: { ids, status: "archived" },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json<{ updated: string[]; notFound: string[] }>();
      // tenantA's question should be updated; tenantB's should be notFound
      expect(body.updated).toContain(qIds[0]);
      expect(body.notFound).toContain(qCrossTenant);
    } finally {
      await app.close();
    }
  });
});
