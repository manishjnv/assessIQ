/**
 * Z-52 gaps 6 and 7 + EXP-12 queue: question_review_notes (append-only, RLS), Dispute, audit rows without
 * note text, propagation of Disputed to clones, review queue scope and the notes route. Real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { AppError } from "@assessiq/core";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { registerQuestionBankRoutes } from "../routes.js";
import { createPack, addLevel, publishPack } from "../service/packs.js";
import { createQuestion } from "../service/questions.js";
import { reviewQuestion, getPackReview } from "../service/review.js";
import { materializeSetForTenant } from "../clone.js";

const MCQ = { question: "What is 2 + 2?", options: ["3", "4", "5", "6"], correct: 1, rationale: "2 + 2 is 4" };

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
const asB: Who = { tenant: tB, user: uB, role: "admin" };
const hdr = (w: Who) => ({ "x-tenant": w.tenant, "x-user": w.user, "x-role": w.role });
const actor = (w: Who) => ({ tenantId: w.tenant, userId: w.user, role: w.role });

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

async function seed(tenant: string, user: string, states: Array<string | undefined>) {
  const pack = await createPack(tenant, { name: `Pack ${randomUUID().slice(0, 8)}`, domain: "soc" }, user);
  const level = await addLevel(tenant, pack.id, { label: "L1" }, user);
  const ids: string[] = [];
  for (const [i, st] of states.entries()) {
    const q = await createQuestion(tenant, { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 1, content: { ...MCQ, question: `Q ${randomUUID()}?` } }, user);
    ids.push(q.id);
    await sup((c) => c.query(`UPDATE questions SET review_state=$2 WHERE id=$1`, [q.id, st ?? null]).then(() => undefined));
  }
  return { packId: pack.id, ids };
}

const state = (id: string) => sup(async (c) => (await c.query(`SELECT review_state FROM questions WHERE id=$1`, [id])).rows[0].review_state as string | null);
const audits = (id: string, action = "question.review_changed") =>
  sup(async (c) => (await c.query(`SELECT tenant_id, actor_kind, before, after FROM audit_log WHERE action=$2 AND entity_id=$1 ORDER BY at, id`, [id, action])).rows);
const notes = (id: string) => sup(async (c) => (await c.query(`SELECT * FROM question_review_notes WHERE question_id=$1 ORDER BY created_at, id`, [id])).rows);
const review = (app: Awaited<ReturnType<typeof buildApp>>, who: Who, id: string, body: unknown) =>
  app.inject({ method: "POST", url: `/api/admin/questions/${id}/review`, headers: hdr(who), payload: body as object });

/** Run SQL as the application role inside a tenant context; always rolls back. */
async function asApp(tenant: string, sql: string, params: unknown[] = []): Promise<{ rowCount: number | null } | Error> {
  return sup(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL ROLE assessiq_app");
      await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
      return await c.query(sql, params);
    } catch (e) {
      return e as Error;
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

describe("question_review_notes table (Z-52 gap 6)", () => {
  it("is append-only for the app role: UPDATE and DELETE fail, INSERT and SELECT work", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    await reviewQuestion(actor(asA), ids[0]!, "needs_fix", "Key should be B");
    const n = (await notes(ids[0]!))[0];
    expect(n).toMatchObject({ tenant_id: tA, question_id: ids[0], state: "needs_fix", note: "Key should be B", author_user_id: uA, version: 1 });

    // assessiq_app inherits assessiq_system privileges, so the REVOKE is not the barrier: with no UPDATE or
    // DELETE policy RLS hides every row, so the statement fails or changes 0 rows.
    for (const sql of [`UPDATE question_review_notes SET note='x' WHERE id=$1`, `DELETE FROM question_review_notes WHERE id=$1`]) {
      const r = await asApp(tA, sql, [n.id]);
      expect(r instanceof Error || r.rowCount === 0).toBe(true);
    }
    const ins = await asApp(tA, `INSERT INTO question_review_notes (tenant_id, question_id, version, state, note, author_user_id) VALUES ($1,$2,1,'verified','ok',$3)`, [tA, ids[0], uA]);
    expect(ins).not.toBeInstanceOf(Error);
    expect((await asApp(tA, `SELECT 1 FROM question_review_notes WHERE id=$1`, [n.id]) as { rowCount: number }).rowCount).toBe(1);
    // The trigger also rejects an UPDATE by a superuser and a DELETE is allowed only for system or superuser.
    await expect(sup((c) => c.query(`UPDATE question_review_notes SET note='x' WHERE id=$1`, [n.id]))).rejects.toThrow(/append-only/);
    expect(await notes(ids[0]!)).toHaveLength(1);
  });

  it("RLS: another tenant cannot read or insert notes of tenant A", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    await reviewQuestion(actor(asA), ids[0]!, "needs_fix", "private reason");
    expect((await asApp(tB, `SELECT 1 FROM question_review_notes WHERE question_id=$1`, [ids[0]]) as { rowCount: number }).rowCount).toBe(0);
    const bad = await asApp(tB, `INSERT INTO question_review_notes (tenant_id, question_id, version, state, note, author_user_id) VALUES ($1,$2,1,'verified','x',$3)`, [tA, ids[0], uB]);
    expect(bad).toBeInstanceOf(Error);
  });

  it("CHECKs reject an empty note and an unknown state", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    for (const [st, note] of [["verified", "   "], ["bogus", "x"]]) {
      await expect(sup((c) => c.query(`INSERT INTO question_review_notes (tenant_id, question_id, version, state, note, author_user_id) VALUES ($1,$2,1,$3,$4,$5)`, [tA, ids[0], st, note, uA]))).rejects.toThrow();
    }
  });
});

