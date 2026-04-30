/**
 * Integration tests for modules/02-tenancy.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack (roles,
 * policies, SET LOCAL) is exercised against a real Postgres instance.
 *
 * Container is started ONCE in beforeAll and torn down in afterAll.
 * All tests share the same container but get their own pool clients.
 *
 * ESLint: no console.log allowed — use vitest reporter output only.
 */

import { describe, it, test, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, getPool } from "../pool.js";
import { withTenant } from "../with-tenant.js";
import { tenantContextMiddleware } from "../middleware.js";
import type { TenantRequest, TenantReply, TenantContextHooks } from "../middleware.js";
import { AuthnError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;

// Two tenant IDs inserted in beforeAll and reused by all tests.
let tenantA: string;
let tenantB: string;

// Middleware hooks instance (created once, reused).
let hooks: TenantContextHooks;

// Absolute path to the migrations directory.
// import.meta.url = file:///E:/code/.../src/__tests__/tenancy.test.ts
// new URL(".", ...).pathname = /E:/code/.../src/__tests__/   (trailing slash)
// On Windows the pathname has a leading slash before the drive letter; strip it.
// With the trailing slash, two ".." steps reach the module root (02-tenancy/).
const MIGRATIONS_DIR = join(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  "..",
  "..",
  "migrations",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh pg.Client as the test superuser and run fn, then close it. */
async function withSuperClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Build a minimal valid TenantReply mock. */
function makeMockReply(initialStatus = 200): TenantReply {
  const reply: TenantReply = {
    statusCode: initialStatus,
    code(status: number): TenantReply {
      reply.statusCode = status;
      return reply;
    },
    send(_payload: unknown): TenantReply {
      return reply;
    },
  };
  return reply;
}

/** Build a minimal TenantRequest mock with the given headers. */
function makeMockRequest(headers: Record<string, string> = {}): TenantRequest {
  return { headers };
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Spin up postgres:16-alpine testcontainer.
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

  // 2. Apply all migrations in lexical order using the superuser client.
  const migrationFiles = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await withSuperClient(async (client) => {
    for (const file of migrationFiles) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);
    }
  });

  // 3. Point the module's singleton pool at the testcontainer.
  await setPoolForTesting(containerUrl);

  // 4. Insert two tenants via superuser (bypasses RLS naturally).
  tenantA = randomUUID();
  tenantB = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [tenantA, "tenant-a", "Tenant A", tenantB, "tenant-b", "Tenant B"],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`,
      [tenantA, tenantB],
    );
  });

  // 5. Instantiate middleware hooks once.
  hooks = tenantContextMiddleware();
}, 90_000); // allow up to 90s for container pull + start on cold machines

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
});

// ---------------------------------------------------------------------------
// Test 1 — RLS isolation: cross-tenant SELECT returns zero
// ---------------------------------------------------------------------------

describe("RLS isolation", () => {
  it("withTenant(tenantA) sees only tenantA rows in tenants", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("SELECT id FROM tenants"),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(tenantA);
  });

  it("withTenant(tenantA) sees only tenantA row in tenant_settings", async () => {
    const result = await withTenant(tenantA, (client) =>
      client.query("SELECT tenant_id FROM tenant_settings"),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tenant_id).toBe(tenantA);
  });

  it("withTenant(tenantB) sees only tenantB rows — no leak from prior A context", async () => {
    const result = await withTenant(tenantB, (client) =>
      client.query("SELECT id FROM tenants"),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(tenantB);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — BYPASSRLS for assessiq_system
// ---------------------------------------------------------------------------

it("assessiq_system with BYPASSRLS sees all tenants without setting app.current_tenant", async () => {
  await withSuperClient(async (client) => {
    await client.query("SET ROLE assessiq_system");
    const result = await client.query<{ id: string }>(
      "SELECT id FROM tenants ORDER BY id",
    );
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    await client.query("SET ROLE NONE");
  });
});

// ---------------------------------------------------------------------------
// Test 3 — RLS fail-closed when no context is set
// ---------------------------------------------------------------------------

it("assessiq_app without app.current_tenant set sees zero rows (fail-closed)", async () => {
  await withSuperClient(async (client) => {
    await client.query("SET ROLE assessiq_app");
    const result = await client.query("SELECT * FROM tenants");
    expect(result.rows).toHaveLength(0);
    await client.query("RESET ROLE");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — middleware preHandler attaches req.tenant + req.db
// ---------------------------------------------------------------------------

it("middleware preHandler attaches req.tenant and req.db with a live scoped transaction", async () => {
  const req = makeMockRequest({ "x-aiq-test-tenant": tenantA });
  const reply = makeMockReply();

  await hooks.preHandler(req, reply);

  expect(req.tenant).toEqual({ id: tenantA });
  expect(req.db).toBeDefined();

  // Inside the still-open transaction: RLS should scope to tenantA.
  const result = await req.db!.query<{ id: string }>("SELECT id FROM tenants");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.id).toBe(tenantA);

  await hooks.onResponse(req, reply);

  expect(req.db).toBeUndefined();
  expect(req.tenant).toBeUndefined();

  // No leaked clients: all checked-out clients must be returned.
  const pool = getPool();
  expect(pool.totalCount - pool.idleCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 5 — middleware releases client on handler throw
// ---------------------------------------------------------------------------

it("middleware releases client when the handler throws (aborted transaction path)", async () => {
  const req = makeMockRequest({ "x-aiq-test-tenant": tenantA });
  const reply = makeMockReply();

  await hooks.preHandler(req, reply);

  // Force a query error — puts the transaction into aborted state.
  let caughtError: unknown;
  try {
    await req.db!.query("SELECT * FROM nonexistent_table_that_does_not_exist");
  } catch (err) {
    caughtError = err;
  }

  expect(caughtError).toBeDefined();

  // Simulate Fastify's onError -> onResponse path.
  reply.code(500);
  await hooks.onResponse(req, reply);

  // Client must have been released.
  expect(req.db).toBeUndefined();
  const pool = getPool();
  expect(pool.totalCount - pool.idleCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 6 — middleware rejects when no tenantId resolvable
// ---------------------------------------------------------------------------

it("middleware preHandler throws AuthnError when no tenant context is resolvable", async () => {
  const req = makeMockRequest({}); // no header, no session
  const reply = makeMockReply();

  await expect(hooks.preHandler(req, reply)).rejects.toBeInstanceOf(AuthnError);
});

// ---------------------------------------------------------------------------
// Test 7 — middleware rejects x-aiq-test-tenant in production
// ---------------------------------------------------------------------------

// The `config` singleton is evaluated eagerly at module load time, which means
// vi.stubEnv + vi.resetModules would replace the pool singleton and point it at
// the placeholder DATABASE_URL from vitest.setup.ts (not the testcontainer).
// Re-wiring the pool after a module reset would require re-running beforeAll
// setup logic inside the test itself — coupling that pollutes isolation.
// This is a structural limitation of the eager-singleton pattern in 00-core;
// the fix is config injection in Phase 1 (pass `config` as a parameter to
// tenantContextMiddleware instead of importing it module-level).
test.todo(
  "x-aiq-test-tenant header is ignored in production [blocked by 00-core's eager config singleton — needs config injection in Phase 1 to test cleanly]",
);

// ---------------------------------------------------------------------------
// Test 7b — INSERT under wrong tenant is rejected by tenant_isolation_insert
// ---------------------------------------------------------------------------

it("RLS WITH CHECK: insert into tenant_settings with foreign tenant_id is rejected", async () => {
  // Insert two more tenants so we have a fresh pair without existing settings rows.
  const tenantC = randomUUID();
  const tenantD = randomUUID();
  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [tenantC, "tenant-c", "Tenant C", tenantD, "tenant-d", "Tenant D"],
    );
  });

  // Under tenantC's context, attempt to insert tenant_settings with tenantD's id.
  // The tenant_isolation_insert WITH CHECK policy must reject this.
  let caught: Error | undefined;
  try {
    await withTenant(tenantC, async (client) => {
      await client.query(
        `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
        [tenantD],
      );
    });
  } catch (err) {
    caught = err as Error;
  }

  expect(caught).toBeDefined();
  // Postgres surfaces RLS violations as "new row violates row-level security policy".
  expect(caught?.message ?? "").toMatch(/row-level security policy|violates/i);

  // Sanity: a matching insert (tenantC under tenantC's context) must succeed.
  await withTenant(tenantC, async (client) => {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [tenantC],
    );
  });

  // Verify the matching row landed and the rejected one didn't, using
  // assessiq_system to see across tenants.
  await withSuperClient(async (client) => {
    await client.query("SET ROLE assessiq_system");
    const result = await client.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM tenant_settings WHERE tenant_id IN ($1, $2)",
      [tenantC, tenantD],
    );
    const ids = result.rows.map((r) => r.tenant_id);
    expect(ids).toContain(tenantC);
    expect(ids).not.toContain(tenantD);
    await client.query("RESET ROLE");
  });
});

