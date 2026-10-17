/**
 * EXP-19: takedown propagation against a real Postgres. Withdrawing a platform question marks
 * every tenant clone withdrawn in the same tx, one audit row per affected tenant, idempotent,
 * RLS intact, route stays super admin only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { AppError, withRequestContext } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { createPack, addLevel, publishPack } from "../service/packs.js";
import { createQuestion, withdrawQuestion } from "../service/questions.js";
import { materializeSetForTenant } from "../clone.js";

const MCQ = { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "HTTPS uses 443" };

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const [tA, tB, tC, uA, uB, uC] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role: req.headers["x-role"] };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ error: err.message });
  });
  const superAdminOnly = async (req: { session?: { role?: unknown } }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ error: "forbidden" });
  };
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: superAdminOnly as never });
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
    uP = (await c.query(`SELECT id FROM users WHERE tenant_id=$1 LIMIT 1`, [tP])).rows[0].id;
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"], [tC, "tc", uC, "c@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** A published platform pack with two questions, cloned into tenants A and B (C gets no clone). */
async function seed() {
  const pack = await createPack(tP, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, uP);
  const level = await addLevel(tP, pack.id, { label: "L1" }, uP);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const q = await createQuestion(tP, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, uP);
    ids.push(q.id);
  }
  await publishPack(tP, pack.id, uP);
  const cA = await materializeSetForTenant(pack.id, tA, uA);
  const cB = await materializeSetForTenant(pack.id, tB, uB);
  return { ids, cA, cB };
}

const cloneState = (tenant: string, master: string) =>
  sup(async (c) => (await c.query(
    `SELECT q.id, q.status, s.rights_status, s.tenant_id AS src_tenant
       FROM questions q JOIN question_packs p ON p.id=q.pack_id LEFT JOIN question_source s ON s.question_id=q.id
      WHERE q.source_question_id=$1 AND p.tenant_id=$2`, [master, tenant])).rows[0]);
const audits = (master: string) =>
  sup(async (c) => (await c.query(
    `SELECT tenant_id, actor_kind, actor_user_id FROM audit_log WHERE action='question.takedown_propagated' AND entity_id=$1 ORDER BY tenant_id`, [master])).rows);
const withdraw = (app: Awaited<ReturnType<typeof buildApp>>, id: string, role = "super_admin") =>
  app.inject({ method: "POST", url: `/api/admin/super/questions/${id}/withdraw`, headers: { "x-role": role } });

