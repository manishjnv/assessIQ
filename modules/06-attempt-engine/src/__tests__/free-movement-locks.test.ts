/**
 * FUT-4 locked blocks and FUT-7 per-question timers, in a free-movement test (whole_test_minutes).
 * DB-backed (testcontainers Postgres). Time moves by rewriting attempts.section_progress in the past.
 * Old settings (no `locked`, no `seconds_per_question`) must behave exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent, saveAnswer, toggleFlag, recordPosition } from "../service.js";
import { AE_ERROR_CODES } from "../types.js";
import { sectionTimingProblem, AssessmentSectionSchema } from "../../../05-assessment-lifecycle/src/types.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const level = randomUUID();
const domain = randomUUID();
const catX = randomUUID();
const catY = randomUUID();
const qids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function setup(settings: object): Promise<{ attemptId: string; userId: string }> {
  const assessmentId = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',4,false,$5::jsonb,$6)`,
      [assessmentId, tenant, pack, level, JSON.stringify(settings), admin],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tenant, `c-${userId}@fut.test`]);
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3, now() + interval '7 days', $4)`,
      [assessmentId, userId, `h-${userId}`, admin],
    );
  });
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  const attempt = await startAttempt(tenant, { assessmentId, userId });
  return { attemptId: attempt.id, userId };
}

async function progressOf(attemptId: string): Promise<Record<string, unknown> | null> {
  const r = await sup((c) => c.query<{ section_progress: Record<string, unknown> | null }>(`SELECT section_progress FROM attempts WHERE id = $1`, [attemptId]));
  return r.rows[0]?.section_progress ?? null;
}

/** Make a question's own clock look `seconds` old (FUT-7 expiry without sleeping). */
async function ageQuestion(attemptId: string, questionId: string, seconds: number): Promise<void> {
  const p = (await progressOf(attemptId)) as { questions: Record<string, string> };
  p.questions[questionId] = new Date(Date.now() - seconds * 1000).toISOString();
  await sup((c) => c.query(`UPDATE attempts SET section_progress = $2::jsonb WHERE id = $1`, [attemptId, JSON.stringify(p)]));
}

// Case = qids[0..1] (category X, locked block). Logic = qids[2..3] (category Y, free).
const LOCKED = {
  whole_test_minutes: 10,
  sections: [
    { name: "Case", category_ids: [catX], locked: true },
    { name: "Logic", category_ids: [catY], question_count: 2 },
  ],
};
const TIMED = {
  whole_test_minutes: 10,
  sections: [
    { name: "Case", category_ids: [catX], locked: true, seconds_per_question: 30 },
    { name: "Logic", category_ids: [catY], question_count: 2 },
  ],
};
// Same test with no new keys at all.
const OLD = {
  whole_test_minutes: 10,
  sections: [
    { name: "Case", category_ids: [catX] },
    { name: "Logic", category_ids: [catY], question_count: 2 },
  ],
};

