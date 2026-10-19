/**
 * EXP-18 part 2: question review gate against a real Postgres. Verify, Needs fix, Withdraw, bulk
 * Verify all, audit rows with the previous state, tenant and platform isolation, imports and clones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { AppError, sha256Hex } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { createPack, addLevel, publishPack } from "../service/packs.js";
import { createQuestion, bulkImport, updateQuestion, restoreVersion } from "../service/questions.js";
import { reviewQuestion, bulkVerifyPack, getPackReview, asRetryableDeadlock } from "../service/review.js";
import { parseImportFile } from "../import/parse.js";
import { stageImport } from "../import/staging.js";
import { commitImport } from "../import/commit.js";
import { materializeSetForTenant } from "../clone.js";

const MCQ = { question: "Which port is HTTPS?", options: ["80", "443", "22", "25"], correct: 1, rationale: "HTTPS uses 443" };

let container: StartedTestContainer;
let url: string;
let tP = "";
let uP = "";
const [tA, tB, uA, uB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** The session comes from headers so one app can act as several callers. */
async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    const h = req.headers;
    (req as unknown as { session: unknown }).session = { tenantId: h["x-tenant"], userId: h["x-user"], role: h["x-role"] };
  });
  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof AppError ? err.status : 500;
    void reply.code(status).send({ error: err.message, details: (err as AppError).details });
  });
  const superAdminOnly = async (req: { session?: { role?: unknown } }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (req.session?.role !== "super_admin") return reply.code(403).send({ error: "forbidden" });
  };
  await registerQuestionBankRoutes(app, { adminOnly: [], superAdminOnly: superAdminOnly as never });
  await app.ready();
  return app;
}

type Who = { tenant: string; user: string; role: string };
const asSuper: Who = { get tenant() { return tP; }, get user() { return uP; }, role: "super_admin" };
const asA: Who = { tenant: tA, user: uA, role: "admin" };
const hdr = (w: Who) => ({ "x-tenant": w.tenant, "x-user": w.user, "x-role": w.role });

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
    await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tA]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** A pack in `tenant` with one question per given state (undefined = NULL). */
async function seed(tenant: string, user: string, states: Array<string | undefined>) {
  const pack = await createPack(tenant, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, user);
  const level = await addLevel(tenant, pack.id, { label: "L1" }, user);
  const ids: string[] = [];
  for (const [i, st] of states.entries()) {
    const q = await createQuestion(tenant, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, user);
    ids.push(q.id);
    await sup((c) => c.query(`UPDATE questions SET review_state=$2 WHERE id=$1`, [q.id, st ?? null]).then(() => undefined));
  }
  return { packId: pack.id, levelId: level.id, ids };
}

const state = (id: string) => sup(async (c) => (await c.query(`SELECT review_state, status FROM questions WHERE id=$1`, [id])).rows[0] as { review_state: string | null; status: string });
const audits = (id: string, action = "question.review_changed") =>
  sup(async (c) => (await c.query(`SELECT tenant_id, actor_user_id, actor_kind, before, after, at FROM audit_log WHERE action=$2 AND entity_id=$1 ORDER BY at, id`, [id, action])).rows);
const review = (app: Awaited<ReturnType<typeof buildApp>>, who: Who, id: string, body: unknown) =>
  app.inject({ method: "POST", url: `/api/admin/questions/${id}/review`, headers: hdr(who), payload: body as object });

