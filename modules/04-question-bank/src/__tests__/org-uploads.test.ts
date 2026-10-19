/**
 * EXP-17: organisation upload list, withdraw, tenant isolation and the plan gate.
 * Real Postgres. Fake questions only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { AppError } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";

let container: StartedTestContainer;
let url: string;
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();
let tP = ""; // the seeded platform tenant (migrations create it)
const uP = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let seq = 1000;
const uniqueCsv = () => {
  const n = seq++;
  return [
    "type,topic,points,level,question,options,correct,rationale,rights_status",
    `mcq,Math,1,1,What is ${n} + 2?,"[""x"",""y""]",1,basic,original`,
    `mcq,Math,1,1,What is ${n} + 3?,"[""x"",""y""]",0,basic,original`,
  ].join("\r\n");
};
const body = (extra: Record<string, unknown> = {}) => ({
  file_name: "fake.csv", format: "csv", domain: "soc",
  content_base64: Buffer.from(uniqueCsv(), "utf8").toString("base64"), ...extra,
});

async function buildApp(tenantId: string, userId: string, guard?: never[] | unknown[], role = "admin") {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    void reply.code(err instanceof AppError ? err.status : 500).send({ error: err.message });
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] as never, ...(guard ? { orgUploadGuard: guard as never } : {}) });
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
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [uid, id, email]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [id]);
    }
    tP = (await c.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'platform'`)).rows[0]!.id;
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'p@x.io','Admin','admin','active')`, [uP, tP]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const ok = { content_warranty: true, rights_status: "original" };

async function uploadAndCommit(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const up = await app.inject({ method: "POST", url: "/api/admin/question-imports", payload: body(ok) });
  expect(up.statusCode).toBe(201);
  const id = up.json().importId as string;
  expect((await app.inject({ method: "POST", url: `/api/admin/question-imports/${id}/commit` })).statusCode).toBe(200);
  return id;
}

describe("EXP-17 list and withdraw", () => {
  it("lists only the caller's own uploads", async () => {
    const a = await buildApp(tA, uA);
    const b = await buildApp(tB, uB);
    const id = await uploadAndCommit(a);
    const la = (await a.inject({ method: "GET", url: "/api/admin/question-imports" })).json() as { items: { id: string; question_count: number; withdrawn_count: number; rights_status: string }[] };
    const mine = la.items.find((i) => i.id === id);
    expect(mine).toMatchObject({ question_count: 2, withdrawn_count: 0, rights_status: "original" });
    const lb = (await b.inject({ method: "GET", url: "/api/admin/question-imports" })).json() as { items: { id: string }[] };
    expect(lb.items.find((i) => i.id === id)).toBeUndefined();
  });

  it("withdraws every question of the import in one call, audits ids only, and is idempotent", async () => {
    const a = await buildApp(tA, uA);
    const id = await uploadAndCommit(a);
    const r1 = await a.inject({ method: "POST", url: `/api/admin/question-imports/${id}/withdraw` });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ importId: id, withdrawn: 2 });
    await sup(async (c) => {
      const q = (await c.query(
        `SELECT q.status, s.rights_status FROM question_source s JOIN questions q ON q.id = s.question_id WHERE s.import_id = $1`, [id])).rows;
      expect(q).toHaveLength(2);
      for (const r of q) expect(r).toMatchObject({ status: "archived", rights_status: "withdrawn" });
      const audit = (await c.query(`SELECT entity_id, after FROM audit_log WHERE action = 'question.withdrawn' AND entity_id IN (SELECT question_id FROM question_source WHERE import_id = $1)`, [id])).rows;
      expect(audit).toHaveLength(2);
      for (const r of audit) expect(Object.keys(r.after).sort()).toEqual(["rights_status", "status"]);
    });
    const r2 = await a.inject({ method: "POST", url: `/api/admin/question-imports/${id}/withdraw` });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().withdrawn).toBe(0);
    await sup(async (c) => {
      expect((await c.query(`SELECT 1 FROM audit_log WHERE action = 'question.withdrawn' AND entity_id IN (SELECT question_id FROM question_source WHERE import_id = $1)`, [id])).rowCount).toBe(2);
    });
    const li = (await a.inject({ method: "GET", url: "/api/admin/question-imports" })).json() as { items: { id: string; withdrawn_count: number }[] };
    expect(li.items.find((i) => i.id === id)?.withdrawn_count).toBe(2);
  });

  it("tenant B cannot withdraw tenant A's import (404) and nothing changes", async () => {
    const a = await buildApp(tA, uA);
    const b = await buildApp(tB, uB);
    const id = await uploadAndCommit(a);
    const r = await b.inject({ method: "POST", url: `/api/admin/question-imports/${id}/withdraw` });
    expect(r.statusCode).toBe(404);
    await sup(async (c) => {
      expect((await c.query(`SELECT 1 FROM question_source WHERE import_id = $1 AND rights_status = 'withdrawn'`, [id])).rowCount).toBe(0);
    });
  });

  it("a staged import cannot be withdrawn (409)", async () => {
    const a = await buildApp(tA, uA);
    const up = await a.inject({ method: "POST", url: "/api/admin/question-imports", payload: body(ok) });
    const r = await a.inject({ method: "POST", url: `/api/admin/question-imports/${up.json().importId}/withdraw` });
    expect(r.statusCode).toBe(409);
  });
});

describe("EXP-17 source reference", () => {
  it("the form-level source_ref fills every row that has none", async () => {
    const a = await buildApp(tA, uA);
    const up = await a.inject({ method: "POST", url: "/api/admin/question-imports", payload: body({ ...ok, source_ref: "Synthetic course A" }) });
    expect(up.statusCode).toBe(201);
    const id = up.json().importId as string;
    expect((await a.inject({ method: "POST", url: `/api/admin/question-imports/${id}/commit` })).statusCode).toBe(200);
    await sup(async (c) => {
      const rows = (await c.query(`SELECT source_ref FROM question_source WHERE import_id = $1`, [id])).rows;
      expect(rows.map((r) => r.source_ref)).toEqual(["Synthetic course A", "Synthetic course A"]);
    });
  });
});

describe("EXP-17 plan gate", () => {
  it("every organisation upload route runs the guard (403 when it refuses)", async () => {
    const deny = async () => { throw new AppError("Your plan does not include this feature.", "TIER_NOT_INCLUDED", 403, { details: { code: "TIER_NOT_INCLUDED" } }); };
    const app = await buildApp(tA, uA, [deny]);
    const id = randomUUID();
    const calls: [string, string][] = [
      ["POST", "/api/admin/question-imports"],
      ["GET", "/api/admin/question-imports"],
      ["GET", "/api/admin/question-imports/templates/mcq"],
      ["PATCH", `/api/admin/question-imports/${id}/rows/1`],
      ["POST", `/api/admin/question-imports/${id}/commit`],
    ];
    for (const [method, url] of calls) {
      const r = await app.inject({ method: method as "GET", url, ...(method === "GET" ? {} : { payload: {} as object }) });
      expect([method, url, r.statusCode]).toEqual([method, url, 403]);
    }
    // Gate finding 2: read, discard and withdraw stay open on a lapsed plan (takedown path).
    for (const [method, url] of [["GET", `/api/admin/question-imports/${id}`], ["POST", `/api/admin/question-imports/${id}/discard`], ["POST", `/api/admin/question-imports/${id}/withdraw`]] as const) {
      const r = await app.inject({ method, url, ...(method === "GET" ? {} : { payload: {} as object }) });
      expect([method, url, r.statusCode === 403]).toEqual([method, url, false]);
    }
  });

  it("an admin (not super_admin) of the platform tenant cannot list or withdraw (gate finding 1)", async () => {
    const admin = await buildApp(tP, uP);
    const id = randomUUID();
    expect((await admin.inject({ method: "GET", url: "/api/admin/question-imports" })).statusCode).toBe(403);
    expect((await admin.inject({ method: "POST", url: `/api/admin/question-imports/${id}/withdraw` })).statusCode).toBe(403);
    const boss = await buildApp(tP, uP, undefined, "super_admin");
    expect((await boss.inject({ method: "GET", url: "/api/admin/question-imports" })).statusCode).toBe(200);
  });
});
