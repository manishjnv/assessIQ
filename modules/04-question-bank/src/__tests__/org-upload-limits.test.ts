/**
 * EXP-17: organisation upload rules - formats, generated licence id, source note, plan limits from plan data.
 * Real Postgres. Fake questions only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@assessiq/core";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@assessiq/core", async (orig) => {
  const a = await orig<typeof import("@assessiq/core")>();
  return { ...a, config: new Proxy(a.config, { get: (t, k, r) => (k === "PLAN_TIERS_ENFORCED" ? flag.on : Reflect.get(t, k, r)) }) };
});

import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { updateTenantPlan } from "@assessiq/billing";

let container: StartedTestContainer;
let url: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let seq = 5000;
const csv = (rows = 2) => {
  const n = seq++;
  const lines = ["type,topic,points,level,question,options,correct,rationale,rights_status"];
  for (let i = 0; i < rows; i++) lines.push(`mcq,Math,1,1,What is ${n} + ${i + 2}?,"[""x"",""y""]",1,basic,original`);
  return lines.join("\r\n");
};
const body = (extra: Record<string, unknown> = {}, rows = 2) => ({
  file_name: "fake.csv", format: "csv", domain: "soc", content_warranty: true, rights_status: "original",
  content_base64: Buffer.from(csv(rows), "utf8").toString("base64"), ...extra,
});

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role: "admin" };
  });
  app.setErrorHandler((err: Error & { details?: Record<string, unknown> }, _req, reply) => {
    void reply.code(err instanceof AppError ? err.status : 500).send({ error: err.message, code: err.details?.["code"], details: err.details });
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] as never });
  await app.ready();
  return app;
}
type App = Awaited<ReturnType<typeof buildApp>>;

async function newTenant(tier: string | null, over: Record<string, number> = {}): Promise<{ t: string; u: string; app: App }> {
  const t = randomUUID();
  const u = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [t, `t${t.slice(0, 8)}`]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [t]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [u, t, `a${u.slice(0, 8)}@x.io`]);
    await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [t]);
    await c.query(`DELETE FROM tenant_plans WHERE tenant_id = $1`, [t]);
    if (tier !== null) await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,$2,100)`, [t, tier]);
    for (const [col, v] of Object.entries(over)) await c.query(`UPDATE tenant_plans SET ${col} = $2 WHERE tenant_id = $1`, [t, v]);
  });
  return { t, u, app: await buildApp(t, u) };
}
const setOver = (t: string, col: string, v: number | null) =>
  sup((c) => c.query(`UPDATE tenant_plans SET ${col} = $2 WHERE tenant_id = $1`, [t, v]));
const stage = (app: App, extra: Record<string, unknown> = {}, rows = 2) =>
  app.inject({ method: "POST", url: "/api/admin/question-imports", payload: body(extra, rows) });
const commit = (app: App, id: string) => app.inject({ method: "POST", url: `/api/admin/question-imports/${id}/commit` });

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
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("EXP-17 formats, licence id, source note", () => {
  it("refuses gift, aiken and qti for an organisation upload with 400 IMPORT_FORMAT_NOT_ALLOWED_FOR_ORG", async () => {
    const { app } = await newTenant("pro");
    for (const format of ["gift", "aiken", "qti"]) {
      const r = await stage(app, { format });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("IMPORT_FORMAT_NOT_ALLOWED_FOR_ORG");
    }
    expect((await stage(app)).statusCode).toBe(201);
  });

  it("generates one licence id per upload, stores it on every question, ignores a client value, and lists it", async () => {
    const { t, app } = await newTenant("pro");
    const ids: string[] = [];
    for (const n of [0, 1]) {
      const up = await stage(app, { licence_id: "ORG-evil", source_note: n === 0 ? "From our 2025 mock book" : undefined });
      const id = up.json().importId as string;
      expect((await commit(app, id)).statusCode).toBe(200);
      ids.push(id);
    }
    const lic: string[] = [];
    await sup(async (c) => {
      for (const id of ids) {
        const r = (await c.query<{ licence_id: string }>(`SELECT licence_id FROM question_source WHERE import_id = $1`, [id])).rows;
        expect(r).toHaveLength(2);
        expect(new Set(r.map((x) => x.licence_id)).size).toBe(1);
        lic.push(r[0]!.licence_id);
      }
    });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    for (const l of lic) expect(l).toMatch(new RegExp(`^ORG-${t.replace(/-/g, "").slice(0, 8)}-${day}-[A-Z2-7]{6}$`));
    expect(lic[0]).not.toBe(lic[1]);
    const list = (await app.inject({ method: "GET", url: "/api/admin/question-imports" })).json() as { items: { id: string; licence_id: string; source_note: string | null }[] };
    expect(list.items.find((i) => i.id === ids[0])).toMatchObject({ licence_id: lic[0], source_note: "From our 2025 mock book" });
    expect(list.items.find((i) => i.id === ids[1])).toMatchObject({ licence_id: lic[1], source_note: null });
  });

  it("rejects a source note longer than 500 characters", async () => {
    const { app } = await newTenant("pro");
    expect((await stage(app, { source_note: "x".repeat(501) })).statusCode).toBe(400);
    expect((await stage(app, { source_note: "x".repeat(500) })).statusCode).toBe(201);
  });
});

describe("EXP-17 plan limits (plan data)", () => {
  it("seed: free 0/0/0, pro 2000/20/10000, enterprise and internal unlimited; getUploadLimits applies overrides", async () => {
    await sup(async (c) => {
      const r = (await c.query(`SELECT tier, upload_max_per_upload a, upload_per_month b, upload_max_total c FROM plan_tier_limits ORDER BY tier`)).rows;
      const by = Object.fromEntries(r.map((x) => [x.tier, [x.a, x.b, x.c]]));
      expect(by["free"]).toEqual([0, 0, 0]);
      expect(by["starter"]).toEqual([500, 5, 2000]);
      expect(by["pro"]).toEqual([2000, 20, 10000]);
      expect(by["enterprise"]).toEqual([null, null, null]);
      expect(by["internal"]).toEqual([null, null, null]);
    });
    const { app, t } = await newTenant("pro", { upload_per_month_override: 3 });
    await setOver(t, "upload_max_total_override", 77);
    const view = (await app.inject({ method: "GET", url: "/api/admin/question-imports" })).json();
    expect(view.limits).toEqual({ perUpload: 2000, perMonth: 3, total: 77 });
    expect(view.usage).toEqual({ uploads_this_month: 0, questions_total: 0 });
  });

  it("EXP-17: a super-admin plan update (updateTenantPlan) sets overrides and the upload screen limits follow", async () => {
    const { app, t, u } = await newTenant("pro");
    await updateTenantPlan(u, t, { uploadMaxPerUploadOverride: 11, uploadPerMonthOverride: 2, uploadMaxTotalOverride: 99 });
    let view = (await app.inject({ method: "GET", url: "/api/admin/question-imports" })).json();
    expect(view.limits).toEqual({ perUpload: 11, perMonth: 2, total: 99 });
    await updateTenantPlan(u, t, { uploadMaxPerUploadOverride: null });
    view = (await app.inject({ method: "GET", url: "/api/admin/question-imports" })).json();
    expect(view.limits).toEqual({ perUpload: 2000, perMonth: 2, total: 99 });
  });

  it("flag off: nothing is blocked (even Free), limits and usage are still returned", async () => {
    flag.on = false;
    const { app } = await newTenant("free");
    const up = await stage(app);
    expect(up.statusCode).toBe(201);
    expect((await commit(app, up.json().importId)).statusCode).toBe(200);
    const view = (await app.inject({ method: "GET", url: "/api/admin/question-imports" })).json();
    expect(view.tiers_enforced).toBe(false);
    expect(view.limits).toEqual({ perUpload: 0, perMonth: 0, total: 0 });
    expect(view.usage).toEqual({ uploads_this_month: 1, questions_total: 2 });
  });

  it("flag on: Free and a missing plan row get 403 UPLOAD_NOT_IN_PLAN", async () => {
    flag.on = true;
    try {
      for (const tier of ["free", null]) {
        const { app } = await newTenant(tier);
        const r = await stage(app);
        expect(r.statusCode).toBe(403);
        expect(r.json().code).toBe("UPLOAD_NOT_IN_PLAN");
      }
    } finally { flag.on = false; }
  });

  it("flag on: per-upload limit gives 422 UPLOAD_TOO_LARGE_FOR_PLAN with limit and rows", async () => {
    flag.on = true;
    try {
      const { app } = await newTenant("pro", { upload_max_per_upload_override: 3 });
      expect((await stage(app, {}, 3)).statusCode).toBe(201);
      const r = await stage(app, {}, 4);
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ code: "UPLOAD_TOO_LARGE_FOR_PLAN", details: { code: "UPLOAD_TOO_LARGE_FOR_PLAN", limit: 3, rows: 4 } });
    } finally { flag.on = false; }
  });

  it("flag on: month limit gives 409 UPLOAD_MONTH_LIMIT; tenant B is not affected", async () => {
    flag.on = true;
    try {
      const a = await newTenant("pro", { upload_per_month_override: 1 });
      const b = await newTenant("pro", { upload_per_month_override: 1 });
      const id = (await stage(a.app)).json().importId as string;
      expect((await commit(a.app, id)).statusCode).toBe(200);
      const r = await stage(a.app);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ code: "UPLOAD_MONTH_LIMIT", details: { limit: 1 } });
      expect((await stage(b.app)).statusCode).toBe(201); // B still has its own month
    } finally { flag.on = false; }
  });

  it("flag on: total limit gives 409 UPLOAD_TOTAL_LIMIT with limit, current, rows; withdrawn questions do not count", async () => {
    flag.on = true;
    try {
      const { app } = await newTenant("pro", { upload_max_total_override: 5 });
      const id = (await stage(app)).json().importId as string;
      expect((await commit(app, id)).statusCode).toBe(200);
      const id2 = (await stage(app)).json().importId as string;
      expect((await commit(app, id2)).statusCode).toBe(200); // 4 in total
      const r = await stage(app, {}, 2);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ code: "UPLOAD_TOTAL_LIMIT", details: { limit: 5, current: 4, rows: 2 } });
      expect((await app.inject({ method: "POST", url: `/api/admin/question-imports/${id}/withdraw` })).statusCode).toBe(200);
      expect((await stage(app, {}, 2)).statusCode).toBe(201); // 2 live + 2 = 4 <= 5
    } finally { flag.on = false; }
  });

  it("flag on: the limit is checked again at commit (plan lowered after staging)", async () => {
    flag.on = true;
    try {
      const { app, t } = await newTenant("pro");
      const id = (await stage(app)).json().importId as string;
      await setOver(t, "upload_max_per_upload_override", 1);
      const r = await commit(app, id);
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("UPLOAD_TOO_LARGE_FOR_PLAN");
      await sup(async (c) => expect((await c.query(`SELECT status FROM question_imports WHERE id = $1`, [id])).rows[0].status).toBe("staged"));
    } finally { flag.on = false; }
  });

  it("flag on: two parallel commits cannot both pass the month limit", async () => {
    flag.on = true;
    try {
      const { app } = await newTenant("pro", { upload_per_month_override: 1 });
      const id1 = (await stage(app)).json().importId as string;
      const id2 = (await stage(app)).json().importId as string;
      const codes = (await Promise.all([commit(app, id1), commit(app, id2)])).map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
    } finally { flag.on = false; }
  });

  it("the app role cannot change plan limits (tenant_plans overrides or plan_tier_limits)", async () => {
    const { t } = await newTenant("pro");
    await sup(async (c) => {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE assessiq_app");
      await c.query("SELECT set_config('app.current_tenant', $1, true)", [t]);
      const u = await c.query(`UPDATE tenant_plans SET upload_per_month_override = 9999 WHERE tenant_id = $1`, [t]);
      expect(u.rowCount).toBe(0);
      await c.query("ROLLBACK");
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE assessiq_app");
      await expect(c.query(`UPDATE plan_tier_limits SET upload_max_total = NULL WHERE tier = 'pro'`)).rejects.toThrow(/read-only for the app role/);
      await c.query("ROLLBACK");
      expect((await c.query(`SELECT upload_per_month_override FROM tenant_plans WHERE tenant_id = $1`, [t])).rows[0].upload_per_month_override).toBeNull();
    });
  });

  it("migrations 0252 and 0253 are idempotent and never reset a changed number", async () => {
    const m252 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "19-billing", "migrations", "0252_plan_tier_limits_upload.sql"), "utf8");
    const m253 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0253_question_imports_source_note.sql"), "utf8");
    await sup(async (c) => {
      await c.query(`UPDATE plan_tier_limits SET upload_per_month = 21 WHERE tier = 'pro'`);
      await c.query(m252);
      await c.query(m253);
      expect((await c.query(`SELECT upload_per_month FROM plan_tier_limits WHERE tier = 'pro'`)).rows[0].upload_per_month).toBe(21);
      await c.query(`UPDATE plan_tier_limits SET upload_per_month = 20 WHERE tier = 'pro'`);
    });
  });
});
