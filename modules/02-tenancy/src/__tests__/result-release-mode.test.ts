/**
 * updateResultReleaseMode (tenant admin picks manual | auto result release) —
 * live integration tests.
 *
 *   1. New tenants default to 'manual'; findTenantSettings maps the column.
 *   2. manual -> auto writes the column, stamps result_release_auto_since (auto -> manual
 *      clears it), and writes exactly ONE tenant.settings.updated audit row (before/after, no PII).
 *   3. Same-mode request is an idempotent no-op (no write, no audit, auto_since untouched).
 *   4. Invalid mode -> ValidationError, nothing written.
 *   5. Another tenant's row is never touched (RLS-scoped withTenant).
 *   6. Atomicity: audit INSERT failure rolls the change back.
 *   7. The DB CHECK constraint rejects values outside (manual, auto).
 *
 * Migrations: all 02-tenancy + 03-users 020_users.sql + 14-audit-log 0050
 * + 20-data-rights 0103 (findTenantSettings selects retention_days).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { withTenant } from "../with-tenant.js";
import { updateResultReleaseMode } from "../service.js";
import { findTenantSettings } from "../repository.js";

const ACTOR = "00000000-0000-0000-0000-000000000002";

let container: StartedTestContainer;
let url: string;
let A: string;
let B: string;

async function sql<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}

const modeOf = async (id: string): Promise<string> =>
  (await sql<{ m: string }>(`SELECT result_release_mode AS m FROM tenant_settings WHERE tenant_id = $1`, [id]))[0]!.m;
const autoSince = async (id: string): Promise<string | null> =>
  (await sql<{ t: string | null }>(`SELECT result_release_auto_since::text AS t FROM tenant_settings WHERE tenant_id = $1`, [id]))[0]!.t;
const auditRows = (id: string) =>
  sql<{ entity_id: string; actor_user_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
    `SELECT entity_id::text, actor_user_id::text, before, after FROM audit_log
      WHERE tenant_id = $1 AND action = 'tenant.settings.updated'`,
    [id],
  );

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;

  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
  await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  await c.query(`GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO assessiq_app`);
  await c.end();

  setPoolForTesting(url);
  A = randomUUID();
  B = randomUUID();
  await sql(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme Corp'), ($3, $4, 'Other Co')`,
    [A, `acme-${A.slice(0, 8)}`, B, `other-${B.slice(0, 8)}`],
  );
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`, [A, B]);
  // audit_log.actor_user_id has an FK to users(id).
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, 'admin@acme.test', 'Acme Admin', 'admin')`,
    [ACTOR, A],
  );
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  await sql(`UPDATE tenant_settings SET result_release_mode = 'manual', result_release_auto_since = NULL WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
  await sql(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
});

describe("result_release_mode setting", () => {
  it("defaults to 'manual' and is mapped by findTenantSettings", async () => {
    const fresh = randomUUID();
    await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Fresh')`, [fresh, `fresh-${fresh.slice(0, 8)}`]);
    await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [fresh]);
    expect(await modeOf(fresh)).toBe("manual");
    const s = await withTenant(fresh, (c) => findTenantSettings(c));
    expect(s?.result_release_mode).toBe("manual");
  });

  it("manual -> auto: writes the column, stamps result_release_auto_since, exactly one tenant.settings.updated audit row", async () => {
    expect(await autoSince(A)).toBeNull(); // manual tenants have no auto_since
    const before = Date.now();
    const r = await updateResultReleaseMode(ACTOR, A, "auto");
    expect(r).toMatchObject({ tenantId: A, result_release_mode: "auto", previous: "manual" });
    expect(r.auditId).not.toBeNull();
    expect(await modeOf(A)).toBe("auto");
    const stamp = await autoSince(A);
    expect(stamp).not.toBeNull();
    expect(new Date(stamp!).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(r.result_release_auto_since?.getTime()).toBe(new Date(stamp!).getTime());

    const rows = await auditRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_id: A,
      actor_user_id: ACTOR,
      before: { result_release_mode: "manual" },
      after: { result_release_mode: "auto" },
    });
    const s = await withTenant(A, (c) => findTenantSettings(c));
    expect(s?.result_release_mode).toBe("auto");
    expect(s?.result_release_auto_since?.getTime()).toBe(new Date(stamp!).getTime());
  });

  it("auto -> manual works too and clears result_release_auto_since", async () => {
    await updateResultReleaseMode(ACTOR, A, "auto");
    expect(await autoSince(A)).not.toBeNull();
    const r = await updateResultReleaseMode(ACTOR, A, "manual");
    expect(r).toMatchObject({ result_release_mode: "manual", previous: "auto", result_release_auto_since: null });
    expect(await modeOf(A)).toBe("manual");
    expect(await autoSince(A)).toBeNull();
    expect(await auditRows(A)).toHaveLength(2);
  });

  it("same mode is an idempotent no-op: no audit row, auto_since untouched (a repeat 'auto' never re-stamps it)", async () => {
    // manual -> manual: nothing changes
    const r = await updateResultReleaseMode(ACTOR, A, "manual");
    expect(r).toMatchObject({ result_release_mode: "manual", previous: "manual", auditId: null, result_release_auto_since: null });
    expect(await auditRows(A)).toHaveLength(0);
    expect(await autoSince(A)).toBeNull();

    // auto -> auto: the original switch moment survives (otherwise a repeated click
    // would silently move the "released before the switch" boundary forward)
    await updateResultReleaseMode(ACTOR, A, "auto");
    const first = await autoSince(A);
    await sql(`SELECT pg_sleep(0.05)`);
    const again = await updateResultReleaseMode(ACTOR, A, "auto");
    expect(again.auditId).toBeNull();
    expect(await autoSince(A)).toBe(first);
    expect(await auditRows(A)).toHaveLength(1);
  });

  it.each([["bogus"], [""], [null], [undefined], [1], [true]])(
    "rejects invalid mode %j with ValidationError and does not write",
    async (input) => {
      await expect(updateResultReleaseMode(ACTOR, A, input)).rejects.toMatchObject({ name: "ValidationError" });
      expect(await modeOf(A)).toBe("manual");
      expect(await auditRows(A)).toHaveLength(0);
    },
  );

  it("cannot touch another tenant: flipping A never changes B", async () => {
    await updateResultReleaseMode(ACTOR, A, "auto");
    expect(await modeOf(B)).toBe("manual");
    expect(await auditRows(B)).toHaveLength(0);
  });

  it("atomicity: audit INSERT failure rolls the change back", async () => {
    await sql(`ALTER TABLE audit_log ADD CONSTRAINT _t_rrm_atomic CHECK (false) NOT VALID`);
    try {
      await expect(updateResultReleaseMode(ACTOR, A, "auto")).rejects.toThrow();
      expect(await modeOf(A)).toBe("manual");
    } finally {
      await sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS _t_rrm_atomic`);
    }
  });

  it("the DB CHECK constraint rejects values outside (manual, auto)", async () => {
    await expect(
      sql(`UPDATE tenant_settings SET result_release_mode = 'bogus' WHERE tenant_id = $1`, [A]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
