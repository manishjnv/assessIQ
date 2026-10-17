/**
 * EXP-2: question_source (provenance + rights) and the exam columns on questions,
 * against a real Postgres. Covers migration 0194 (backfill, idempotent re-run, grandfather),
 * RLS isolation, create paths, the publish rights gate, withdraw (route, picker, re-activation),
 * and clone / re-sync copying.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { countActiveQuestionsForLevel } from "../../../05-assessment-lifecycle/src/service/_shared.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { createPack, addLevel, publishPack, } from "../service/packs.js";
import { createQuestion, updateQuestion, bulkUpdateQuestionStatus, withdrawQuestion } from "../service/questions.js";
import * as repo from "../repository.js";
import { materializeSetForTenant, resyncSetForTenant } from "../clone.js";

const MIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "0194_question_source_and_exam_columns.sql");
const MCQ = { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "HTTPS uses 443" };

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const tA = randomUUID();
const tB = randomUUID();
const uA = randomUUID();
const uB = randomUUID();

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const source = (qid: string) =>
  sup(async (c) => (await c.query(`SELECT * FROM question_source WHERE question_id=$1`, [qid])).rows[0]);

async function buildApp(tenantId: string, userId: string) {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    (req as unknown as { session: unknown }).session = { tenantId, userId, role: req.headers["x-role"] };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ error: err.message, code: (err as AppError).details?.["code"] });
  });
  const superAdminOnly = async (req: { session?: { role?: unknown } }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ error: "forbidden" });
  };
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: superAdminOnly as never });
  await app.ready();
  return app;
}

/** A pack with one level and n MCQs created through the service (so the create path writes the source row). */
async function seedPack(tenant: string, user: string, n: number) {
  const pack = await createPack(tenant, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, user);
  const level = await addLevel(tenant, pack.id, { label: "L1" }, user);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const q = await createQuestion(tenant, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, user);
    ids.push(q.id);
  }
  return { pack, level, ids };
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
    for (const [id, slug, uid, email] of [[tA, "ta", uA, "a@x.io"], [tB, "tb", uB, "b@x.io"]] as const) {
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

describe("migration 0194 backfill", () => {
  it("writes one source row per legacy question, maps origin, is idempotent, grandfathers only on column creation", async () => {
    // Legacy-shaped rows: questions inserted with no source row (as before 0194).
    const mk = async (c: Client, tenant: string, user: string, src: string, status: string) => {
      const pack = randomUUID(); const level = randomUUID(); const q = randomUUID();
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by, source) VALUES ($1,$2,$3,'P','soc','draft',1,$4,$5)`, [pack, tenant, `s-${pack}`, user, src]);
      await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,10)`, [level, pack]);
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, created_by) VALUES ($1,$2,$3,'mcq','t',1,$4,$5::jsonb,$6)`, [q, pack, level, status, JSON.stringify(MCQ), user]);
      return q;
    };
    const ids = await sup(async (c) => ({
      authored: await mk(c, tA, uA, "authored", "active"),
      generated: await mk(c, tA, uA, "generated", "draft"),
      importCustomer: await mk(c, tA, uA, "import", "active"),
      importPlatform: await mk(c, tP, uP, "import", "active"),
    }));
    const sql = await readFile(MIG, "utf8");
    await sup(async (c) => { await c.query(sql); await c.query(sql); }); // run twice
    await sup(async (c) => {
      const total = (await c.query(`SELECT count(*)::int n FROM questions`)).rows[0].n;
      expect((await c.query(`SELECT count(*)::int n FROM question_source`)).rows[0].n).toBe(total);
      expect((await c.query(`SELECT 1 FROM questions q LEFT JOIN question_source s ON s.question_id=q.id WHERE s.id IS NULL`)).rowCount).toBe(0);
      const origin = async (q: string) => (await c.query(`SELECT origin, rights_status, content_hash, normalised_text_hash FROM question_source WHERE question_id=$1`, [q])).rows[0];
      expect(await origin(ids.authored)).toEqual({ origin: "original_human", rights_status: "original", content_hash: null, normalised_text_hash: null });
      expect((await origin(ids.generated)).origin).toBe("ai_original");
      expect((await origin(ids.importCustomer)).origin).toBe("tenant_upload");
      expect((await origin(ids.importPlatform)).origin).toBe("original_human");
      // The column already existed, so the re-run must NOT grandfather these active rows.
      expect((await c.query(`SELECT review_state FROM questions WHERE id=$1`, [ids.authored])).rows[0].review_state).toBeNull();
      // Simulate the first run on a pre-0194 database: drop the column, re-run.
      await c.query(`ALTER TABLE questions DROP COLUMN review_state`);
      await c.query(sql);
      const rs = async (q: string) => (await c.query(`SELECT review_state FROM questions WHERE id=$1`, [q])).rows[0].review_state;
      expect(await rs(ids.authored)).toBe("verified");
      expect(await rs(ids.importPlatform)).toBe("verified");
      expect(await rs(ids.generated)).toBeNull(); // draft stays unreviewed
    });
  });
});

describe("question_source RLS and create paths", () => {
  it("tenant B cannot read or write tenant A's source rows; createQuestion and AI drafts write the row", async () => {
    await sup((c) => c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [tA]));
    const { pack, level, ids } = await seedPack(tA, uA, 1);
    expect(await source(ids[0]!)).toMatchObject({ tenant_id: tA, origin: "original_human", rights_status: "original" });
    const ai = await withTenant(tA, (c) => repo.insertAiDraftQuestion(c, {
      id: randomUUID(), packId: pack.id, levelId: level.id, type: "mcq", topic: "ai", points: 1,
      content: MCQ, knowledgeBaseSources: [], createdBy: uA,
    }));
    expect(await source(ai.id)).toMatchObject({ origin: "ai_original", rights_status: "original" });
    expect(ai.review_state).toBeNull();
    expect(ai.language_primary).toBe("en");

    const seenByB = await withTenant(tB, async (c) => (await c.query(`SELECT 1 FROM question_source WHERE question_id=$1`, [ids[0]])).rowCount);
    expect(seenByB).toBe(0);
    const seenByA = await withTenant(tA, async (c) => (await c.query(`SELECT 1 FROM question_source WHERE question_id=$1`, [ids[0]])).rowCount);
    expect(seenByA).toBe(1);
    await expect(withTenant(tB, (c) => c.query(
      `INSERT INTO question_source (tenant_id, question_id, origin, rights_status) VALUES ($1,$2,'licensed','licensed')`, [tA, randomUUID()],
    ))).rejects.toThrow();
  });
});

describe("publish rights gate", () => {
  it("blocks scraped_raw and a missing row, then publishes once rights are cleared", async () => {
    const { pack, ids } = await seedPack(tA, uA, 2);
    await sup((c) => c.query(`UPDATE question_source SET rights_status='scraped_raw' WHERE question_id=$1`, [ids[0]]));
    await expect(publishPack(tA, pack.id, uA)).rejects.toMatchObject({ details: { code: "RIGHTS_NOT_CLEARED", question_ids: [ids[0]] } });
    await sup((c) => c.query(`UPDATE question_source SET rights_status='derived_from_source' WHERE question_id=$1`, [ids[0]]));
    await sup((c) => c.query(`DELETE FROM question_source WHERE question_id=$1`, [ids[1]]));
    await expect(publishPack(tA, pack.id, uA)).rejects.toMatchObject({ details: { code: "RIGHTS_NOT_CLEARED", question_ids: [ids[1]] } });
    await sup((c) => c.query(`INSERT INTO question_source (tenant_id, question_id, origin, rights_status) VALUES ($1,$2,'original_human','original')`, [tA, ids[1]]));
    expect((await publishPack(tA, pack.id, uA)).status).toBe("published");
  });

  it("allowlist: scraped_raw, metadata_only, withdrawn and missing block publish and bulk activation; licensed passes", async () => {
    const { pack, ids } = await seedPack(tA, uA, 5);
    const setRights = (q: string, r: string) => sup((c) => c.query(`UPDATE question_source SET rights_status=$2 WHERE question_id=$1`, [q, r]));
    const states = ["scraped_raw", "metadata_only", "withdrawn"];
    for (const [i, r] of states.entries()) await setRights(ids[i]!, r);
    await sup((c) => c.query(`DELETE FROM question_source WHERE question_id=$1`, [ids[3]]));
    await setRights(ids[4]!, "licensed");
    await sup((c) => c.query(`UPDATE questions SET status='ai_draft' WHERE id=ANY($1::uuid[])`, [ids]));
    await expect(publishPack(tA, pack.id, uA)).rejects.toMatchObject({ details: { code: "RIGHTS_NOT_CLEARED" } });
    // withdrawn row on an ai_draft question is still non-archived, so it blocks too
    const blocked = await withTenant(tA, (c) => repo.listRightsBlockedQuestionIds(c, pack.id));
    expect([...blocked].sort()).toEqual([ids[0]!, ids[1]!, ids[2]!, ids[3]!].sort());
    const res = await bulkUpdateQuestionStatus(tA, ids, "active", uA);
    expect(res.updated).toEqual([ids[4]]);
    // bulk-activate-drafts path
    await sup((c) => c.query(`UPDATE questions SET status='draft' WHERE pack_id=$1 AND id<>$2`, [pack.id, ids[4]]));
    const act = await withTenant(tA, (c) => repo.bulkActivateDraftQuestionsForPack(c, pack.id));
    expect(act.activated).toBe(0);
    await sup((c) => c.query(`UPDATE question_source SET rights_status='licensed' WHERE question_id=$1`, [ids[0]]));
    expect((await withTenant(tA, (c) => repo.bulkActivateDraftQuestionsForPack(c, pack.id))).activated).toBe(1);
  });
});

describe("withdraw", () => {
  it("super admin only, tenant scoped, audited, leaves the picker and cannot be re-activated", async () => {
    const { pack, level, ids } = await seedPack(tA, uA, 2);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE pack_id=$1`, [pack.id]));
    const active = () => withTenant(tA, (c) => countActiveQuestionsForLevel(c, pack.id, level.id));
    expect(await active()).toBe(2);

    const admin = await buildApp(tA, uA);
    expect((await admin.inject({ method: "POST", url: `/api/admin/super/questions/${ids[0]}/withdraw`, headers: { "x-role": "admin" } })).statusCode).toBe(403);
    const other = await buildApp(tB, uB);
    expect((await other.inject({ method: "POST", url: `/api/admin/super/questions/${ids[0]}/withdraw`, headers: { "x-role": "super_admin" } })).statusCode).toBe(404);
    expect((await admin.inject({ method: "POST", url: `/api/admin/super/questions/not-a-uuid/withdraw`, headers: { "x-role": "super_admin" } })).statusCode).toBe(400);

    const before = (await sup((c) => c.query(`SELECT version FROM question_packs WHERE id=$1`, [pack.id]))).rows[0].version;
    const res = await admin.inject({ method: "POST", url: `/api/admin/super/questions/${ids[0]}/withdraw`, headers: { "x-role": "super_admin" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ids[0], status: "archived", rights_status: "withdrawn" });
    expect(await source(ids[0]!)).toMatchObject({ rights_status: "withdrawn" });
    expect(await active()).toBe(1);
    const after = (await sup((c) => c.query(`SELECT version FROM question_packs WHERE id=$1`, [pack.id]))).rows[0].version;
    expect(after).toBe(before + 1);
    const audit = await sup((c) => c.query(`SELECT 1 FROM audit_log WHERE action='question.withdrawn' AND entity_id=$1 AND tenant_id=$2`, [ids[0], tA]));
    expect(audit.rowCount).toBe(1);

    await expect(updateQuestion(tA, ids[0]!, { status: "active" }, uA)).rejects.toMatchObject({ details: { code: "QUESTION_WITHDRAWN" } });
    expect(await active()).toBe(1);
  });

  it("is idempotent: a second withdraw leaves pack version and audit rows unchanged", async () => {
    const { pack, ids } = await seedPack(tA, uA, 1);
    const ver = async () => (await sup((c) => c.query(`SELECT version FROM question_packs WHERE id=$1`, [pack.id]))).rows[0].version;
    const audits = async () => (await sup((c) => c.query(`SELECT 1 FROM audit_log WHERE action='question.withdrawn' AND entity_id=$1`, [ids[0]]))).rowCount;
    const first = await withdrawQuestion(tA, uA, ids[0]!);
    const v1 = await ver();
    const second = await withdrawQuestion(tA, uA, ids[0]!);
    expect(second).toEqual(first);
    expect(await ver()).toBe(v1);
    expect(await audits()).toBe(1);
    await expect(withdrawQuestion(tA, uA, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe("clone and re-sync", () => {
  it("copies the source row to the clone, skips withdrawn items, and propagates a later withdrawal", async () => {
    await sup((c) => c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC') ON CONFLICT DO NOTHING`, [tP]));
    const { pack, ids } = await seedPack(tP, uP, 3);
    await sup(async (c) => {
      await c.query(`UPDATE question_source SET origin='licensed', rights_status='licensed', licence_id='LIC-1', source_ref='Paper 2019', import_id=$2, uploaded_by=$3 WHERE question_id=$1`, [ids[0], randomUUID(), uP]);
      await c.query(`UPDATE questions SET difficulty_est=4, language_primary='hi', content_i18n='{"hi":{"x":1}}' WHERE id=$1`, [ids[0]]);
    });
    const admin = await buildApp(tP, uP);
    await admin.inject({ method: "POST", url: `/api/admin/super/questions/${ids[2]}/withdraw`, headers: { "x-role": "super_admin" } });
    await publishPack(tP, pack.id, uP);

    const clone = await materializeSetForTenant(pack.id, tA, uA);
    expect(clone.questionCount).toBe(2); // the withdrawn item is skipped
    const rows = await sup(async (c) => (await c.query(
      `SELECT q.id, q.source_question_id, q.difficulty_est, q.language_primary, q.content_i18n, s.id AS sid, s.tenant_id, s.origin, s.rights_status, s.licence_id, s.source_ref, s.import_id, s.uploaded_by
         FROM questions q JOIN question_source s ON s.question_id=q.id WHERE q.pack_id=$1`, [clone.clonedPackId])).rows);
    expect(rows).toHaveLength(2);
    const c0 = rows.find((r) => r.source_question_id === ids[0])!;
    const master = await source(ids[0]!);
    expect(c0).toMatchObject({ tenant_id: tA, origin: "licensed", rights_status: "licensed", licence_id: "LIC-1", source_ref: "Paper 2019", import_id: null, uploaded_by: null, difficulty_est: 4, language_primary: "hi", content_i18n: { hi: { x: 1 } } });
    expect(c0.sid).not.toBe(master.id);
    expect(rows.every((r) => r.rights_status !== "withdrawn")).toBe(true);

    // Withdraw a master item after the clone exists, then re-sync (the withdraw bumped the pack version).
    await admin.inject({ method: "POST", url: `/api/admin/super/questions/${ids[1]}/withdraw`, headers: { "x-role": "super_admin" } });
    const res = await resyncSetForTenant(pack.id, tA, uA);
    expect(res.updated).toBe(true);
    const c1 = (await sup((c) => c.query(
      `SELECT q.status, s.rights_status FROM questions q JOIN question_source s ON s.question_id=q.id WHERE q.pack_id=$1 AND q.source_question_id=$2`, [clone.clonedPackId, ids[1]]))).rows[0];
    expect(c1).toEqual({ status: "archived", rights_status: "withdrawn" });
  });
});
