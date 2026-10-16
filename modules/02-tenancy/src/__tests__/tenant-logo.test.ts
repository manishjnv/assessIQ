/**
 * Tenant logo (Logo L1) - live integration tests (Docker + postgres:16).
 *   1. set -> row + one tenant.logo.updated audit (metadata only, no bytes).
 *   2. replace -> before holds the previous metadata; still one logo row.
 *   3. remove -> row gone + tenant.logo.removed; second remove = false, no extra audit.
 *   4. RLS: tenant B cannot read or delete tenant A's logo.
 *   5. Invalid image -> ValidationError, nothing written.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../pool.js";
import {
  setTenantLogo,
  removeTenantLogo,
  getTenantLogoMeta,
  getTenantLogoBytes,
  tenantLogoUrl,
} from "../service.js";

const ACTOR = "00000000-0000-0000-0000-000000000003";

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

function png(w: number, h: number, fill = 0): Buffer {
  const b = Buffer.alloc(40, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const audits = (id: string, action: string) =>
  sql<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
    `SELECT before, after FROM audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id`,
    [id, action],
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
  await sql(`DELETE FROM tenant_logos`);
  await sql(`DELETE FROM audit_log WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
});

describe("tenant logo", () => {
  it("set stores the row, returns meta and writes one metadata-only audit row", async () => {
    const meta = await setTenantLogo(A, png(100, 50), ACTOR);
    expect(meta).toMatchObject({ mime: "image/png", width: 100, height: 50, byte_size: 40 });
    const rows = await audits(A, "tenant.logo.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toBeNull();
    expect(rows[0]!.after).toMatchObject({ mime: "image/png", sha256: meta.sha256 });
    expect(JSON.stringify(rows[0])).not.toContain("bytes");
    const got = await getTenantLogoBytes(A);
    expect(got?.bytes.equals(png(100, 50))).toBe(true);
    expect(tenantLogoUrl(A, meta.sha256)).toBe(`/api/public/tenant-logo/${A}?v=${meta.sha256.slice(0, 12)}`);
  });

  it("replace keeps one row and records the previous metadata as before", async () => {
    const first = await setTenantLogo(A, png(100, 50), ACTOR);
    const second = await setTenantLogo(A, png(64, 64, 7), ACTOR);
    expect(second.sha256).not.toBe(first.sha256);
    expect(await sql(`SELECT 1 FROM tenant_logos WHERE tenant_id = $1`, [A])).toHaveLength(1);
    const rows = await audits(A, "tenant.logo.updated");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.before).toMatchObject({ sha256: first.sha256 });
  });

  it("remove deletes, audits once, and is false when nothing exists", async () => {
    await setTenantLogo(A, png(100, 50), ACTOR);
    expect(await removeTenantLogo(A, ACTOR)).toBe(true);
    expect(await getTenantLogoMeta(A)).toBeNull();
    expect(await removeTenantLogo(A, ACTOR)).toBe(false);
    expect(await audits(A, "tenant.logo.removed")).toHaveLength(1);
  });

  it("RLS: another tenant cannot read or delete this tenant's logo", async () => {
    await setTenantLogo(A, png(100, 50), ACTOR);
    expect(await getTenantLogoMeta(B)).toBeNull();
    expect(await getTenantLogoBytes(B)).toBeNull();
    expect(await removeTenantLogo(B, ACTOR)).toBe(false);
    expect(await getTenantLogoMeta(A)).not.toBeNull();
  });

  it("invalid image throws and writes nothing", async () => {
    await expect(setTenantLogo(A, Buffer.from("<svg/>"), ACTOR)).rejects.toThrow();
    await expect(setTenantLogo(A, png(1, 1), ACTOR)).rejects.toThrow();
    expect(await sql(`SELECT 1 FROM tenant_logos`)).toHaveLength(0);
    expect(await audits(A, "tenant.logo.updated")).toHaveLength(0);
  });
});
