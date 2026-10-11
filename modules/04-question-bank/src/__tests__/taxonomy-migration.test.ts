/**
 * Migration 0169 (RW-55): curriculum frameworks, taxonomy nodes, question_taxonomy.
 * The harness applies every migration at start (0169 runs on empty data), so the test
 * seeds legacy-shaped rows afterwards and RE-RUNS the 0169 file (it is idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0169_curriculum_frameworks.sql");

let container: StartedTestContainer;
let url: string;
let tP = "";
const tA = randomUUID();
const tB = randomUUID();
const q1 = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Run as assessiq_app with the tenant GUC set (RLS engaged), always rolled back. */
async function asApp<T>(tenant: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return sup(async (c) => {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE assessiq_app");
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    try { return await fn(c); } finally { await c.query("ROLLBACK"); }
  });
}

async function domain(c: Client, tenant: string, slug: string, source: string, order: number): Promise<string> {
  return (await c.query<{ id: string }>(
    `INSERT INTO domains (tenant_id, slug, name, source, status, display_order)
     VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
    [tenant, slug, slug.toUpperCase(), source, order],
  )).rows[0]!.id;
}
async function category(c: Client, tenant: string, domainId: string, slug: string): Promise<string> {
  return (await c.query<{ id: string }>(
    `INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected,
                             supported_types, default_question_count, status)
     VALUES ($1,$2,$3,$3,1,true,'["mcq"]'::jsonb,1,'active') RETURNING id`,
    [tenant, domainId, slug],
  )).rows[0]!.id;
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup(async (c) => {
    await applyAllMigrations(c);
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    for (const [id, slug] of [[tA, "ta"], [tB, "tb"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }
    const user = randomUUID();
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.io','A','admin','active')`,
      [user, tA],
    );
    // zeta: platform domain copied to all three tenants (platform tenant already exists, migration 016)
    const zP = await domain(c, tP, "zeta", "platform", 90);
    const zA = await domain(c, tA, "zeta", "platform", 90);
    await domain(c, tB, "zeta", "platform", 90);
    await category(c, tP, zP, "z1");
    const z1A = await category(c, tA, zA, "z1"); // also in platform -> shared node
    await category(c, tA, zA, "z2");             // tenant-A only -> tenant-owned node
    const localA = await domain(c, tA, "local-x", "tenant", 91);
    await category(c, tA, localA, "lc");
    // one question in tenant A tagged soc/triage
    const pack = randomUUID();
    const level = randomUUID();
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by)
       VALUES ($1,$2,'p','P','soc','draft',1,$3)`, [pack, tA, user]);
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
       VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
    await c.query(
      `INSERT INTO questions (id, pack_id, level_id, type, topic, points, content, created_by, domain_id, category_id)
       VALUES ($1,$2,$3,'mcq','t',1,'{"question":"Q?","options":["A","B"],"correct":0,"rationale":"R"}',$4,$5,$6)`,
      [q1, pack, level, user, zA, z1A]);
    await c.query(await readFile(MIG, "utf8")); // re-run on legacy-shaped data
    await c.query(await readFile(MIG, "utf8")); // and again: idempotent
  });
}, 120_000);

afterAll(async () => { if (container !== undefined) await container.stop(); }, 30_000);

const MINE = ["zeta", "z1", "z2", "local-x", "lc"];

describe("0169 curriculum frameworks migration", () => {
  it("creates exactly one framework and the right node shape", () => sup(async (c) => {
    expect((await c.query(`SELECT 1 FROM frameworks WHERE slug='legacy-domains'`)).rowCount).toBe(1);
    const r = await c.query(`SELECT kind, code, tenant_id FROM taxonomy_nodes WHERE code = ANY($1) ORDER BY code`, [MINE]);
    expect(r.rows).toEqual([
      { kind: "unit", code: "lc", tenant_id: tA },
      { kind: "subject", code: "local-x", tenant_id: tA },
      { kind: "unit", code: "z1", tenant_id: null },
      { kind: "unit", code: "z2", tenant_id: tA },
      { kind: "subject", code: "zeta", tenant_id: null },
    ]);
  }));

  it("links every domain and category and backfills question_taxonomy", () => sup(async (c) => {
    expect((await c.query(`SELECT 1 FROM domains WHERE node_id IS NULL`)).rowCount).toBe(0);
    expect((await c.query(`SELECT 1 FROM categories WHERE node_id IS NULL`)).rowCount).toBe(0);
    const qt = await c.query(`SELECT n.kind, n.code FROM question_taxonomy t JOIN taxonomy_nodes n ON n.id=t.node_id
                              WHERE t.question_id=$1 ORDER BY n.kind`, [q1]);
    expect(qt.rows).toEqual([{ kind: "subject", code: "zeta" }, { kind: "unit", code: "z1" }]);
  }));

  it("RLS: tenant sees NULL-tenant + own nodes only, and cannot update a platform node", async () => {
    const codes = async (t: string) =>
      (await asApp(t, async (c) => (await c.query(`SELECT code FROM taxonomy_nodes WHERE code = ANY($1)`, [MINE])).rows))
        .map((r) => r.code).sort();
    expect(await codes(tA)).toEqual(["lc", "local-x", "z1", "z2", "zeta"]);
    expect(await codes(tB)).toEqual(["z1", "zeta"]);
    const upd = await asApp(tA, (c) => c.query(`UPDATE taxonomy_nodes SET label='x' WHERE tenant_id IS NULL`));
    expect(upd.rowCount).toBe(0);
    expect(await asApp(tB, async (c) => (await c.query(`SELECT 1 FROM frameworks`)).rowCount)).toBe(1);
    expect(await asApp(tB, async (c) => (await c.query(`SELECT 1 FROM question_taxonomy`)).rowCount)).toBe(0);
    expect(await asApp(tA, async (c) => (await c.query(`SELECT 1 FROM question_taxonomy`)).rowCount)).toBe(2);
  });
});