describe("review actions (EXP-18 part 2)", () => {
  it("Verify sets verified and writes one audit row with who, when and the previous state; a repeat is a no-op", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    const app = await buildApp();
    const res = await review(app, asA, ids[0]!, { action: "verify" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ review_state: "verified", changed: true });
    expect((await state(ids[0]!)).review_state).toBe("verified");
    const rows = await audits(ids[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tA, actor_user_id: uA, actor_kind: "user", before: { review_state: "in_review" }, after: { review_state: "verified", bulk: false } });
    expect(rows[0].at).toBeInstanceOf(Date);

    const again = await review(app, asA, ids[0]!, { action: "verify" });
    expect(again.json()).toMatchObject({ changed: false });
    expect(await audits(ids[0]!)).toHaveLength(1);
  });

  it("Verify also works from needs_fix and from NULL", async () => {
    const { ids } = await seed(tA, uA, ["needs_fix", undefined]);
    const app = await buildApp();
    for (const id of ids) expect((await review(app, asA, id, { action: "verify" })).statusCode).toBe(200);
    expect((await audits(ids[0]!))[0].before).toEqual({ review_state: "needs_fix" });
    expect((await audits(ids[1]!))[0].before).toEqual({ review_state: null });
  });

  it("Needs fix requires a note; with a note it stores state and note", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    const app = await buildApp();
    const none = await review(app, asA, ids[0]!, { action: "needs_fix" });
    expect(none.statusCode).toBe(400);
    expect(none.json().details.code).toBe("REVIEW_NOTE_REQUIRED");
    expect((await review(app, asA, ids[0]!, { action: "needs_fix", note: "   " })).statusCode).toBe(400);
    expect((await state(ids[0]!)).review_state).toBe("in_review");

    expect((await review(app, asA, ids[0]!, { action: "needs_fix", note: "Key should be B" })).statusCode).toBe(200);
    expect((await state(ids[0]!)).review_state).toBe("needs_fix");
    expect((await audits(ids[0]!))[0]).toMatchObject({ before: { review_state: "in_review" }, after: { review_state: "needs_fix", note_id: expect.any(String) } });
    expect(JSON.stringify((await audits(ids[0]!))[0])).not.toContain("Key should be B");
  });

  it("Withdraw archives, marks rights withdrawn and audits with the previous review state; verify after is refused", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    const app = await buildApp();
    expect((await review(app, asA, ids[0]!, { action: "withdraw", note: "copyright" })).statusCode).toBe(200);
    expect((await state(ids[0]!)).status).toBe("archived");
    const src = await sup((c) => c.query(`SELECT rights_status FROM question_source WHERE question_id=$1`, [ids[0]]));
    expect(src.rows[0].rights_status).toBe("withdrawn");
    expect((await audits(ids[0]!, "question.withdrawn"))[0]).toMatchObject({ before: { status: "draft", review_state: "in_review" }, after: { rights_status: "withdrawn", note_id: expect.any(String) } });
    expect((await review(app, asA, ids[0]!, { action: "verify" })).statusCode).toBe(409);
  });

  it("rejects an unknown action and a bad id", async () => {
    const app = await buildApp();
    expect((await review(app, asA, randomUUID(), { action: "approve" })).statusCode).toBe(400);
    expect((await review(app, asA, "not-a-uuid", { action: "verify" })).statusCode).toBe(400);
    expect((await review(app, asA, randomUUID(), { action: "verify" })).statusCode).toBe(404);
  });
});

