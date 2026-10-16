/**
 * updateAiGradingScope (super admin sets written | none) - live integration tests.
 *   1. New tenants default to 'written'; findTenantSettings maps the column.
 *   2. written -> none writes the column and exactly one tenant_settings.ai_grading_scope.updated audit row.
 *   3. The DB CHECK rejects other values.
 *   4. Another tenant's row is never touched (RLS).
 * Needs Docker (postgres testcontainer).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { withTenant } from "../with-tenant.js";
import { updateAiGradingScope, getAiGradingScope } from "../service.js";
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

const scopeOf = async (id: string): Promise<string> =>
  (await sql<{ s: string }>(`SELECT ai_grading_scope AS s FROM tenant_settings WHERE tenant_id = $1`, [id]))[0]!.s;

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
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Acme Corp'), ($3, $4, 'Other Co')`, [A, `acme-${A.slice(0, 8)}`, B, `other-${B.slice(0, 8)}`]);
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1), ($2)`, [A, B]);
  await sql(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, 'admin@acme.test', 'Acme Admin', 'admin')`, [ACTOR, A]);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(async () => {
  await sql(`UPDATE tenant_settings SET ai_grading_scope = 'written' WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
  await sql(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
});

describe("ai_grading_scope setting", () => {
  it("defaults to 'written' and is mapped by findTenantSettings", async () => {
    expect(await scopeOf(A)).toBe("written");
    expect((await withTenant(A, (c) => findTenantSettings(c)))?.ai_grading_scope).toBe("written");
    expect(await getAiGradingScope(A)).toBe("written");
  });

  it("written -> none writes the column and one audit row; the other tenant is untouched", async () => {
    const r = await updateAiGradingScope(A, "none", ACTOR);
    expect(r).toMatchObject({ tenantId: A, ai_grading_scope: "none", previous: "written" });
    expect(await scopeOf(A)).toBe("none");
    expect(await scopeOf(B)).toBe("written");
    const rows = await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = 'tenant_settings.ai_grading_scope.updated'`,
      [A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toEqual({ ai_grading_scope: "written" });
    expect(rows[0]!.after).toEqual({ ai_grading_scope: "none" });
  });

  it("the DB CHECK rejects other values", async () => {
    await expect(sql(`UPDATE tenant_settings SET ai_grading_scope = 'all' WHERE tenant_id = $1`, [A])).rejects.toThrow();
  });
});