const pick = (selected: number) => ({ selected });
const pos = (userId: string, attemptId: string, body: { section_index?: number; question_id?: string }) =>
  recordPosition(tenant, userId, attemptId, body);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_fut" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_fut`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-fut','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@fut.test','A','admin','active')`, [admin, tenant]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-fut','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,4,60)`, [level, pack]);
    await c.query(`INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1,$2,'apt','Aptitude')`, [domain, tenant]);
    await c.query(`INSERT INTO categories (id, tenant_id, domain_id, slug, name) VALUES ($1,$2,$3,'x','X'),($4,$2,$3,'y','Y')`, [catX, tenant, domain, catY]);
    const content = JSON.stringify({ question: "q", options: ["a", "b"], correct: 1, rationale: "r" });
    for (const [i, q] of qids.entries()) {
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by, domain_id, category_id)
         VALUES ($1,$2,$3,'mcq','t',1,'active',$4::jsonb,1,$5,$6,$7)`,
        [q, pack, level, content, admin, domain, i < 2 ? catX : catY],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [q, content, admin]);
    }
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("FUT-4 locked block in a free-movement test", () => {
  it("a locked block is entered, answered, left; it cannot be re-entered or changed after leaving", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    await pos(userId, attemptId, { section_index: 0 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    await pos(userId, attemptId, { section_index: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[2] as string, answer: pick(1) });
    await expect(pos(userId, attemptId, { section_index: 0 })).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_LOCKED } });
    await expect(saveAnswer(tenant, userId, { attemptId, questionId: qids[1] as string, answer: pick(0) })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_LOCKED },
    });
    await expect(toggleFlag(tenant, userId, { attemptId, questionId: qids[0] as string, flagged: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_LOCKED },
    });
    const p = (await progressOf(attemptId)) as { current: number; entered: Record<string, string> };
    expect(p.current).toBe(1);
    expect(Object.keys(p.entered)).toEqual(["0"]);
  });

  it("a first write into a locked block enters it, and a write elsewhere closes it without a position call", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[3] as string, answer: pick(1) });
    await expect(saveAnswer(tenant, userId, { attemptId, questionId: qids[1] as string, answer: pick(0) })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_LOCKED },
    });
  });

  it("an unlocked section stays free to revisit; only the locked block is closed", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    await pos(userId, attemptId, { section_index: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[2] as string, answer: pick(1) });
    await pos(userId, attemptId, { section_index: 0 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    await pos(userId, attemptId, { section_index: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[3] as string, answer: pick(0) });
    await expect(pos(userId, attemptId, { section_index: 0 })).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_LOCKED } });
  });

  it("a section index that does not exist cannot be entered", async () => {
    const { attemptId, userId } = await setup(LOCKED);
    await expect(pos(userId, attemptId, { section_index: 5 })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_NOT_ENTERABLE },
    });
  });

  it("old settings: no locked block, position calls write nothing and every section stays free", async () => {
    const { attemptId, userId } = await setup(OLD);
    await pos(userId, attemptId, { section_index: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[2] as string, answer: pick(1) });
    await pos(userId, attemptId, { section_index: 0 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    await pos(userId, attemptId, { section_index: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[3] as string, answer: pick(0) });
    expect(await progressOf(attemptId)).toBeNull();
  });

  it("locked needs free movement, and the new keys validate", () => {
    expect(sectionTimingProblem([{ minutes: 5, locked: true }], undefined)).toMatch(/whole_test_minutes/);
    expect(sectionTimingProblem([{ locked: true }], 10)).toBeNull();
    expect(AssessmentSectionSchema.safeParse({ name: "A", category_ids: [catX], locked: true }).success).toBe(true);
    expect(AssessmentSectionSchema.safeParse({ name: "A", category_ids: [catX], seconds_per_question: 5 }).success).toBe(false);
    expect(AssessmentSectionSchema.safeParse({ name: "A", category_ids: [catX], seconds_per_question: 30 }).success).toBe(true);
  });
});

describe("FUT-7 per-question timer", () => {
  it("position with a question returns when its time ends; a question without a timer returns null", async () => {
    const { attemptId, userId } = await setup(TIMED);
    const r = await pos(userId, attemptId, { question_id: qids[0] as string });
    const left = new Date(r.question_ends_at as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(25_000);
    expect(left).toBeLessThanOrEqual(30_000);
    const plain = await pos(userId, attemptId, { question_id: qids[2] as string });
    expect(plain.question_ends_at).toBeNull();
  });

  it("when the time is up the question takes no save or flag; the saved answer stands", async () => {
    const { attemptId, userId } = await setup(TIMED);
    await pos(userId, attemptId, { section_index: 0, question_id: qids[0] as string });
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    await ageQuestion(attemptId, qids[0] as string, 60);
    await expect(saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(0) })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.QUESTION_TIME_UP },
    });
    await expect(toggleFlag(tenant, userId, { attemptId, questionId: qids[0] as string, flagged: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.QUESTION_TIME_UP },
    });
    // The next question has its own clock and still takes answers.
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[1] as string, answer: pick(1) });
  });

  it("a question with no earlier view starts its clock at the first save", async () => {
    const { attemptId, userId } = await setup(TIMED);
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[1] as string, answer: pick(1) });
    await ageQuestion(attemptId, qids[1] as string, 60);
    await expect(saveAnswer(tenant, userId, { attemptId, questionId: qids[1] as string, answer: pick(0) })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.QUESTION_TIME_UP },
    });
  });

  it("old settings: no question timer, a question is never timed", async () => {
    const { attemptId, userId } = await setup(OLD);
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(1) });
    const r = await pos(userId, attemptId, { question_id: qids[0] as string });
    expect(r.question_ends_at).toBeNull();
    expect(((await progressOf(attemptId)) as { questions?: unknown } | null)?.questions).toBeUndefined();
    await saveAnswer(tenant, userId, { attemptId, questionId: qids[0] as string, answer: pick(0) });
  });
});
