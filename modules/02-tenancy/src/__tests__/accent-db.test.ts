import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import { setTenantAccent } from "../service.js";

const ACTOR = "00000000-0000-0000-0000-000000000001";

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

const primaryOf = async (id: string): Promise<string | null> =>
  (await sql<{ p: string | null }>(`SELECT branding->>'primary' AS p FROM tenants WHERE id = $1`, [id]))[0]!.p;
const auditCount = async (id: string): Promise<number> =>
  Number((await sql<{ n: string }>(`SELECT count(*) n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.branding.updated'`, [id]))[0]!.n);

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
  await sql(`UPDATE tenants SET name = 'Acme Corp' WHERE id = $1`, [A]);
  await sql(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
});

afterAll(async () => {
  await closePool();
  await container?.stop();
});

describe("setTenantAccent (Z-119) against a real database", () => {
  it("sets, audits once, is a no-op on the same value, clears, and never touches another tenant", async () => {
    await setTenantAccent(ACTOR, A, "#3B4CCA");
    expect(await primaryOf(A)).toBe("#3b4cca");
    expect(await auditCount(A)).toBe(1);
    await setTenantAccent(ACTOR, A, "#3b4cca");
    expect(await auditCount(A)).toBe(1);
    expect(await primaryOf(B)).toBeNull();
    await setTenantAccent(ACTOR, A, null);
    expect(await primaryOf(A)).toBeNull();
    expect(await auditCount(A)).toBe(2);
  });

  it("refuses a low-contrast or non-hex colour and writes nothing", async () => {
    await expect(setTenantAccent(ACTOR, A, "#ffff00")).rejects.toThrow(/too light/);
    await expect(setTenantAccent(ACTOR, A, "red; background:url(x)")).rejects.toThrow(/hex/);
    expect(await primaryOf(A)).toBeNull();
  });
});