describe("notes in the same tx, audit rows carry ids only", () => {
  it("every action stores a non-empty note and the audit row has note_id, never the text", async () => {
    const { ids } = await seed(tA, uA, ["in_review", "in_review", "in_review"]);
    await reviewQuestion(actor(asA), ids[0]!, "verify", "checked key");
    await reviewQuestion(actor(asA), ids[1]!, "dispute", "two answers fit");
    await reviewQuestion(actor(asA), ids[2]!, "withdraw", "copyright claim");
    for (const [i, st] of [[0, "verified"], [1, "disputed"], [2, "withdrawn"]] as const) {
      const rows = await notes(ids[i]!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: st, author_user_id: uA, tenant_id: tA });
      const a = (await audits(ids[i]!, st === "withdrawn" ? "question.withdrawn" : "question.review_changed"))[0];
      expect(a.after.note_id).toBe(rows[0].id);
      expect(JSON.stringify(a)).not.toMatch(/checked key|two answers fit|copyright claim/);
    }
    // No note: no note row and no note_id.
    const more = await seed(tA, uA, ["in_review"]);
    await reviewQuestion(actor(asA), more.ids[0]!, "verify");
    expect(await notes(more.ids[0]!)).toHaveLength(0);
    expect((await audits(more.ids[0]!))[0].after).not.toHaveProperty("note_id");
  });
});

