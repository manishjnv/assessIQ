/**
 * G3.D coverage + structural-shape tests for the 02-tenancy audit-write slice.
 *
 * Why this file exists:
 *   The existing tenancy tests do not apply the audit-log migrations, so they
 *   mock @assessiq/audit-log to a no-op. This file is the guard. It does two things:
 *
 *   A. Static structural tests (no testcontainer):
 *     1. Coverage: updateTenantSettings and suspendTenant each have exactly one
 *        auditInTx call site.
 *     2. Action-name correctness: each call site uses an action that exists in
 *        ACTION_CATALOG.
 *     3. Atomicity-by-structure: every audit-wired function also references
 *        withTenant (shared PoolClient → shared pg transaction).
 *     4. No re-add of the old fire-and-forget audit() call site in
 *        updateTenantSettings.
 *
 *   B. Live integration tests (testcontainer):
 *     5. Happy-path: updateTenantSettings writes a tenant.settings.updated
 *        audit_log row with correct entity/before/after.
 *     6. Atomicity: mock auditInTx to throw once → settings UPDATE rolls back.
 *     7. Happy-path: suspendTenant writes a tenant.suspended audit_log row
 *        and sets tenant.status = 'suspended'.
 *     8. Atomicity: mock auditInTx to throw once for suspendTenant → tenant
 *        status NOT updated (withTenant rolls back).
 *
 * Migration apply order for the testcontainer (section B):
 *   1. ALL 02-tenancy migrations (sorted by filename)
 *   2. 03-users 020_users.sql ONLY (021 depends on auth tables absent here)
 *   3. 14-audit-log 0050_audit_log.sql — must come last (FKs to tenants+users)
 *
 * No users table is required: both service functions use actorKind='system'
 * when actorUserId is omitted, so actor_user_id is NULL — no FK violation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock @assessiq/audit-log — allows one-shot failure injection for atomicity
// tests (section B) without touching production code.
//
// vi.hoisted() is required because vi.mock factories are hoisted before module
// declarations; a plain `let` variable declared outside the factory is not
// reachable from the hoisted factory closure. vi.hoisted() creates a binding
// that is itself hoisted alongside the factory, so the closure works correctly.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({ injectAuditFailure: null as Error | null }));

vi.mock("@assessiq/audit-log", async () => {
  const actual =
    await vi.importActual<typeof import("@assessiq/audit-log")>("@assessiq/audit-log");
  return {
    ...actual,
    auditInTx: vi.fn(async (...args: Parameters<typeof actual.auditInTx>) => {
      if (mockState.injectAuditFailure !== null) {
        const err = mockState.injectAuditFailure;
        mockState.injectAuditFailure = null; // one-shot
        throw err;
      }
      return actual.auditInTx(...args);
    }),
  };
});

import { ACTION_CATALOG } from "@assessiq/audit-log";
import { setPoolForTesting, closePool } from "../pool.js";
import { updateTenantSettings, suspendTenant } from "../service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_FILE = join(HERE, "..", "service.ts");

const MODULE_ROOT = join(HERE, "..", "..");
const MODULES_ROOT = join(MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULE_ROOT, "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const AUDIT_MIGRATIONS_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");

// ---------------------------------------------------------------------------
// Coverage table
// ---------------------------------------------------------------------------

const COVERAGE: Array<{
  functionName: string;
  expectedAction: string;
  expectedCallCount: number;
}> = [
  {
    functionName: "updateTenantSettings",
    expectedAction: "tenant.settings.updated",
    expectedCallCount: 1,
  },
  {
    functionName: "suspendTenant",
    expectedAction: "tenant.suspended",
    expectedCallCount: 1,
  },
];

// ---------------------------------------------------------------------------
// Section A — Static structural tests
// ---------------------------------------------------------------------------

describe("02-tenancy G3.D audit-write coverage", () => {
  let serviceSrc: string;

  beforeAll(async () => {
    serviceSrc = await readFile(SERVICE_FILE, "utf-8");
  });

  // -------------------------------------------------------------------------
  // 1. Call-count correctness
  // -------------------------------------------------------------------------

  for (const entry of COVERAGE) {
    describe(entry.functionName, () => {
      it(`has exactly ${entry.expectedCallCount} auditInTx call site(s)`, () => {
        // Slice out the function body by finding the function declaration and
        // the next top-level export. This avoids counting calls from other
        // functions in the same file.
        const fnStart = serviceSrc.indexOf(`async function ${entry.functionName}`);
        expect(fnStart).toBeGreaterThan(-1);
        // Find the next top-level `export async function` after this one
        const nextFn = serviceSrc.indexOf(`export async function`, fnStart + 10);
        const fnBody =
          nextFn > -1 ? serviceSrc.slice(fnStart, nextFn) : serviceSrc.slice(fnStart);
        const callCount = (fnBody.match(/auditInTx\s*\(/g) ?? []).length;
        expect(callCount).toBe(entry.expectedCallCount);
      });

      it("imports auditInTx from @assessiq/audit-log", () => {
        expect(serviceSrc).toMatch(
          /import\s*\{[^}]*\bauditInTx\b[^}]*\}\s*from\s*["']@assessiq\/audit-log["']/,
        );
      });

      it(`emits action "${entry.expectedAction}" (and that action exists in ACTION_CATALOG)`, () => {
        const fnStart = serviceSrc.indexOf(`async function ${entry.functionName}`);
        const nextFn = serviceSrc.indexOf(`export async function`, fnStart + 10);
        const fnBody =
          nextFn > -1 ? serviceSrc.slice(fnStart, nextFn) : serviceSrc.slice(fnStart);
        const escaped = entry.expectedAction.replace(/\./g, "\\.");
        const matches = fnBody.match(new RegExp(`["']${escaped}["']`, "g")) ?? [];
        expect(matches.length).toBeGreaterThan(0);
        expect(ACTION_CATALOG).toContain(entry.expectedAction);
      });

      it(`mentions both withTenant and auditInTx (atomicity structure)`, () => {
        const fnStart = serviceSrc.indexOf(`async function ${entry.functionName}`);
        const nextFn = serviceSrc.indexOf(`export async function`, fnStart + 10);
        const fnBody =
          nextFn > -1 ? serviceSrc.slice(fnStart, nextFn) : serviceSrc.slice(fnStart);
        expect(fnBody).toMatch(/withTenant\s*\(/);
        expect(fnBody).toMatch(/auditInTx\s*\(/);
      });
    });
  }

  // -------------------------------------------------------------------------
  // 2. Regression guard: updateTenantSettings must NOT use the old
  //    fire-and-forget audit() pattern (bare import + bare call).
  // -------------------------------------------------------------------------

  it("service.ts does not import the old fire-and-forget audit() helper", () => {
    const badImport =
      /import\s*\{[^}]*\baudit\b(?!InTx)[^}]*\}\s*from\s*["']@assessiq\/audit-log["']/;
    expect(serviceSrc).not.toMatch(badImport);
  });

  it("updateTenantSettings has no bare audit( call site", () => {
    const fnStart = serviceSrc.indexOf(`async function updateTenantSettings`);
    const nextFn = serviceSrc.indexOf(`export async function`, fnStart + 10);
    const fnBody =
      nextFn > -1 ? serviceSrc.slice(fnStart, nextFn) : serviceSrc.slice(fnStart);
    // Reject bare `audit(` — allow `auditInTx(`
    const bareAuditCall = /(?<!In|Tx)\baudit\s*\(/g;
    expect((fnBody.match(bareAuditCall) ?? []).length).toBe(0);
  });
});

// ===========================================================================
// Section B — Live integration tests (testcontainer + real audit_log table)
// ===========================================================================

let container: StartedTestContainer;
let containerUrl: string;
let TENANT_ID: string;

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigrationsFromDir(
  client: Client,
  dir: string,
  only?: string[],
): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), "utf8");
    await client.query(sql);
  }
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function queryAudit(tenantId: string, action?: string): Promise<AuditRow[]> {
  return withSuperClient(async (client) => {
    const params: unknown[] = [tenantId];
    let where = `tenant_id = $1`;
    if (action !== undefined) {
      params.push(action);
      where += ` AND action = $2`;
    }
    const result = await client.query<AuditRow>(
      `SELECT id::text, actor_user_id::text, actor_kind, action,
              entity_type, entity_id::text, before, after
         FROM audit_log
        WHERE ${where}
        ORDER BY at DESC`,
      params,
    );
    return result.rows;
  });
}

async function clearAudit(tenantId: string): Promise<void> {
  await withSuperClient((client) =>
    client.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]),
  );
}

async function readTenantSettingsField(
  tenantId: string,
  field: string,
): Promise<unknown> {
  return withSuperClient(async (client) => {
    const r = await client.query<Record<string, unknown>>(
      `SELECT ${field} FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    return r.rows[0]?.[field] ?? null;
  });
}

async function readTenantStatus(tenantId: string): Promise<string | null> {
  return withSuperClient(async (client) => {
    const r = await client.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    return r.rows[0]?.status ?? null;
  });
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "assessiq",
      POSTGRES_PASSWORD: "assessiq_test_pw",
      POSTGRES_DB: "assessiq",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const port = container.getMappedPort(5432);
  const host = container.getHost();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${host}:${port}/assessiq`;

  await withSuperClient(async (client) => {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN
          CREATE ROLE assessiq_app;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN
          CREATE ROLE assessiq_system BYPASSRLS;
        END IF;
      END $$;
    `);
    await client.query(`GRANT assessiq_app TO assessiq`);
    await client.query(`GRANT assessiq_system TO assessiq`);

    // Apply migrations in order
    await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, AUDIT_MIGRATIONS_DIR, ["0050_audit_log.sql"]);

    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await client.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await client.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  });

  setPoolForTesting(containerUrl);

  TENANT_ID = randomUUID();

  await withSuperClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Tenancy Audit Test')`,
      [TENANT_ID, `tenancy-audit-${TENANT_ID.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO tenant_settings (tenant_id) VALUES ($1)`,
      [TENANT_ID],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  mockState.injectAuditFailure = null;
});

// ---------------------------------------------------------------------------
// Test 5 — updateTenantSettings happy-path
// ---------------------------------------------------------------------------

describe("02-tenancy G3.D audit writes — live integration (updateTenantSettings)", () => {
  it("happy-path: writes a tenant.settings.updated audit row with correct entity/before/after", async () => {
    // Ensure ai_grading_enabled is true before the patch
    await withSuperClient((c) =>
      c.query(
        `UPDATE tenant_settings SET ai_grading_enabled = true WHERE tenant_id = $1`,
        [TENANT_ID],
      ),
    );
    await clearAudit(TENANT_ID);

    await updateTenantSettings(TENANT_ID, { ai_grading_enabled: false });

    const rows = await queryAudit(TENANT_ID, "tenant.settings.updated");
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.actor_kind).toBe("system");
    expect(row.actor_user_id).toBeNull();
    expect(row.entity_type).toBe("tenant_settings");
    expect(row.entity_id).toBe(TENANT_ID);
    expect((row.before as Record<string, unknown>).ai_grading_enabled).toBe(true);
    expect((row.after as Record<string, unknown>).ai_grading_enabled).toBe(false);
  });

  it("atomicity: when audit INSERT fails (DB constraint), the settings UPDATE rolls back", async () => {
    // Set a known starting value
    await withSuperClient((c) =>
      c.query(
        `UPDATE tenant_settings SET ai_grading_enabled = true WHERE tenant_id = $1`,
        [TENANT_ID],
      ),
    );

    // Block ALL audit_log INSERTs by adding a CHECK (false) constraint.
    // This causes the real auditInTx to fail with a DB error, proving that
    // withTenant rolls back the domain mutation when the audit write fails.
    await withSuperClient((c) =>
      c.query(`ALTER TABLE audit_log ADD CONSTRAINT _test_atomicity_settings CHECK (false) NOT VALID`),
    );

    try {
      await expect(
        updateTenantSettings(TENANT_ID, { ai_grading_enabled: false }),
      ).rejects.toThrow(); // any DB error — constraint violation

      // The settings UPDATE must have rolled back — value still true
      const val = await readTenantSettingsField(TENANT_ID, "ai_grading_enabled");
      expect(val).toBe(true);
    } finally {
      await withSuperClient((c) =>
        c.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS _test_atomicity_settings`),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7-8 — suspendTenant happy-path + atomicity
// ---------------------------------------------------------------------------

describe("02-tenancy G3.D audit writes — live integration (suspendTenant)", () => {
  // New suspendTenant signature: (tenantId, actorUserId, actorTenantId, reason?)
  // The audit row is scoped to actorTenantId (the platform/actor tenant), not
  // the target tenant. Use TENANT_ID as both target and actorTenantId here
  // since we only have one tenant in the test container, and the audit row
  // lookup uses TENANT_ID. A fixed actor UUID is used for actorUserId.
  const ACTOR_USER_ID = "00000000-0000-0000-0000-000000000001";

  beforeEach(async () => {
    // Reset tenant to 'active' before each test
    await withSuperClient((c) =>
      c.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_ID]),
    );
    await clearAudit(TENANT_ID);
  });

  it("happy-path: writes a tenant.suspended audit row and sets tenant.status = 'suspended'", async () => {
    await suspendTenant(TENANT_ID, ACTOR_USER_ID, TENANT_ID, "billing arrears");

    const status = await readTenantStatus(TENANT_ID);
    expect(status).toBe("suspended");

    const rows = await queryAudit(TENANT_ID, "tenant.suspended");
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(row.actor_kind).toBe("user");
    expect(row.actor_user_id).toBe(ACTOR_USER_ID);
    expect(row.entity_type).toBe("tenant");
    expect(row.entity_id).toBe(TENANT_ID);
    expect((row.after as Record<string, unknown>).status).toBe("suspended");
    expect((row.after as Record<string, unknown>).reason).toBe("billing arrears");
  });

  it("atomicity: when audit INSERT fails (DB constraint), tenant.status is NOT updated (withTenant rolls back)", async () => {
    // Block ALL audit_log INSERTs — causes auditInTx to fail with a DB error.
    await withSuperClient((c) =>
      c.query(`ALTER TABLE audit_log ADD CONSTRAINT _test_atomicity_suspend CHECK (false) NOT VALID`),
    );

    try {
      await expect(
        suspendTenant(TENANT_ID, ACTOR_USER_ID, TENANT_ID, "billing arrears"),
      ).rejects.toThrow(); // any DB error — constraint violation

      const status = await readTenantStatus(TENANT_ID);
      expect(status).toBe("active");
    } finally {
      await withSuperClient((c) =>
        c.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS _test_atomicity_suspend`),
      );
    }
  });
});