// ---------------------------------------------------------------------------
// Test 8 — sequential requests for different tenants don't leak
// ---------------------------------------------------------------------------

it("sequential requests for different tenants remain properly scoped (no SET LOCAL leak across pool connections)", async () => {
  // Request 1: tenantA
  const reqA1 = makeMockRequest({ "x-aiq-test-tenant": tenantA });
  const replyA1 = makeMockReply();
  await hooks.preHandler(reqA1, replyA1);
  const resultA1 = await reqA1.db!.query<{ id: string }>("SELECT id FROM tenants");
  expect(resultA1.rows).toHaveLength(1);
  expect(resultA1.rows[0]?.id).toBe(tenantA);
  await hooks.onResponse(reqA1, replyA1);

  // Request 2: tenantB (potentially reuses the same pooled connection)
  const reqB = makeMockRequest({ "x-aiq-test-tenant": tenantB });
  const replyB = makeMockReply();
  await hooks.preHandler(reqB, replyB);
  const resultB = await reqB.db!.query<{ id: string }>("SELECT id FROM tenants");
  expect(resultB.rows).toHaveLength(1);
  expect(resultB.rows[0]?.id).toBe(tenantB);
  await hooks.onResponse(reqB, replyB);

  // Request 3: tenantA again — proves context is re-established after B
  const reqA2 = makeMockRequest({ "x-aiq-test-tenant": tenantA });
  const replyA2 = makeMockReply();
  await hooks.preHandler(reqA2, replyA2);
  const resultA2 = await reqA2.db!.query<{ id: string }>("SELECT id FROM tenants");
  expect(resultA2.rows).toHaveLength(1);
  expect(resultA2.rows[0]?.id).toBe(tenantA);
  await hooks.onResponse(reqA2, replyA2);

  // No leaked clients after all three requests.
  const pool = getPool();
  expect(pool.totalCount - pool.idleCount).toBe(0);
});
