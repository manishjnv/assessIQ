/**
 * RW-36(a): queries moved out of apps/api super-admin tenant routes and the
 * embed-secrets route into the tenancy repository/service. Live Postgres.
 *
 *   1. renameTenantAsSuperAdmin: rename + one audit row; same name = no-op;
 *      unknown tenant = NotFoundError with the original message.
 *   2. listTenantsForSuperAdmin: admin summary columns, counts, archived filter.
 *   3. isPrivacyDisclosed: false by default, true after the flag flips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import {
  renameTenantAsSuperAdmin,
  listTenantsForSuperAdmin,
  isPrivacyDisclosed,
} from "../service.js";

const ACTOR = "00000000-0000-0000-0000-0000000000a1";

let container: StartedTestContainer;
let url: string;
let A: string;
let B: string;
let C: string;

async function sql<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}

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
  await c.end();

  setPoolForTesting(url);
  A = randomUUID();
  B = randomUUID();
  C = randomUUID();
  await sql(
    `INSERT INTO tenants (id, slug, name, status) VALUES
       ($1, $2, 'Acme Corp', 'active'),
       ($3, $4, 'Bravo Co', 'active'),
       ($5, $6, 'Old Co', 'archived')`,
    [A, `acme-${A.slice(0, 8)}`, B, `bravo-${B.slice(0, 8)}`, C, `old-${C.slice(0, 8)}`],
  );
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES
       ($1, $2, 'admin@acme.test', 'Acme Admin', 'admin', 'active')`,
    [ACTOR, A],
  );
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe("renameTenantAsSuperAdmin", () => {
  it("renames, audits once, and treats the same name as a no-op", async () => {
    const r = await renameTenantAsSuperAdmin(ACTOR, A, "Acme Renamed");
    expect(r).toMatchObject({ tenantId: A, name: "Acme Renamed", previousName: "Acme Corp", noOp: false });
    expect(r.auditId).not.toBeNull();
    const audits = await sql(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.renamed'`, [A]);
    expect(audits).toHaveLength(1);

    const again = await renameTenantAsSuperAdmin(ACTOR, A, "Acme Renamed");
    expect(again).toMatchObject({ noOp: true, auditId: null });
    const audits2 = await sql(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.renamed'`, [A]);
    expect(audits2).toHaveLength(1);
  });

  it("throws NotFoundError (original message) for an unknown tenant", async () => {
    const id = randomUUID();
    await expect(renameTenantAsSuperAdmin(ACTOR, id, "X Co")).rejects.toThrow(`Tenant not found: ${id}`);
  });
});

describe("listTenantsForSuperAdmin", () => {
  it("returns first-admin summary + counts and hides archived unless asked", async () => {
    const rows = await listTenantsForSuperAdmin(false);
    const acme = rows.find((r) => r.id === A)!;
    expect(acme.admin_email).toBe("admin@acme.test");
    expect(acme.admin_user_id).toBe(ACTOR);
    expect(acme.admin_count).toBe(1);
    expect(acme.reviewer_count).toBe(0);
    const bravo = rows.find((r) => r.id === B)!;
    expect(bravo.admin_email).toBeNull();
    expect(bravo.admin_count).toBe(0);
    expect(rows.find((r) => r.id === C)).toBeUndefined();

    const all = await listTenantsForSuperAdmin(true);
    expect(all.find((r) => r.id === C)).toBeDefined();
  });
});

describe("isPrivacyDisclosed", () => {
  it("is false by default and true once the flag is set", async () => {
    expect(await isPrivacyDisclosed(B)).toBe(false);
    await sql(`UPDATE tenants SET privacy_disclosed = TRUE WHERE id = $1`, [B]);
    expect(await isPrivacyDisclosed(B)).toBe(true);
  });
});