describe("bulk Verify all in this pack", () => {
  it("verifies only in_review, leaves needs_fix and disputed alone, one audit row each flagged bulk", async () => {
    const { packId, ids } = await seed(tA, uA, ["in_review", "in_review", "in_review", "needs_fix", "disputed", "verified"]);
    const app = await buildApp();
    const list = await app.inject({ method: "GET", url: `/api/admin/packs/${packId}/review?state=all`, headers: hdr(asA) });
    expect(list.json().counts).toMatchObject({ in_review: 3, needs_fix: 1, disputed: 1, verified: 1 });

    const res = await app.inject({ method: "POST", url: `/api/admin/packs/${packId}/review/verify-all`, headers: hdr(asA), payload: { confirm: true, expected_count: 3 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ verified: 3 });
    expect((await Promise.all(ids.map(async (i) => (await state(i)).review_state)))).toEqual(["verified", "verified", "verified", "needs_fix", "disputed", "verified"]);
    for (const id of ids.slice(0, 3)) {
      expect((await audits(id))[0]).toMatchObject({ actor_user_id: uA, before: { review_state: "in_review" }, after: { review_state: "verified", bulk: true, pack_id: packId } });
    }
    expect(await audits(ids[3]!)).toHaveLength(0);
  });

  it("refuses without confirm or when the count changed since the confirm step; nothing is written", async () => {
    const { packId, ids } = await seed(tA, uA, ["in_review", "in_review"]);
    const app = await buildApp();
    const post = (payload: unknown) => app.inject({ method: "POST", url: `/api/admin/packs/${packId}/review/verify-all`, headers: hdr(asA), payload: payload as object });
    expect((await post({ expected_count: 2 })).statusCode).toBe(400);
    expect((await post({ confirm: false, expected_count: 2 })).statusCode).toBe(400);
    const stale = await post({ confirm: true, expected_count: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().details).toMatchObject({ code: "REVIEW_COUNT_CHANGED", expected: 1, actual: 2 });
    expect((await state(ids[0]!)).review_state).toBe("in_review");
    expect(await audits(ids[0]!)).toHaveLength(0);
  });

  it("an empty pack with expected 0 verifies nothing", async () => {
    const { packId } = await seed(tA, uA, ["verified"]);
    await expect(bulkVerifyPack({ tenantId: tA, userId: uA, role: "admin" }, packId, 0)).resolves.toEqual({ verified: 0 });
  });
});

describe("authorization and tenant isolation", () => {
  it("an organisation admin cannot verify, flag or withdraw a platform question, nor read its review list", async () => {
    const { packId, ids } = await seed(tP, uP, ["in_review"]);
    const app = await buildApp();
    for (const body of [{ action: "verify" }, { action: "needs_fix", note: "x" }, { action: "withdraw" }]) {
      expect((await review(app, asA, ids[0]!, body)).statusCode).toBe(404); // RLS hides it
    }
    expect((await app.inject({ method: "GET", url: `/api/admin/packs/${packId}/review`, headers: hdr(asA) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/admin/packs/${packId}/review/verify-all`, headers: hdr(asA), payload: { confirm: true, expected_count: 1 } })).statusCode).toBe(404);
    expect((await state(ids[0]!)).review_state).toBe("in_review");
    expect(await audits(ids[0]!)).toHaveLength(0);
  });

  it("service check holds even if RLS were bypassed: an admin role on the platform tenant is refused", async () => {
    const { ids } = await seed(tP, uP, ["in_review"]);
    await expect(reviewQuestion({ tenantId: tP, userId: uA, role: "admin" }, ids[0]!, "verify")).rejects.toMatchObject({ status: 403 });
    await expect(bulkVerifyPack({ tenantId: tP, userId: uA, role: "admin" }, (await seed(tP, uP, ["in_review"])).packId, 1)).rejects.toMatchObject({ status: 403 });
    expect((await state(ids[0]!)).review_state).toBe("in_review");
  });

  it("a super admin verifies a platform question; a super admin session on an organisation tenant is refused", async () => {
    const { ids } = await seed(tP, uP, ["in_review"]);
    const app = await buildApp();
    expect((await review(app, asSuper, ids[0]!, { action: "verify" })).statusCode).toBe(200);
    expect((await audits(ids[0]!))[0]).toMatchObject({ tenant_id: tP, actor_user_id: uP });

    const own = await seed(tA, uA, ["in_review"]);
    expect((await review(app, { tenant: tA, user: uP, role: "super_admin" }, own.ids[0]!, { action: "verify" })).statusCode).toBe(403);
    expect((await state(own.ids[0]!)).review_state).toBe("in_review");
  });

  it("an organisation admin cannot touch another organisation's question", async () => {
    const b = await seed(tB, uB, ["in_review"]);
    const app = await buildApp();
    expect((await review(app, asA, b.ids[0]!, { action: "verify" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/admin/packs/${b.packId}/review`, headers: hdr(asA) })).statusCode).toBe(404);
    await expect(reviewQuestion({ tenantId: tA, userId: uA, role: "admin" }, b.ids[0]!, "verify")).rejects.toMatchObject({ status: 404 });
    expect((await state(b.ids[0]!)).review_state).toBe("in_review");
  });

  it("a candidate or a missing role is refused before any lookup", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    const app = await buildApp();
    expect((await review(app, { ...asA, role: "candidate" }, ids[0]!, { action: "verify" })).statusCode).toBe(403);
    expect((await review(app, { ...asA, role: "" }, ids[0]!, { action: "verify" })).statusCode).toBe(403);
    expect((await state(ids[0]!)).review_state).toBe("in_review");
  });
});

describe("review list", () => {
  it("shows the answer key, rationale and source for the open items; default filter hides verified", async () => {
    const { packId, ids } = await seed(tA, uA, ["in_review", "verified"]);
    await sup((c) => c.query(`UPDATE question_source SET source_ref='SSC CGL 2023 shift 2', rights_status='derived_from_source' WHERE question_id=$1`, [ids[0]]));
    const view = await getPackReview({ tenantId: tA, userId: uA, role: "admin" }, packId, "open", 1, 25);
    expect(view.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(view.items[0]).toMatchObject({ rights_status: "derived_from_source", source_ref: "SSC CGL 2023 shift 2" });
    expect(view.items[0]!.content).toMatchObject({ correct: 1, rationale: "HTTPS uses 443" });
    expect(view.pack.is_platform).toBe(false);
  });
});

describe("imports start in_review; clones keep the source state", () => {
  it("a committed file import and a JSON bulk import both create in_review questions", async () => {
    const data = Buffer.from(
      ["type,topic,points,level,question,options,correct,rationale,rights_status",
       'mcq,Net,1,1,Which port is HTTPS?,"[""80"",""443""]",1,HTTPS uses 443,original'].join("\r\n"),
      "utf8",
    );
    const staged = await stageImport(tA, uA, { fileName: "q.csv", fileSha256: sha256Hex(data), format: "csv", domain: "soc", packName: "Imp" }, await parseImportFile("csv", data));
    const { packId } = await commitImport(tA, uA, staged.importId, { mode: "skip-errors" });
    const rows = await sup((c) => c.query(`SELECT review_state FROM questions WHERE pack_id=$1`, [packId]));
    expect(rows.rows).toEqual([{ review_state: "in_review" }]);

    const json = Buffer.from(JSON.stringify({
      pack: { slug: `imp-${randomUUID().slice(0, 8)}`, name: "Json", domain: "soc" },
      levels: [{ position: 1, label: "L1", duration_minutes: 30, default_question_count: 1 }],
      questions: [{ level_position: 1, type: "mcq", topic: "t", points: 1, content: { ...MCQ, question: "Json Q?" } }],
    }), "utf8");
    const rep = await bulkImport(tA, json, "json", uA);
    const j = await sup((c) => c.query(`SELECT review_state FROM questions WHERE pack_id=$1`, [rep.packId]));
    expect(j.rows).toEqual([{ review_state: "in_review" }]);
  });

  it("a clone keeps the source question's state (verified stays verified, in_review stays in_review)", async () => {
    const { packId, ids } = await seed(tP, uP, ["verified", "in_review"]);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE pack_id=$1`, [packId]).then(() => undefined));
    await publishPack(tP, packId, uP);
    await materializeSetForTenant(packId, tB, uB);
    const got = await sup((c) => c.query(
      `SELECT q.source_question_id AS src, q.review_state FROM questions q JOIN question_packs p ON p.id=q.pack_id WHERE p.tenant_id=$1 AND q.source_question_id = ANY($2::uuid[])`,
      [tB, ids]));
    const by = Object.fromEntries(got.rows.map((r) => [r.src, r.review_state]));
    expect(by[ids[0]!]).toBe("verified");
    expect(by[ids[1]!]).toBe("in_review");
  });
});

describe("archived questions and edits (EXP-18 gate fixes)", () => {
  it("Verify and Needs fix refuse an archived question with 409", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [ids[0]]).then(() => undefined));
    const app = await buildApp();
    for (const body of [{ action: "verify" }, { action: "needs_fix", note: "x" }]) {
      const r = await review(app, asA, ids[0]!, body);
      expect(r.statusCode).toBe(409);
      expect(r.json().details.code).toBe("QUESTION_ARCHIVED");
    }
    expect((await state(ids[0]!)).review_state).toBe("in_review");
  });

  it("editing content of a verified question resets it to in_review with an audit row; NULL stays NULL; a topic-only edit keeps verified", async () => {
    const { ids } = await seed(tA, uA, ["verified", undefined, "verified"]);
    const newContent = { ...MCQ, question: "Edited?" };
    await updateQuestion(tA, ids[0]!, { content: newContent }, uA);
    expect((await state(ids[0]!)).review_state).toBe("in_review");
    expect((await audits(ids[0]!))[0]).toMatchObject({ actor_user_id: uA, before: { review_state: "verified" }, after: { review_state: "in_review", action: "content_edited" } });

    await updateQuestion(tA, ids[1]!, { content: newContent }, uA);
    expect((await state(ids[1]!)).review_state).toBeNull();
    expect(await audits(ids[1]!)).toHaveLength(0);

    await updateQuestion(tA, ids[2]!, { topic: "renamed" }, uA);
    expect((await state(ids[2]!)).review_state).toBe("verified");
  });
});

describe("Z-52 gap 1: Needs fix on a platform master reaches its clones", () => {
  it("clones of a flagged master become needs_fix with a system audit row; archived and unrelated clones are untouched", async () => {
    const { packId, ids } = await seed(tP, uP, ["verified", "verified"]);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE pack_id=$1`, [packId]).then(() => undefined));
    await publishPack(tP, packId, uP);
    await materializeSetForTenant(packId, tB, uB);
    const cloneOf = async (src: string) => (await sup((c) => c.query(`SELECT id, review_state FROM questions WHERE source_question_id=$1 AND id <> $1`, [src]))).rows[0] as { id: string; review_state: string };
    const c0 = await cloneOf(ids[0]!);
    const c1 = await cloneOf(ids[1]!);
    expect([c0.review_state, c1.review_state]).toEqual(["verified", "verified"]);

    await reviewQuestion({ tenantId: tP, userId: uP, role: "super_admin" }, ids[0]!, "needs_fix", "wrong key");
    expect((await state(c0.id)).review_state).toBe("needs_fix");
    expect((await state(c1.id)).review_state).toBe("verified"); // other master untouched
    const a = await sup((c) => c.query(`SELECT tenant_id, actor_kind, after FROM audit_log WHERE entity_id=$1 AND tenant_id=$2 AND action='question.review_changed'`, [ids[0], tB]));
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ actor_kind: "system", after: { review_state: "needs_fix", action: "needs_fix_propagated", clone_question_ids: [c0.id] } });

    // The caller's context is restored: a normal audit row of the master lands in the platform tenant.
    expect((await audits(ids[0]!)).some((r) => r.tenant_id === tP)).toBe(true);
  });

  it("an organisation question needs_fix touches no other tenant", async () => {
    const { ids } = await seed(tA, uA, ["verified"]);
    await reviewQuestion({ tenantId: tA, userId: uA, role: "admin" }, ids[0]!, "needs_fix", "x");
    expect((await state(ids[0]!)).review_state).toBe("needs_fix");
    expect(await sup((c) => c.query(`SELECT 1 FROM audit_log WHERE action='question.review_changed' AND entity_id=$1 AND actor_kind='system'`, [ids[0]]))).toHaveProperty("rowCount", 0);
  });
});