describe("Dispute (Z-52 gap 7)", () => {
  it("needs a note; sets disputed; refuses archived; is not verified for the list filters", async () => {
    const { packId, ids } = await seed(tA, uA, ["verified", "verified"]);
    const app = await buildApp();
    const none = await review(app, asA, ids[0]!, { action: "dispute" });
    expect(none.statusCode).toBe(400);
    expect(none.json().details.code).toBe("REVIEW_NOTE_REQUIRED");
    expect((await review(app, asA, ids[0]!, { action: "dispute", note: "  " })).statusCode).toBe(400);
    expect(await state(ids[0]!)).toBe("verified");

    const ok = await review(app, asA, ids[0]!, { action: "dispute", note: "Option B is also right" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ review_state: "disputed", changed: true });
    expect(await state(ids[0]!)).toBe("disputed");

    const open = await getPackReview(actor(asA), packId, "open", 1, 25);
    expect(open.items.map((i) => i.id)).toEqual([ids[0]]);
    const verified = await getPackReview(actor(asA), packId, "verified", 1, 25);
    expect(verified.items.map((i) => i.id)).toEqual([ids[1]]);
    expect(verified.counts).toMatchObject({ disputed: 1, verified: 1 });

    await sup((c) => c.query(`UPDATE questions SET status='archived' WHERE id=$1`, [ids[1]]).then(() => undefined));
    const arch = await review(app, asA, ids[1]!, { action: "dispute", note: "x" });
    expect(arch.statusCode).toBe(409);
  });

  it("an organisation admin cannot dispute a platform question", async () => {
    const { ids } = await seed(tP, uP, ["verified"]);
    const app = await buildApp();
    const r = await review(app, asA, ids[0]!, { action: "dispute", note: "x" });
    expect([403, 404]).toContain(r.statusCode);
    expect(await state(ids[0]!)).toBe("verified");
    expect(await notes(ids[0]!)).toHaveLength(0);
    await expect(reviewQuestion({ tenantId: tP, userId: uA, role: "admin" }, ids[0]!, "dispute", "x")).rejects.toMatchObject({ status: 403 });
  });

  it("Disputed on a platform master reaches tenant clones with a system audit row (ids only)", async () => {
    const { packId, ids } = await seed(tP, uP, ["verified"]);
    await sup((c) => c.query(`UPDATE questions SET status='active' WHERE pack_id=$1`, [packId]).then(() => undefined));
    await publishPack(tP, packId, uP);
    await materializeSetForTenant(packId, tB, uB);
    const clone = (await sup((c) => c.query(`SELECT id FROM questions WHERE source_question_id=$1 AND id <> $1`, [ids[0]]))).rows[0].id as string;
    expect(await state(clone)).toBe("verified");

    await reviewQuestion(actor(asSuper), ids[0]!, "dispute", "wrong key per exam body");
    expect(await state(clone)).toBe("disputed");
    const a = await sup((c) => c.query(`SELECT actor_kind, after FROM audit_log WHERE entity_id=$1 AND tenant_id=$2 AND action='question.review_changed'`, [ids[0], tB]));
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ actor_kind: "system", after: { review_state: "disputed", action: "disputed_propagated", clone_question_ids: [clone] } });
    expect(JSON.stringify(a.rows[0])).not.toMatch(/wrong key per exam body/);
    expect(await notes(clone)).toHaveLength(0); // the tenant cannot read platform notes
  });
});

