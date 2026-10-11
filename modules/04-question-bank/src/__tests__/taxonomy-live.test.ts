/**
 * RW-55: live node mapping for new rows + read routes for frameworks / nodes.
 * postgres:16-alpine testcontainer; auth stubbed via a session-injecting hook.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { handleAdminCreateDomain, handleAdminCreateCategory } from "../handlers/admin-domains.js";
import { createPlatformDomain, setPlatformDomainStatus } from "../platform-domains.js";
import { seedTenantTaxonomy } from "../seed.js";

let container: StartedTestContainer;
let url: string;
let tP = "";
const tA = randomUUID();
const tB = randomUUID();
const tC = randomUUID();
const userP = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId };
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] });
  await app.ready();
  return app;
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  await sup((c) => applyAllMigrations(c));
  await setPoolForTesting(url);
  await sup(async (c) => {
    tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    for (const [id, slug] of [[tA, "ta"], [tB, "tb"], [tC, "tc"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }
    for (const [id, t, e] of [[userP, tP, "p-rw55@x.io"], [userA, tA, "a@x.io"], [userB, tB, "b@x.io"]] as const) {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [id, t, e],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("live node mapping", () => {
  it("createDomain / createCategory create linked tenant-owned nodes", async () => {
    const d = await handleAdminCreateDomain({ tenantId: tA, name: "Local Subject" });
    const cat = await handleAdminCreateCategory({ tenantId: tA, domain_id: d.id, name: "Local Unit" });
    const rows = await sup(async (c) => ({
      d: (await c.query(
        `SELECT n.kind, n.code, n.tenant_id, n.parent_id FROM domains x JOIN taxonomy_nodes n ON n.id = x.node_id WHERE x.id=$1`, [d.id])).rows[0],
      c: (await c.query(
        `SELECT n.kind, n.code, n.tenant_id, n.parent_id, x.node_id FROM categories x JOIN taxonomy_nodes n ON n.id = x.node_id WHERE x.id=$1`, [cat.id])).rows[0],
      dn: (await c.query(`SELECT node_id FROM domains WHERE id=$1`, [d.id])).rows[0].node_id,
    }));
    expect(rows.d).toMatchObject({ kind: "subject", code: "local-subject", tenant_id: tA, parent_id: null });
    expect(rows.c).toMatchObject({ kind: "unit", code: "local-unit", tenant_id: tA, parent_id: rows.dn });
  });

  it("platform domain create makes ONE NULL-tenant node and links every propagated copy; archive mirrors", async () => {
    const pd = await createPlatformDomain(userP, { name: "Shared Subject" });
    const q = () => sup(async (c) => ({
      nodes: (await c.query(`SELECT id, status FROM taxonomy_nodes WHERE code='shared-subject' AND tenant_id IS NULL`)).rows,
      doms: (await c.query(`SELECT node_id FROM domains WHERE slug='shared-subject' ORDER BY tenant_id`)).rows,
    }));
    const r = await q();
    expect(r.nodes).toHaveLength(1);
    expect(r.doms.length).toBeGreaterThanOrEqual(4); // platform + ta + tb + tc
    expect(r.doms.every((x: { node_id: string }) => x.node_id === r.nodes[0].id)).toBe(true);
    await setPlatformDomainStatus(userP, pd.id, "archived");
    expect((await q()).nodes[0].status).toBe("archived");
    await setPlatformDomainStatus(userP, pd.id, "active");
    expect((await q()).nodes[0].status).toBe("active");
  });

  it("seedTenantTaxonomy links copied platform domains and categories to existing nodes (creates none)", async () => {
    await sup(async (c) => {
      await c.query(`INSERT INTO categories (tenant_id, domain_id, slug, name, relevance_score, default_selected,
                       supported_types, default_question_count, status)
                     SELECT d.tenant_id, d.id, 'pc', 'PC', 1, true, '["mcq"]'::jsonb, 1, 'active'
                       FROM domains d WHERE d.tenant_id=$1 AND d.slug='shared-subject'`, [tP]);
      // platform category -> NULL-tenant unit node, as the migration would have made
      await c.query(`INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label)
                     SELECT NULL, n.framework_id, n.id, 'unit', 'pc', 'PC' FROM taxonomy_nodes n
                      WHERE n.tenant_id IS NULL AND n.code='shared-subject'`);
    });
    const before = await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM taxonomy_nodes`)).rows[0].n);
    const tD = randomUUID();
    await sup((c) => c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'td','td')`, [tD]));
    await seedTenantTaxonomy(tD);
    const after = await sup(async (c) => ({
      n: (await c.query(`SELECT count(*)::int AS n FROM taxonomy_nodes`)).rows[0].n,
      unlinkedDoms: (await c.query(`SELECT count(*)::int AS n FROM domains WHERE tenant_id=$1 AND node_id IS NULL`, [tD])).rows[0].n,
      doms: (await c.query(`SELECT count(*)::int AS n FROM domains WHERE tenant_id=$1`, [tD])).rows[0].n,
      pc: (await c.query(`SELECT c.node_id, n.tenant_id FROM categories c JOIN taxonomy_nodes n ON n.id=c.node_id
                           WHERE c.tenant_id=$1 AND c.slug='pc'`, [tD])).rows,
    }));
    expect(after.n).toBe(before);
    expect(after.doms).toBeGreaterThan(0);
    expect(after.unlinkedDoms).toBe(0);
    expect(after.pc).toHaveLength(1);
    expect(after.pc[0].tenant_id).toBeNull();
  });
});

describe("GET /api/admin/frameworks[/:id/nodes]", () => {
  it("returns frameworks and ordered nodes; other tenants do not see a tenant-local node", async () => {
    const appA = await buildApp(tA, userA);
    const fws = await appA.inject({ method: "GET", url: "/api/admin/frameworks" });
    expect(fws.statusCode).toBe(200);
    const fw = fws.json().items.find((f: { slug: string }) => f.slug === "legacy-domains");
    expect(fw).toMatchObject({ source: "platform", status: "active", tenant_id: null });

    const nodesA = await appA.inject({ method: "GET", url: `/api/admin/frameworks/${fw.id}/nodes` });
    expect(nodesA.statusCode).toBe(200);
    const codesA = nodesA.json().items.map((n: { code: string }) => n.code);
    expect(codesA).toContain("local-subject");
    expect(codesA).toContain("shared-subject");

    const units = await appA.inject({ method: "GET", url: `/api/admin/frameworks/${fw.id}/nodes?kind=unit` });
    expect(units.json().items.every((n: { kind: string }) => n.kind === "unit")).toBe(true);
    expect(units.json().items.map((n: { code: string }) => n.code)).toContain("local-unit");

    const appB = await buildApp(tB, userB);
    const nodesB = await appB.inject({ method: "GET", url: `/api/admin/frameworks/${fw.id}/nodes` });
    const codesB = nodesB.json().items.map((n: { code: string }) => n.code);
    expect(codesB).toContain("shared-subject");
    expect(codesB).not.toContain("local-subject");
    expect(codesB).not.toContain("local-unit");
  });

  it("rejects a non-uuid id and an unknown kind with 4xx", async () => {
    const app = await buildApp(tA, userA);
    expect((await app.inject({ method: "GET", url: "/api/admin/frameworks/not-a-uuid/nodes" })).statusCode).toBe(400);
    const id = randomUUID();
    expect((await app.inject({ method: "GET", url: `/api/admin/frameworks/${id}/nodes?kind=bogus` })).statusCode).toBe(400);
  });
});
