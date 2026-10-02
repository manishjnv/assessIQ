/**
 * structured_case, end to end on a real Postgres (testcontainers): an attempt mixing a
 * structured_case + subjective. The candidate view never carries the answer key; a bad answer
 * shape is rejected at save; submit scores the case deterministically (no AI), the attempt waits
 * for the subjective one, and a blank case answer scores 0 without ever needing AI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent, getAttemptForCandidate, saveAnswer, submitAttempt } from "../service.js";

let container: StartedTestContainer;
let url: string;
let tenant: string;
let admin: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_scase" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_scase`;

  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-scase','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aescase.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const CASE = {
  title: "Brute force",
  context: "Review the log.",
  log_excerpt: "10:01 failed logon admin",
  steps: [
    { id: "s1", prompt: "Which lines?", select: "many", options: ["l1", "l2", "l3"], correct: [0, 1] },
    { id: "s2", prompt: "Next?", select: "one", options: ["Block", "Ignore"], correct: [0] },
  ],
  scoring: "partial",
  explanation: "SECRET-WHY",
};

interface Seeded {
  assessmentId: string;
  ids: { scase: string; subjective?: string };
}

async function seed(withSubjective: boolean): Promise<Seeded> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessmentId = randomUUID();
  const specs: Array<{ key: "scase" | "subjective"; type: string; content: unknown }> = [
    { key: "scase", type: "structured_case", content: CASE },
  ];
  if (withSubjective) specs.push({ key: "subjective", type: "subjective", content: { question: "Explain why" } });
  const ids: Record<string, string> = {};
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,$3,60)`,
      [level, pack, specs.length],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',$5,$6)`,
      [assessmentId, tenant, pack, level, specs.length, admin],
    );
    for (const s of specs) {
      const id = randomUUID();
      const content = JSON.stringify(s.content);
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [id, pack, level, s.type, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [id, content, admin]);
      ids[s.key] = id;
    }
  });
  return { assessmentId, ids: ids as Seeded["ids"] };
}

async function candidateAttempt(assessmentId: string): Promise<{ userId: string; attemptId: string }> {
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [userId, tenant, `c-${randomUUID().slice(0, 8)}@aescase.test`],
    );
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, status, invited_by)
       VALUES ($1,$2,$3, now() + interval '1 day', 'pending', $4)`,
      [assessmentId, userId, randomUUID(), admin],
    );
  });
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  const attempt = await startAttempt(tenant, { userId, assessmentId });
  return { userId, attemptId: attempt.id };
}

const gradings = (attemptId: string) =>
  sup((c) =>
    c
      .query<{ question_id: string; grader: string; status: string; e: number; m: number }>(
        `SELECT question_id, grader, status, score_earned::float e, score_max::float m FROM gradings WHERE attempt_id=$1`,
        [attemptId],
      )
      .then((r) => r.rows),
  );

const attemptStatus = (attemptId: string) =>
  sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [attemptId]).then((r) => r.rows[0].status as string));

describe("structured_case question end to end", () => {
  it("serves the case without the key, validates saves, scores deterministically, waits for the subjective one", async () => {
    const s = await seed(true);
    const { userId, attemptId } = await candidateAttempt(s.assessmentId);

    const view = await getAttemptForCandidate(tenant, attemptId, userId);
    const q = view.questions.find((x) => x.question_id === s.ids.scase)!;
    expect(q.content).toEqual({
      title: CASE.title,
      context: CASE.context,
      log_excerpt: CASE.log_excerpt,
      steps: CASE.steps.map(({ id, prompt, select, options }) => ({ id, prompt, select, options })), // authored order, not shuffled
    });
    expect(JSON.stringify(view)).not.toMatch(/"correct"|SECRET-WHY|explanation|option_order/);

    // Bad shapes are rejected at save with the same 400 as the scenario check.
    for (const bad of [{ steps: { ghost: [0] } }, { steps: { s1: [3] } }, { steps: { s1: [0.5] } }, { selected: 1 }, "text"]) {
      await expect(
        saveAnswer(tenant, userId, { attemptId, questionId: s.ids.scase, answer: bad, client_revision: 0 }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ details: { param: "answer" } });
    }

    // s1 half right (one of two correct), s2 right -> partial: (0.5 + 1) / 2 = 0.75 -> 7.5 of 10.
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.scase, answer: { steps: { s1: [0], s2: [0] } }, client_revision: 0 });
    const stored = await sup((c) =>
      c.query(`SELECT answer FROM attempt_answers WHERE attempt_id=$1 AND question_id=$2`, [attemptId, s.ids.scase]).then((r) => r.rows[0].answer),
    );
    expect(stored).toEqual({ steps: { s1: [0], s2: [0] } });
    const view2 = await getAttemptForCandidate(tenant, attemptId, userId);
    expect(view2.answers.find((a) => a.question_id === s.ids.scase)!.answer).toEqual({ steps: { s1: [0], s2: [0] } });

    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.subjective!, answer: { response: "because" }, client_revision: 0 });
    await submitAttempt(tenant, userId, attemptId);

    const byQ = new Map((await gradings(attemptId)).map((r) => [r.question_id, r]));
    expect(byQ.get(s.ids.scase)).toMatchObject({ grader: "deterministic", e: 7.5, m: 10 });
    expect(byQ.has(s.ids.subjective!)).toBe(false);
    expect(await attemptStatus(attemptId)).toBe("submitted");

    const nonMcq = await sup((c) =>
      c
        .query<{ n: number }>(
          `SELECT COUNT(*) FILTER (WHERE q.type NOT IN ('mcq', 'numeric', 'multi_select', 'ordering', 'structured_case'))::int AS n
             FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id=$1`,
          [attemptId],
        )
        .then((r) => r.rows[0]!.n),
    );
    expect(nonMcq).toBe(1);
  });

  it("a blank case answer scores 0 and the attempt still auto-grades with no AI", async () => {
    const s = await seed(false);
    const { userId, attemptId } = await candidateAttempt(s.assessmentId);
    await submitAttempt(tenant, userId, attemptId);
    const byQ = new Map((await gradings(attemptId)).map((r) => [r.question_id, r]));
    expect(byQ.get(s.ids.scase)).toMatchObject({ grader: "deterministic", status: "incorrect", e: 0, m: 10 });
    expect(await attemptStatus(attemptId)).toBe("graded");
  });

  it("all steps right scores full marks", async () => {
    const s = await seed(false);
    const { userId, attemptId } = await candidateAttempt(s.assessmentId);
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.scase, answer: { steps: { s1: [1, 0], s2: [0] } }, client_revision: 0 });
    await submitAttempt(tenant, userId, attemptId);
    const byQ = new Map((await gradings(attemptId)).map((r) => [r.question_id, r]));
    expect(byQ.get(s.ids.scase)).toMatchObject({ grader: "deterministic", status: "correct", e: 10, m: 10 });
    expect(await attemptStatus(attemptId)).toBe("graded");
  });
});