describe("review queue and notes route (EXP-12)", () => {
  it("scope: an org admin never sees platform rows and a super admin never sees organisation rows", async () => {
    const mine = await seed(tA, uA, ["needs_fix"]);
    const plat = await seed(tP, uP, ["disputed"]);
    const other = await seed(tB, uB, ["disputed"]);
    const app = await buildApp();
    const get = (who: Who, q = "") => app.inject({ method: "GET", url: `/api/admin/review-queue${q}`, headers: hdr(who) });
    const ids = (r: { json: () => { items: Array<{ id: string }> } }) => r.json().items.map((i) => i.id);

    const a = await get(asA);
    expect(a.statusCode).toBe(200);
    expect(ids(a)).toContain(mine.ids[0]);
    expect(ids(a)).not.toContain(plat.ids[0]);
    expect(ids(a)).not.toContain(other.ids[0]);
    const s = await get(asSuper);
    expect(ids(s)).toContain(plat.ids[0]);
    expect(ids(s)).not.toContain(mine.ids[0]);
    // A super admin session on an organisation tenant, and an admin on the platform tenant, are refused.
    expect((await get({ tenant: tA, user: uP, role: "super_admin" })).statusCode).toBe(403);
    expect((await get({ tenant: tP, user: uA, role: "admin" })).statusCode).toBe(403);
    expect((await get({ ...asA, role: "candidate" })).statusCode).toBe(403);
  });

  it("filters, counts, paging, latest_note and no answer key in the list", async () => {
    // Fresh tenant so counts are exact.
    const tC = randomUUID();
    const uC = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'tc','tc')`, [tC]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tC]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'c@x.io','Admin','admin','active')`, [uC, tC]);
      await c.query(`INSERT INTO domains (tenant_id, slug, name) VALUES ($1,'soc','SOC')`, [tC]);
    });
    const asC: Who = { tenant: tC, user: uC, role: "admin" };
    const { ids } = await seed(tC, uC, ["in_review", "verified", "disputed", "needs_fix", undefined, "needs_fix"]);
    await reviewQuestion(actor(asC), ids[2]!, "dispute", "first");
    await reviewQuestion(actor(asC), ids[2]!, "needs_fix", "second");
    await reviewQuestion(actor(asC), ids[2]!, "dispute", "third");
    await reviewQuestion(actor(asC), ids[5]!, "withdraw", "gone"); // withdrawn rows are left out
    const app = await buildApp();
    const q = async (qs: string) => (await app.inject({ method: "GET", url: `/api/admin/review-queue${qs}`, headers: hdr(asC) })).json();

    const open = await q("");
    expect(open.counts).toEqual({ in_review: 1, verified: 1, disputed: 1, needs_fix: 1, none: 1 });
    expect(open.total).toBe(3);
    expect(open.items.map((i: { id: string }) => i.id).sort()).toEqual([ids[0], ids[2], ids[3]].sort());
    const d = open.items.find((i: { id: string }) => i.id === ids[2]);
    expect(d).toMatchObject({ review_state: "disputed", pack_name: expect.any(String), type: "mcq", version: 1, latest_note: { note: "third", state: "disputed" } });
    expect(d).not.toHaveProperty("content");
    expect(d).not.toHaveProperty("rubric");
    expect(open.items.find((i: { id: string }) => i.id === ids[0]).latest_note).toBeNull();

    expect((await q("?state=none")).items.map((i: { id: string }) => i.id)).toEqual([ids[4]]);
    expect((await q("?state=verified")).total).toBe(1);
    expect((await q("?state=all&pageSize=2&page=2")).items).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/api/admin/review-queue?pageSize=101`, headers: hdr(asC) })).statusCode).toBe(400);
  });

  it("GET review-notes: newest first, own tenant only; another tenant gets 404, a platform question is hidden from an org admin", async () => {
    const { ids } = await seed(tA, uA, ["in_review"]);
    await reviewQuestion(actor(asA), ids[0]!, "needs_fix", "first note");
    await reviewQuestion(actor(asA), ids[0]!, "dispute", "second note");
    const app = await buildApp();
    const get = (who: Who, id: string) => app.inject({ method: "GET", url: `/api/admin/questions/${id}/review-notes`, headers: hdr(who) });

    const r = await get(asA, ids[0]!);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.items.map((n: { note: string }) => n.note)).toEqual(["second note", "first note"]);
    expect(body.latest).toMatchObject({ note: "second note", state: "disputed", author_user_id: uA, version: 1 });
    expect(Object.keys(body.items[0]).sort()).toEqual(["author_user_id", "created_at", "id", "note", "state", "version"]);

    expect((await get(asB, ids[0]!)).statusCode).toBe(404);
    const plat = await seed(tP, uP, ["in_review"]);
    expect((await get(asA, plat.ids[0]!)).statusCode).toBe(404);
    expect((await get(asSuper, plat.ids[0]!)).statusCode).toBe(200);
    expect((await get({ ...asA, role: "candidate" }, ids[0]!)).statusCode).toBe(403);
    expect((await get(asA, randomUUID())).statusCode).toBe(404);
    expect((await get(asA, "not-a-uuid")).statusCode).toBe(400);
  });
});