describe("takedown propagation (EXP-19)", () => {
  it("marks every clone in every tenant, audits once per tenant with the clone's tenant id, leaves the sibling and no-clone tenants alone", async () => {
    const { ids } = await seed();
    const app = await buildApp(tP, uP);
    expect((await withdraw(app, ids[0]!)).statusCode).toBe(200);

    for (const t of [tA, tB]) {
      expect(await cloneState(t, ids[0]!)).toMatchObject({ status: "archived", rights_status: "withdrawn", src_tenant: t });
      expect(await cloneState(t, ids[1]!)).toMatchObject({ status: "active", rights_status: "original" });
    }
    expect(await cloneState(tC, ids[0]!)).toBeUndefined();
    const rows = await audits(ids[0]!);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([tA, tB].sort());
    expect(rows.every((r) => r.actor_kind === "system" && r.actor_user_id === null)).toBe(true);
    expect(await audits(ids[1]!)).toHaveLength(0);
    // the platform withdraw itself is still audited once, in the platform tenant
    const own = await sup((c) => c.query(`SELECT tenant_id FROM audit_log WHERE action='question.withdrawn' AND entity_id=$1`, [ids[0]]));
    expect(own.rows.map((r) => r.tenant_id)).toEqual([tP]);
    expect(await sup((c) => c.query(`SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action LIKE 'question.%'`, [tC]))).toHaveProperty("rowCount", 0);
  });

  it("is idempotent: a second call changes nothing and writes no audit rows", async () => {
    const { ids } = await seed();
    const app = await buildApp(tP, uP);
    await withdraw(app, ids[0]!);
    const total = async () => (await sup((c) => c.query(`SELECT count(*)::int n FROM audit_log`))).rows[0].n;
    const before = { n: await total(), a: await cloneState(tA, ids[0]!) };
    expect((await withdraw(app, ids[0]!)).statusCode).toBe(200);
    expect(await total()).toBe(before.n);
    expect(await cloneState(tA, ids[0]!)).toEqual(before.a);
    expect(await audits(ids[0]!)).toHaveLength(2);
  });

  it("a clone already withdrawn by re-sync is skipped (no second audit for that tenant)", async () => {
    const { ids } = await seed();
    await sup((c) => c.query(
      `UPDATE question_source SET rights_status='withdrawn' WHERE question_id IN
         (SELECT q.id FROM questions q JOIN question_packs p ON p.id=q.pack_id WHERE q.source_question_id=$1 AND p.tenant_id=$2)`, [ids[0], tA]));
    await withdraw(await buildApp(tP, uP), ids[0]!);
    expect((await audits(ids[0]!)).map((r) => r.tenant_id)).toEqual([tB]);
  });

  it("per-tenant takedown audit rows record no ip or user agent even inside a request context that has them", async () => {
    const { ids } = await seed();
    await withRequestContext({ requestId: randomUUID(), tenantId: tP, ip: "203.0.113.9", ua: "PlatformAdmin/1.0" }, () =>
      withdrawQuestion(tP, uP, ids[0]!));
    const rows = (await sup((c) => c.query(
      `SELECT tenant_id, ip, user_agent FROM audit_log WHERE action='question.takedown_propagated' AND entity_id=$1`, [ids[0]]))).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ip === null && r.user_agent === null)).toBe(true);
    // the platform tenant's own withdraw row keeps the context ip
    const own = await sup((c) => c.query(`SELECT ip FROM audit_log WHERE action='question.withdrawn' AND entity_id=$1`, [ids[0]]));
    expect(own.rows[0].ip).toBe("203.0.113.9");
  });

  it("backfill: a repeat withdraw of an already-withdrawn master re-propagates to a clone that is not withdrawn, once", async () => {
    const { ids } = await seed();
    const app = await buildApp(tP, uP);
    await withdraw(app, ids[0]!);
    // simulate a clone that appeared (or was left active) after the master was withdrawn
    await sup(async (c) => {
      const id = (await cloneState(tA, ids[0]!)).id;
      await c.query(`UPDATE questions SET status='active' WHERE id=$1`, [id]);
      await c.query(`UPDATE question_source SET rights_status='original' WHERE question_id=$1`, [id]);
    });
    const countA = async () => (await sup((c) => c.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='question.takedown_propagated' AND entity_id=$1 AND tenant_id=$2`, [ids[0], tA]))).rows[0].n;
    expect(await countA()).toBe(1);
    expect((await withdraw(app, ids[0]!)).statusCode).toBe(200);
    expect(await cloneState(tA, ids[0]!)).toMatchObject({ status: "archived", rights_status: "withdrawn" });
    expect(await countA()).toBe(2);
    expect((await audits(ids[0]!)).filter((r) => r.tenant_id === tB)).toHaveLength(1);
    // third call: nothing left to do
    await withdraw(app, ids[0]!);
    expect(await countA()).toBe(2);
  });

  it("keeps RLS intact: tenant B cannot read tenant A's clone, source row or audit row", async () => {
    const { ids } = await seed();
    await withdraw(await buildApp(tP, uP), ids[0]!);
    const a = await cloneState(tA, ids[0]!);
    const seenByB = await withTenant(tB, async (c) => ({
      q: (await c.query(`SELECT 1 FROM questions WHERE id=$1`, [a.id])).rowCount,
      s: (await c.query(`SELECT 1 FROM question_source WHERE question_id=$1`, [a.id])).rowCount,
      a: (await c.query(`SELECT 1 FROM audit_log WHERE action='question.takedown_propagated' AND entity_id=$1 AND tenant_id=$2`, [ids[0], tA])).rowCount,
    }));
    expect(seenByB).toEqual({ q: 0, s: 0, a: 0 });
    const seenByA = await withTenant(tA, async (c) => (await c.query(`SELECT 1 FROM audit_log WHERE action='question.takedown_propagated' AND entity_id=$1`, [ids[0]])).rowCount);
    expect(seenByA).toBe(1);
  });

  it("route stays super admin only: admin gets 403 and nothing changes", async () => {
    const { ids } = await seed();
    const res = await withdraw(await buildApp(tP, uP), ids[0]!, "admin");
    expect(res.statusCode).toBe(403);
    expect(await cloneState(tA, ids[0]!)).toMatchObject({ status: "active", rights_status: "original" });
    expect(await audits(ids[0]!)).toHaveLength(0);
  });

  it("a tenant-owned question has no clones: withdraw touches no other tenant", async () => {
    const pack = await createPack(tA, { name: `Own ${randomUUID().slice(0, 8)}`, domain: "soc" }, uA);
    const level = await addLevel(tA, pack.id, { label: "L1" }, uA);
    const q = await createQuestion(tA, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: "own", points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, uA);
    expect((await withdraw(await buildApp(tA, uA), q.id)).statusCode).toBe(200);
    expect(await audits(q.id)).toHaveLength(0);
  });
});
