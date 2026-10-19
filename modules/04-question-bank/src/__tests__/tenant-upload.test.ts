/**
 * EXP-17 + Z-52 gap 5: organisation question upload routes, and new rows start 'in_review'.
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
import { createPack, addLevel, createQuestion } from "../service.js";

let container: StartedTestContainer;
let url: string;
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const csv = [
  "type,topic,points,level,question,options,correct,rationale,rights_status",
  'mcq,Math,1,1,What is 2+2?,"[""3"",""4""]",1,basic,original',
  'mcq,Math,1,1,What is 3+3?,"[""6"",""7""]",0,basic,original',
].join("\r\n");
const body = (extra: Record<string, unknown> = {}) => ({
  file_name: "fake.csv", format: "csv", domain: "soc",
  content_base64: Buffer.from(csv, "utf8").toString("base64"), ...extra,
});

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 10 } });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role: "admin" };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    void reply.code(err instanceof AppError ? err.status : 500).send({ error: err.message });
  });
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: [] as never });
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
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("EXP-17 tenant upload", () => {
  it("rejects a missing warranty and a missing or blocked rights_status with 400", async () => {
    const app = await buildApp(tA, uA);
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/admin/question-imports", payload: payload as object });
    expect((await post(body({ rights_status: "original" }))).statusCode).toBe(400);
    expect((await post(body({ rights_status: "original", content_warranty: false }))).statusCode).toBe(400);
    expect((await post(body({ content_warranty: true }))).statusCode).toBe(400);
    expect((await post(body({ content_warranty: true, rights_status: "scraped_raw" }))).statusCode).toBe(400);
  });

  it("commits to a tenant-private pack (tenant_upload, in_review); the other tenant cannot read it", async () => {
    const app = await buildApp(tA, uA);
    const up = await app.inject({ method: "POST", url: "/api/admin/question-imports", payload: body({ content_warranty: true, rights_status: "derived_from_source" }) });
    expect(up.statusCode).toBe(201);
    const importId = up.json().importId as string;
    expect(typeof importId).toBe("string");

    const other = await buildApp(tB, uB);
    expect((await other.inject({ method: "GET", url: `/api/admin/question-imports/${importId}` })).statusCode).toBe(404);
    expect((await other.inject({ method: "POST", url: `/api/admin/question-imports/${importId}/commit` })).statusCode).toBe(404);

    // Editing a row cannot change the uploader's origin and rights.
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/question-imports/${importId}/rows/2`, payload: { values: { rights_status: "licensed", origin: "ai_original" } } });
    expect(patched.statusCode).toBe(200);

    const done = await app.inject({ method: "POST", url: `/api/admin/question-imports/${importId}/commit` });
    expect(done.statusCode).toBe(200);
    const { packId, committed } = done.json() as { packId: string; committed: number };
    expect(committed).toBe(2);
    await sup(async (c) => {
      const rows = (await c.query(
        `SELECT q.review_state, s.origin, s.rights_status, s.tenant_id, p.tenant_id AS pack_tenant
           FROM questions q JOIN question_source s ON s.question_id = q.id JOIN question_packs p ON p.id = q.pack_id WHERE q.pack_id = $1`, [packId])).rows;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).toMatchObject({ review_state: "in_review", origin: "tenant_upload", rights_status: "derived_from_source", tenant_id: tA, pack_tenant: tA });
      }
      const imp = (await c.query(`SELECT warranty_accepted_by, warranty_accepted_at, upload_rights_status FROM question_imports WHERE id=$1`, [importId])).rows[0];
      expect(imp.warranty_accepted_by).toBe(uA);
      expect(imp.warranty_accepted_at).not.toBeNull();
      expect(imp.upload_rights_status).toBe("derived_from_source");
    });
  });

  it("serves the template", async () => {
    const app = await buildApp(tA, uA);
    expect((await app.inject({ method: "GET", url: "/api/admin/question-imports/templates/mcq?format=csv" })).statusCode).toBe(200);
  });
});

describe("Z-52 gap 5: new rows start in_review", () => {
  it("createQuestion inserts in_review; a legacy NULL row stays NULL", async () => {
    const pack = await createPack(tA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, uA);
    const level = await addLevel(tA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 5 }, uA);
    const q = await createQuestion(tA, {
      pack_id: pack.id, level_id: level.id, type: "mcq", topic: "t", points: 1,
      content: { question: "What is 2+2?", options: ["3", "4"], correct: 1, rationale: "r" },
    }, uA);
    expect(q.review_state).toBe("in_review");
    await sup(async (c) => {
      await c.query(`UPDATE questions SET review_state = NULL WHERE id = $1`, [q.id]); // simulate legacy
      expect((await c.query(`SELECT review_state FROM questions WHERE id=$1`, [q.id])).rows[0].review_state).toBeNull();
    });
  });
});
