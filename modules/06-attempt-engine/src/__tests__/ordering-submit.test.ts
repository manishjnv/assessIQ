/**
 * ordering, end to end on a real Postgres (testcontainers): an attempt mixing ordering + mcq +
 * subjective. The candidate view never carries the answer key and shows the items shuffled
 * (never in the correct order); saves are stored in ORIGINAL item indexes; submit scores
 * ordering + mcq deterministically (no AI), the attempt waits for the subjective one, and
 * finalises once that one is graded. A blank ordering answer scores 0 and never needs AI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { finalizeAttemptIfComplete } from "@assessiq/scoring";
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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_ordering" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_ordering`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-ordering','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aeord.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

const ITEMS = ["Detect", "Contain", "Eradicate", "Recover"];
const ORDERING = { question: "Order the incident response steps", items: ITEMS, correct_order: [0, 1, 2, 3], scoring: "all_or_nothing", explanation: "NIST SP 800-61" };
const MCQ = { question: "2+2?", options: ["3", "4", "5", "6"], correct: 1 };

interface Seeded {
  assessmentId: string;
  ids: { ordering: string; mcq: string; subjective?: string };
}

async function seed(withSubjective: boolean): Promise<Seeded> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessmentId = randomUUID();
  const specs: Array<{ key: "ordering" | "mcq" | "subjective"; type: string; content: unknown }> = [
    { key: "ordering", type: "ordering", content: ORDERING },
    { key: "mcq", type: "mcq", content: MCQ },
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
      [userId, tenant, `c-${randomUUID().slice(0, 8)}@aeord.test`],
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

describe("ordering question end to end", () => {
  it("shows shuffled items without the key, stores original indexes, scores deterministically, finalises after the subjective grade", async () => {
    const s = await seed(true);
    const { userId, attemptId } = await candidateAttempt(s.assessmentId);

    // Candidate view: question + items only, items never in the authored (= correct) order.
    const view = await getAttemptForCandidate(tenant, attemptId, userId);
    const oq = view.questions.find((q) => q.question_id === s.ids.ordering)!;
    expect(oq.content).toEqual({ question: ORDERING.question, items: expect.any(Array) });
    const shown = (oq.content as { items: string[] }).items;
    expect([...shown].sort()).toEqual([...ITEMS].sort());
    expect(shown).not.toEqual(ITEMS);
    expect(JSON.stringify(view)).not.toMatch(/correct_order|explanation|NIST|option_order/);

    // The candidate arranges the DISPLAYED items into the right sequence (Detect, Contain, ...).
    const order = ITEMS.map((t) => shown.indexOf(t));
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.ordering, answer: { order }, client_revision: 0 });
    const stored = await sup((c) =>
      c.query(`SELECT answer FROM attempt_answers WHERE attempt_id=$1 AND question_id=$2`, [attemptId, s.ids.ordering]).then((r) => r.rows[0].answer),
    );
    expect(stored).toEqual({ order: [0, 1, 2, 3] }); // ORIGINAL indexes
    // Reload maps back to the displayed positions the candidate used.
    const view2 = await getAttemptForCandidate(tenant, attemptId, userId);
    expect(view2.answers.find((a) => a.question_id === s.ids.ordering)!.answer).toEqual({ order });
    expect((view2.questions.find((q) => q.question_id === s.ids.ordering)!.content as { items: string[] }).items).toEqual(shown);

    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.mcq, answer: { selected: 0 }, client_revision: 0 });
    // mcq may be shuffled: pick the displayed position of "4"
    const mcqShown = (view2.questions.find((q) => q.question_id === s.ids.mcq)!.content as { options: string[] }).options;
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.mcq, answer: { selected: mcqShown.indexOf("4") }, client_revision: 1 });
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.subjective!, answer: { response: "because" }, client_revision: 0 });

    await submitAttempt(tenant, userId, attemptId);

    // Ordering + mcq scored deterministically; the subjective one is still pending, so NOT finalised.
    const g = await gradings(attemptId);
    const byQ = new Map(g.map((r) => [r.question_id, r]));
    expect(byQ.get(s.ids.ordering)).toMatchObject({ grader: "deterministic", status: "correct", e: 10, m: 10 });
    expect(byQ.get(s.ids.mcq)).toMatchObject({ grader: "deterministic", status: "correct", e: 10, m: 10 });
    expect(byQ.has(s.ids.subjective!)).toBe(false);
    expect(await attemptStatus(attemptId)).toBe("submitted");

    // The only question still waiting for the evaluator is the subjective one; ordering is not AI work.
    const pending = await sup((c) =>
      c
        .query<{ type: string }>(
          `SELECT q.type FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
            WHERE aq.attempt_id=$1 AND NOT EXISTS (SELECT 1 FROM gradings g WHERE g.attempt_id=aq.attempt_id AND g.question_id=aq.question_id)`,
          [attemptId],
        )
        .then((r) => r.rows.map((x) => x.type)),
    );
    expect(pending).toEqual(["subjective"]);
    const nonMcq = await sup((c) =>
      c
        .query<{ n: number }>(
          `SELECT COUNT(*) FILTER (WHERE q.type NOT IN ('mcq', 'numeric', 'multi_select', 'ordering'))::int AS n
             FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id=$1`,
          [attemptId],
        )
        .then((r) => r.rows[0]!.n),
    );
    expect(nonMcq).toBe(1);

    // Accept a grade for the subjective question -> the shared finalizer completes the attempt.
    await sup((c) =>
      c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
         VALUES ($1,$2,$3,'admin_override',10,10,'correct','sha-ord-test','v1','m')`,
        [tenant, attemptId, s.ids.subjective],
      ),
    );
    const res = await withTenant(tenant, (c) => finalizeAttemptIfComplete(c, { tenantId: tenant, attemptId, markEvaluationReleased: true }));
    expect(res.finalized).toBe(true);
    expect(await attemptStatus(attemptId)).toBe("graded");
  });

  it("a blank or wrong ordering answer scores 0 and the attempt still auto-grades with no AI", async () => {
    const s = await seed(false);
    const { userId, attemptId } = await candidateAttempt(s.assessmentId);
    // leave ordering unanswered; answer mcq wrong
    await saveAnswer(tenant, userId, { attemptId, questionId: s.ids.mcq, answer: { selected: 0 }, client_revision: 0 });
    await submitAttempt(tenant, userId, attemptId);

    const byQ = new Map((await gradings(attemptId)).map((r) => [r.question_id, r]));
    expect(byQ.get(s.ids.ordering)).toMatchObject({ grader: "deterministic", status: "incorrect", e: 0, m: 10 });
    expect(await attemptStatus(attemptId)).toBe("graded"); // nothing left for the AI queue
  });

  it("the stored display order is never the correct order across many attempts", async () => {
    const s = await seed(false);
    for (let i = 0; i < 12; i++) {
      const { attemptId } = await candidateAttempt(s.assessmentId);
      const row = await sup((c) =>
        c.query<{ option_order: number[] | null }>(`SELECT option_order FROM attempt_questions WHERE attempt_id=$1 AND question_id=$2`, [attemptId, s.ids.ordering]).then((r) => r.rows[0]!),
      );
      expect(row.option_order).not.toBeNull();
      expect(row.option_order).not.toEqual([0, 1, 2, 3]);
    }
  });
});
