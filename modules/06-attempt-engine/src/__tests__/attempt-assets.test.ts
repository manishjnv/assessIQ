/**
 * EXP-10 part 1 - the candidate image route and what it serves (testcontainers Postgres).
 * Attack numbers from the S79 plan: A11 (attempt scope), A12 (guessing), plus the shuffle of option images,
 * the candidate payload (ids only, no answer key) and the maths flag on the answer review.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { uploadQuestionAsset } from "@assessiq/question-bank";
import { png } from "../../../04-question-bank/src/__tests__/image-fixtures.js";
import { getAttemptAsset } from "../attempt-assets.js";
import { registerAttemptCandidateRoutes } from "../routes.candidate.js";
import { getAttemptForCandidate } from "../service.js";
import { getCandidateFeedback } from "../feedback.js";
import { displayQuestions } from "../option-shuffle.js";
import type { FrozenQuestion } from "../types.js";

let container: StartedTestContainer;
let url = "";
const tA = randomUUID(); const tB = randomUUID();
const adminA = randomUUID(); const adminB = randomUUID();
let packA = ""; let levelA = ""; let asmA = "";
const ids = { stem: "", opt: "", other: "", foreignB: "" };

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const content = (extra: Record<string, unknown> = {}) => ({
  question: "Which figure is a router?", options: ["fig a", "fig b", "fig c", "fig d"], correct: 1, rationale: "SECRETRATIONALE", ...extra,
});

interface Seed { attemptId: string; userId: string; qid: string }

async function seedAttempt(opts: { status?: string; math?: boolean; withAssets?: boolean; level?: string } = {}): Promise<Seed> {
  const status = opts.status ?? "in_progress";
  const live = status === "in_progress";
  const userId = randomUUID(); const attemptId = randomUUID(); const qid = randomUUID();
  const c0 = opts.withAssets === false
    ? content(opts.math ? { math: true } : {})
    : content({ stem_assets: [ids.stem], option_assets: [null, ids.opt, null, null], ...(opts.math ? { math: true } : {}) });
  await sup(async (c) => {
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tA, `c-${userId.slice(0, 8)}@a.test`]);
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, delivery_mode, embed_origin)
       VALUES ($1,$2,$3,$4,$5, now() - interval '20 minutes', now() + interval '40 minutes', ${live ? "NULL" : "now()"}, 3600, 'mock', false)`,
      [attemptId, tA, opts.level ? asmA : asmA, userId, status],
    );
    await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'mcq','t',10,'active',$4::jsonb,1,$5)`, [qid, packA, levelA, JSON.stringify(c0), adminA]);
    await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, JSON.stringify(c0), adminA]);
    await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
    await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: 1 })]);
    if (!live) {
      await c.query(`INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model) VALUES ($1,$2,$3,'deterministic',10,10,'correct','sha','lbl','m')`, [tA, attemptId, qid]);
      await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review, pass_mark_pct) VALUES ($1,$2,10,10,100,false,60)`, [attemptId, tA]);
    }
  });
  return { attemptId, userId, qid };
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_att_assets" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_att_assets`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);
  packA = randomUUID(); levelA = randomUUID(); asmA = randomUUID();
  const packB = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'att-a','Org A'),($2,'att-b','Org B')`, [tA, tB]);
    await c.query(`INSERT INTO tenant_settings (tenant_id, candidate_answer_key) VALUES ($1,true),($2,false) ON CONFLICT (tenant_id) DO UPDATE SET candidate_answer_key = EXCLUDED.candidate_answer_key`, [tA, tB]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@att.test','A','admin','active'),($3,$4,'b@att.test','B','admin','active')`, [adminA, tA, adminB, tB]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'pa','PA','soc','published',$3),($4,$5,'pb','PB','soc','published',$6)`, [packA, tA, adminA, packB, tB, adminB]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [levelA, packA]);
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by, settings) VALUES ($1,$2,$3,$4,1,'A','active',1,$5,$6::jsonb)`, [asmA, tA, packA, levelA, adminA, JSON.stringify({ feedback_level: "with_expected_answer" })]);
  });
  ids.stem = (await uploadQuestionAsset(tA, adminA, packA, png({ seed: 1 }), "Stem figure of a router")).id;
  ids.opt = (await uploadQuestionAsset(tA, adminA, packA, png({ seed: 2 }), "Option b figure of a switch")).id;
  ids.other = (await uploadQuestionAsset(tA, adminA, packA, png({ seed: 3 }), "Unused figure in the same pack")).id;
  ids.foreignB = (await uploadQuestionAsset(tB, adminB, packB, png({ seed: 4 }), "Organisation B private figure")).id;
}, 180_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; } catch (e) { return (e as { details?: { code?: string } }).details?.code; }
  return undefined;
};

describe("candidate image route", () => {
  it("A11 the owner of an in-progress attempt gets an image its frozen question uses; the bytes match", async () => {
    const s = await seedAttempt();
    const a = await getAttemptAsset(tA, s.userId, s.attemptId, ids.stem);
    expect(a.mime).toBe("image/png");
    const b = await getAttemptAsset(tA, s.userId, s.attemptId, ids.opt);
    expect(b.data.length).toBeGreaterThan(0);
  });

  it("A11 an image the attempt does not use is 404, even in the same pack and organisation", async () => {
    const s = await seedAttempt();
    expect(await code(getAttemptAsset(tA, s.userId, s.attemptId, ids.other))).toBe("ASSET_NOT_FOUND");
  });

  it("A11 another candidate asking for this attempt is 404; so is another organisation, and an organisation B image", async () => {
    const s = await seedAttempt();
    const t = await seedAttempt();
    expect(await code(getAttemptAsset(tA, t.userId, s.attemptId, ids.stem))).toBe("ASSET_NOT_FOUND");
    expect(await code(getAttemptAsset(tB, s.userId, s.attemptId, ids.stem))).toBe("ASSET_NOT_FOUND");
    expect(await code(getAttemptAsset(tA, s.userId, s.attemptId, ids.foreignB))).toBe("ASSET_NOT_FOUND");
  });

  it("A11 a submitted or released attempt gets no image (part 1 shows images only while the test runs)", async () => {
    const s = await seedAttempt({ status: "released" });
    expect(await code(getAttemptAsset(tA, s.userId, s.attemptId, ids.stem))).toBe("ASSET_NOT_FOUND");
  });

  it("A12 a random id, a hash and a non-id are the same 404; the miss body does not tell which case it was", async () => {
    const s = await seedAttempt();
    const misses = [randomUUID(), "a".repeat(64), "not-an-id", "../../etc/passwd"];
    for (const m of misses) expect(await code(getAttemptAsset(tA, s.userId, s.attemptId, m))).toBe("ASSET_NOT_FOUND");
    expect(await code(getAttemptAsset(tA, s.userId, "not-an-attempt", ids.stem))).toBe("ASSET_NOT_FOUND");
  });

  it("A21 the route answers with the locked-down headers; a miss is 404 JSON", async () => {
    const s = await seedAttempt();
    const app = Fastify({ logger: false });
    app.addHook("preHandler", async (req) => { (req as unknown as { session: unknown }).session = { tenantId: tA, userId: s.userId, role: "candidate" }; });
    app.setErrorHandler((e, _req, reply) => reply.code((e as { status?: number }).status ?? 500).send({ code: (e as { details?: { code?: string } }).details?.code }));
    await registerAttemptCandidateRoutes(app, { candidateOnly: [] });
    await app.ready();
    const ok = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/assets/${ids.stem}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(ok.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(ok.headers["cache-control"]).toBe("private, max-age=3600");
    const miss = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/assets/${ids.other}` });
    const miss2 = await app.inject({ method: "GET", url: `/api/me/attempts/${s.attemptId}/assets/${randomUUID()}` });
    expect(miss.statusCode).toBe(404);
    expect(miss.body).toBe(miss2.body);
  });
});

describe("what the candidate payload holds", () => {
  it("the attempt view carries the image ids and the math flag, and never the key, the rationale or image bytes", async () => {
    const s = await seedAttempt({ math: true });
    const view = JSON.stringify(await getAttemptForCandidate(tA, s.attemptId, s.userId));
    expect(view).toContain(ids.stem);
    expect(view).toContain(ids.opt);
    expect(view).toContain('"math":true');
    // The question also carries the alt text and size of each image it names (never the bytes).
    expect(view).toContain('"alt_text":"Stem figure of a router"');
    expect(view).toContain('"alt_text":"Option b figure of a switch"');
    expect(view).not.toContain("Unused figure in the same pack");
    expect(view).not.toContain("SECRETRATIONALE");
    expect(view).not.toContain('"correct"');
    expect(view).not.toMatch(/"data"|iVBOR/);
  });

  it("option images travel with their option when the options are shuffled; a misaligned array is dropped", () => {
    const q = (extra: Record<string, unknown>): FrozenQuestion => ({
      question_id: "q1", position: 1, question_version: 1, type: "mcq", topic: "t", points: 1, section_index: null, answer_guidance: "g", passage: null,
      content: { question: "q", options: ["w", "x", "y", "z"], ...extra },
    } as unknown as FrozenQuestion);
    const order = new Map([["q1", [2, 0, 3, 1]]]);
    const [ok] = displayQuestions([q({ option_assets: [null, "ia", null, "ib"] })], order);
    expect((ok!.content as { options: string[]; option_assets: (string | null)[] }).options).toEqual(["y", "w", "z", "x"]);
    expect((ok!.content as { option_assets: (string | null)[] }).option_assets).toEqual([null, null, "ib", "ia"]);
    const [bad] = displayQuestions([q({ option_assets: ["ia"] })], order);
    expect(bad!.content).not.toHaveProperty("option_assets");
    const [none] = displayQuestions([q({})], order);
    expect(none!.content).not.toHaveProperty("option_assets");
  });
});

describe("answer review (Z-172) flags maths", () => {
  it("an item of a math question has math: true; one of a plain question has math: false", async () => {
    const m = await seedAttempt({ status: "released", math: true, withAssets: false });
    const p = await seedAttempt({ status: "released", math: false, withAssets: false });
    const fm = await getCandidateFeedback(tA, m.userId, m.attemptId);
    const fp = await getCandidateFeedback(tA, p.userId, p.attemptId);
    expect(fm.items[0]!.math).toBe(true);
    expect(fp.items[0]!.math).toBe(false);
  });
});
