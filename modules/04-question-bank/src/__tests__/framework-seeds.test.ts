/**
 * RW-57: framework seed loader + super-admin routes.
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
import { loadFrameworkSeed, loadFrameworkSeedData } from "../framework-seeds.js";
import sample from "../frameworks/sample.json" with { type: "json" };

let container: StartedTestContainer;
let url: string;
let tA = "";
const userP = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const nodeCount = () => sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM taxonomy_nodes n JOIN frameworks f ON f.id=n.framework_id WHERE f.slug='sample'`)).rows[0].n as number);
const auditCount = () => sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='framework.seed_loaded'`)).rows[0].n as number);

async function buildApp(role: "admin" | "super_admin") {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId: tA, userId: userP, role };
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
  tA = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'ta','ta')`, [tA]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tA]);
    const tP = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id;
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'p-rw57@x.io','Super','admin','active')`, [userP, tP]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("framework seed loader", () => {
  it("invalid seed is rejected with the schema path and writes nothing", async () => {
    const bad = structuredClone(sample) as { code: string; nodes: { children: { kind: string }[] }[] };
    bad.code = "bad-seed";
    bad.nodes[0]!.children[0]!.kind = "chapter";
    await expect(loadFrameworkSeedData(userP, bad)).rejects.toThrow(/nodes\.0\.children\.0\.kind/);
    const n = await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM frameworks WHERE slug='bad-seed'`)).rows[0].n);
    expect(n).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it("loads the sample once with one audit row; a second load creates no duplicates", async () => {
    const first = await loadFrameworkSeed(userP, "sample");
    expect(first).toEqual({ frameworks: 1, nodesCreated: 9, nodesUpdated: 0, nodesUnchanged: 0 });
    expect(await auditCount()).toBe(1);
    const n1 = await nodeCount();
    const second = await loadFrameworkSeed(userP, "sample");
    expect(second).toEqual({ frameworks: 1, nodesCreated: 0, nodesUpdated: 0, nodesUnchanged: 9 });
    expect(await nodeCount()).toBe(n1);
    expect(n1).toBe(9);
    const fw = await sup(async (c) => (await c.query(`SELECT count(*)::int AS n FROM frameworks WHERE slug='sample'`)).rows[0].n);
    expect(fw).toBe(1);
  });
});

describe("framework seed routes", () => {
  for (const [method, url_] of [["GET", "/api/admin/super/frameworks/seeds"], ["POST", "/api/admin/super/frameworks/seeds/sample/load"]] as const) {
    it(`tenant admin ${method} ${url_} -> 403`, async () => {
      const app = await buildApp("admin");
      const res = await app.inject({ method, url: url_ });
      expect(res.statusCode).toBe(403);
    });
  }
  it("super admin lists seeds with the loaded version", async () => {
    const app = await buildApp("super_admin");
    const res = await app.inject({ method: "GET", url: "/api/admin/super/frameworks/seeds" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ code: "sample", board: "SAMPLE", nodeCount: 9, loadedVersion: "2026-27" });
  });
});