describe("Z-52 gap 2: restoreVersion resets a verified key", () => {
  it("restoring an older version puts verified back to in_review with an audit row; NULL stays NULL", async () => {
    const { ids } = await seed(tA, uA, ["in_review", undefined]);
    for (const id of ids) await updateQuestion(tA, id, { content: { ...MCQ, question: "Edited once?" } }, uA);
    await reviewQuestion({ tenantId: tA, userId: uA, role: "admin" }, ids[0]!, "verify");
    expect((await state(ids[0]!)).review_state).toBe("verified");

    await restoreVersion(tA, ids[0]!, 1, uA);
    expect((await state(ids[0]!)).review_state).toBe("in_review");
    expect((await audits(ids[0]!)).at(-1)).toMatchObject({ before: { review_state: "verified" }, after: { review_state: "in_review", action: "content_restored" } });

    await restoreVersion(tA, ids[1]!, 1, uA);
    expect((await state(ids[1]!)).review_state).toBeNull();
  });
});

describe("Z-52 gap 3: deadlock maps to a retryable 409", () => {
  it("asRetryableDeadlock maps 40P01 only", () => {
    const mapped = asRetryableDeadlock({ code: "40P01" }) as AppError;
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.status).toBe(409);
    expect(mapped.details).toMatchObject({ code: "DEADLOCK_RETRY", retry: true });
    expect(asRetryableDeadlock({ code: "23505" })).toEqual({ code: "23505" });
  });

  it("a real deadlock on bulk verify returns 409 DEADLOCK_RETRY and writes nothing", async () => {
    const { packId, ids } = await seed(tA, uA, ["in_review", "in_review"]);
    const [x, y] = [...ids].sort() as [string, string];
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM questions WHERE id=$1 FOR UPDATE`, [y]); // holds the later row
      const bulk = bulkVerifyPack({ tenantId: tA, userId: uA, role: "admin" }, packId, 2).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 500)); // bulk now holds x and waits for y
      const wait = other.query(`SELECT 1 FROM questions WHERE id=$1 FOR UPDATE`, [x]).catch(() => undefined); // closes the cycle
      const err = (await bulk) as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(409);
      expect(err.details).toMatchObject({ code: "DEADLOCK_RETRY" });
      await other.query("ROLLBACK").catch(() => undefined);
      await wait;
    } finally {
      await other.end();
    }
    expect((await state(x)).review_state).toBe("in_review");
    expect((await state(y)).review_state).toBe("in_review");
  }, 30_000);
});

describe("Z-52 gap 4: expected_ids pins the exact set", () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, packId: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/admin/packs/${packId}/review/verify-all`, headers: hdr(asA), payload: payload as object });

  it("same count but a different question is refused; the exact set verifies; expected_count alone still works", async () => {
    const { packId, ids } = await seed(tA, uA, ["in_review", "in_review"]);
    const extra = (await seed(tA, uA, ["in_review"])).ids[0]!;
    const app = await buildApp();
    const swapped = await post(app, packId, { confirm: true, expected_count: 2, expected_ids: [ids[0]!, extra] });
    expect(swapped.statusCode).toBe(409);
    expect(swapped.json().details).toMatchObject({ code: "REVIEW_COUNT_CHANGED", new_count: 1, gone_count: 1 });
    expect((await state(ids[0]!)).review_state).toBe("in_review");

    const subset = await post(app, packId, { confirm: true, expected_ids: [ids[0]!] });
    expect(subset.statusCode).toBe(409);

    const ok = await post(app, packId, { confirm: true, expected_ids: [ids[1]!, ids[0]!] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ verified: 2 });

    const legacy = await seed(tA, uA, ["in_review"]);
    expect((await post(app, legacy.packId, { confirm: true, expected_count: 1 })).json()).toEqual({ verified: 1 });
  });

  it("needs at least one of expected_count and expected_ids", async () => {
    const { packId } = await seed(tA, uA, ["in_review"]);
    const app = await buildApp();
    expect((await post(app, packId, { confirm: true })).statusCode).toBe(400);
    expect((await post(app, packId, { confirm: true, expected_ids: ["nope"] })).statusCode).toBe(400);
  });
});
