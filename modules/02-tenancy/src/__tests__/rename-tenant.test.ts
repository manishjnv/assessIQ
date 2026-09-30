/**
 * renameTenant (tenant-admin renames own company) — live integration tests.
 *
 *   1. Renames tenants.name; slug/status untouched; exactly ONE tenant.renamed audit row.
 *   2. Whitespace is collapsed + trimmed before storing.
 *   3. Same-name submit = no-op (no write, no audit).
 *   4. Another tenant's row is never touched (RLS-scoped withTenant).
 *   5. Validation: too short / too long / control chars / non-string -> ValidationError, no write.
 *   6. Atomicity: audit INSERT failure rolls the rename back.
 *
 * Migrations: all 02-tenancy + 03-users 020_users.sql + 14-audit-log 0050
 * (same set as audit-writes.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setPoolForTesting, closePool } from "../pool.js";
import { renameTenant, normalizeTenantName } from "../service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = join(HERE, "..", "..", "..");
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

async function applyDir(c: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of only ? files.filter((x) => only.includes(x)) : files) {
    await c.query(await readFile(join(dir, f), "utf8"));
  }
}

const nameOf = async (id: string): Promise<string> =>
  (await sql<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [id]))[0]!.name;
const auditRows = (id: string) =>
  sql<{ entity_id: string }>(
    `SELECT entity_id::text FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.renamed'`,
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
  await c.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='assessiq_app') THEN CREATE ROLE assessiq_app; END IF; END $$;`,
  );
  await c.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='assessiq_system') THEN CREATE ROLE assessiq_system BYPASSRLS; END IF; END $$;`,
  );
  await c.query(`GRANT assessiq_app TO assessiq`);
  await c.query(`GRANT assessiq_system TO assessiq`);
  await applyDir(c, join(MODULES_ROOT, "02-tenancy", "migrations"));
  await applyDir(c, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
  await applyDir(c, join(MODULES_ROOT, "14-audit-log", "migrations"), ["0050_audit_log.sql"]);
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

describe("renameTenant", () => {
  it("renames own tenant, leaves slug/status alone, writes exactly one tenant.renamed audit row", async () => {
    const q = `SELECT slug, status FROM tenants WHERE id = $1`;
    const before = (await sql(q, [A]))[0];
    const r = await renameTenant(ACTOR, A, "Acme Holdings");
    expect(r).toMatchObject({ tenantId: A, name: "Acme Holdings", previousName: "Acme Corp", noOp: false });
    expect(await nameOf(A)).toBe("Acme Holdings");
    expect((await sql(q, [A]))[0]).toEqual(before);
    const rows = await auditRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(A);
    expect(r.auditId).not.toBeNull();
  });

  it("collapses internal whitespace and trims", async () => {
    const r = await renameTenant(ACTOR, A, "  Acme \t  Holdings \n Ltd  ");
    expect(r.name).toBe("Acme Holdings Ltd");
    expect(await nameOf(A)).toBe("Acme Holdings Ltd");
  });

  it("same name is an idempotent no-op (no audit row)", async () => {
    const r = await renameTenant(ACTOR, A, "  Acme   Corp ");
    expect(r.noOp).toBe(true);
    expect(r.auditId).toBeNull();
    expect(await auditRows(A)).toHaveLength(0);
  });

  it("cannot touch another tenant: renaming A never changes B", async () => {
    await renameTenant(ACTOR, A, "Acme Holdings");
    expect(await nameOf(B)).toBe("Other Co");
    expect(await auditRows(B)).toHaveLength(0);
  });

  it.each([
    ["too short", "A"],
    ["blank", "   "],
    ["too long", "x".repeat(121)],
    ["control char", "Acme\u0007Corp"],
    ["null byte", "Acme\u0000"],
    ["not a string", 42],
    ["missing", undefined],
  ])("rejects %s with ValidationError and does not write", async (_label, input) => {
    await expect(renameTenant(ACTOR, A, input)).rejects.toMatchObject({ name: "ValidationError" });
    expect(await nameOf(A)).toBe("Acme Corp");
    expect(await auditRows(A)).toHaveLength(0);
  });

  it("accepts boundary lengths 2 and 120", () => {
    expect(normalizeTenantName("ab")).toBe("ab");
    expect(normalizeTenantName("y".repeat(120))).toHaveLength(120);
  });

  it("atomicity: audit INSERT failure rolls the rename back", async () => {
    await sql(`ALTER TABLE audit_log ADD CONSTRAINT _t_rename_atomic CHECK (false) NOT VALID`);
    try {
      await expect(renameTenant(ACTOR, A, "Acme Holdings")).rejects.toThrow();
      expect(await nameOf(A)).toBe("Acme Corp");
    } finally {
      await sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS _t_rename_atomic`);
    }
  });
});
