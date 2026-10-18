/**
 * Z-42: one whole-test timer (settings.whole_test_minutes) with free movement between sections, and
 * marks per question per section (sections[].marks_per_question) frozen into attempt_questions at start.
 * DB-backed (testcontainers Postgres). Time is moved by rewriting attempts.* in the past; the code under
 * test only compares against DB-stored instants (server clock).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { scoreMcqForAttempt, getSectionScoresForAttempt } from "@assessiq/scoring";
import { startAttempt, recordTakeConsent, getAttemptForCandidate, saveAnswer, finishSection, toggleFlag } from "../service.js";
import { AE_ERROR_CODES } from "../types.js";

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

async function setup(settings: object | null): Promise<{ assessmentId: string; userId: string }> {
  const assessmentId = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',4,false,$5::jsonb,$6)`,
      [assessmentId, tenant, pack, level, JSON.stringify(settings ?? {}), admin],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tenant, `c-${userId}@z42.test`]);
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3, now() + interval '7 days', $4)`,
      [assessmentId, userId, `h-${userId}`, admin],
    );
  });
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  return { assessmentId, userId };
}

// Fixed fixtures. Each bank question is worth 1 point; the blueprint-style sections score 2 each, -0.5 per wrong.
const WHOLE = {
  whole_test_minutes: 2,
  sections: [
    { name: "Quant", category_ids: [catX] },
    { name: "Logic", category_ids: [catY], question_count: 2 },
  ],
};
const MARKED = {
  whole_test_minutes: 2,
  sections: [
    { name: "Quant", category_ids: [catX], marks_per_question: 2, negative_marks_per_question: 0.5 },
    { name: "Logic", category_ids: [catY], question_count: 2, marks_per_question: 2, negative_marks_per_question: 0.5 },
  ],
};
const PER_SECTION = {
  scoring: { negative_marks_default: 0.25 },
  sections: [
    { name: "Quant", category_ids: [catX], minutes: 1 },
    { name: "Logic", category_ids: [catY], question_count: 2, minutes: 1 },
  ],
};

async function frozen(attemptId: string): Promise<Array<{ q: string; points: number; neg: number }>> {
  const r = await sup((c) =>
    c.query<{ q: string; points: string; neg: string }>(
      `SELECT question_id q, points::text, negative_marks::text neg FROM attempt_questions WHERE attempt_id=$1 ORDER BY question_id`,
      [attemptId],
    ),
  );
  return r.rows.map((x) => ({ q: x.q, points: Number(x.points), neg: Number(x.neg) }));
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_z42" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_z42`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-z42','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@z42.test','A','admin','active')`, [admin, tenant]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-z42','P','soc','published',$3)`, [pack, tenant, admin]);
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

describe("Z-42 whole-test timer", () => {
  it("one server timer = whole_test_minutes; all sections visible; no section lock", async () => {
    const { assessmentId, userId } = await setup(WHOLE);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(attempt.duration_seconds).toBe(120);
    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections).toBeUndefined();
    expect(v.questions).toHaveLength(4);
    // Free movement: section 1 first, then section 0, then section 1 again.
    for (const i of [2, 0, 3, 1]) {
      await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[i] as string, answer: { selected: 1 } });
    }
    // 61 s in: a per-section test would have locked section 0 (1 min each); the whole-test timer does not.
    await sup((c) => c.query(`UPDATE attempts SET started_at = now() - interval '61 seconds', ends_at = now() + interval '59 seconds' WHERE id = $1`, [attempt.id]));
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[0] as string, answer: { selected: 0 } });
    await expect(finishSection(tenant, userId, attempt.id)).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_NOT_FINISHABLE } });
  });

  it("the stored ends_at survives a reload and is the only deadline: no answer after it, in any section", async () => {
    const { assessmentId, userId } = await setup(WHOLE);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    const again = await startAttempt(tenant, { assessmentId, userId }); // reload / second tab: same attempt, same ends_at
    expect(again.id).toBe(attempt.id);
    expect(new Date(again.ends_at as unknown as string).getTime()).toBe(new Date(attempt.ends_at as unknown as string).getTime());
    // Server comparison: 1 ms past ends_at is rejected for both sections; still-open time is accepted.
    await sup((c) => c.query(`UPDATE attempts SET ends_at = now() + interval '30 seconds' WHERE id = $1`, [attempt.id]));
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[3] as string, answer: { selected: 1 } });
    await sup((c) => c.query(`UPDATE attempts SET started_at = now() - interval '121 seconds', ends_at = now() - interval '1 millisecond' WHERE id = $1`, [attempt.id]));
    for (const i of [0, 3]) {
      await expect(
        saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[i] as string, answer: { selected: 1 } }),
      ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.TIMER_EXPIRED } });
    }
  });

  it("flagging obeys the same deadline: 1 ms past ends_at is rejected, before it is accepted", async () => {
    const { assessmentId, userId } = await setup(WHOLE);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    const q = qids[0] as string;
    await sup((c) => c.query(`UPDATE attempts SET ends_at = now() + interval '30 seconds' WHERE id = $1`, [attempt.id]));
    await expect(toggleFlag(tenant, userId, { attemptId: attempt.id, questionId: q, flagged: true })).resolves.toMatchObject({ flagged: true });
    await sup((c) => c.query(`UPDATE attempts SET ends_at = now() - interval '1 millisecond' WHERE id = $1`, [attempt.id]));
    await expect(
      toggleFlag(tenant, userId, { attemptId: attempt.id, questionId: q, flagged: false }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.TIMER_EXPIRED } });
  });

  it("fails closed when sections are configured but unreadable (no unsectioned fallback)", async () => {
    const { assessmentId, userId } = await setup({ sections: [{ name: "Bad", minutes: -5 }] });
    await expect(startAttempt(tenant, { assessmentId, userId })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTIONS_INVALID },
    });
  });

  it("REGRESSION: per-section minutes still lock one section at a time and sum the minutes", async () => {
    const { assessmentId, userId } = await setup(PER_SECTION);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(attempt.duration_seconds).toBe(120);
    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections).toMatchObject({ current: 0, total: 2 });
    expect(v.questions).toHaveLength(2);
    await expect(
      saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[2] as string, answer: { selected: 1 } }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_LOCKED } });
  });
});

describe("Z-42 marks per question", () => {
  it("freezes section marks and penalty at start; later edits to settings or bank points change nothing", async () => {
    const { assessmentId, userId } = await setup(MARKED);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(await frozen(attempt.id)).toEqual([...qids].sort().map((q) => ({ q, points: 2, neg: 0.5 })));
    await sup(async (c) => {
      await c.query(`UPDATE assessments SET settings = jsonb_set(settings, '{sections,0,marks_per_question}', '9') WHERE id = $1`, [assessmentId]);
      await c.query(`UPDATE questions SET points = 7 WHERE id = ANY($1)`, [qids]);
    });
    expect((await frozen(attempt.id)).every((r) => r.points === 2 && r.neg === 0.5)).toBe(true);
    await sup((c) => c.query(`UPDATE questions SET points = 1 WHERE id = ANY($1)`, [qids]));
  });

  it("section totals match the blueprint: 2 per right answer, -0.5 per wrong one", async () => {
    const { assessmentId, userId } = await setup(MARKED);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    // Quant: both right. Logic: one right, one wrong. correct option index is 1.
    for (const [i, sel] of [[0, 1], [1, 1], [2, 1], [3, 0]] as const) {
      await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[i] as string, answer: { selected: sel } });
    }
    await withTenant(tenant, (c) => scoreMcqForAttempt(c, attempt.id));
    const sections = await withTenant(tenant, (c) => getSectionScoresForAttempt(c, attempt.id));
    expect(sections.map((s) => [s.name, s.earned, s.max])).toEqual([
      ["Quant", 4, 4],
      ["Logic", 1.5, 4],
    ]);
  });

  it("REGRESSION: sections without marks_per_question freeze the bank points and the assessment default penalty", async () => {
    const { assessmentId, userId } = await setup(PER_SECTION);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(await frozen(attempt.id)).toEqual([...qids].sort().map((q) => ({ q, points: 1, neg: 0.25 })));
  });

  it("REGRESSION: an assessment with no sections freezes the bank points, no penalty", async () => {
    const { assessmentId, userId } = await setup(null);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(await frozen(attempt.id)).toEqual([...qids].sort().map((q) => ({ q, points: 1, neg: 0 })));
    expect(attempt.duration_seconds).toBe(3600);
  });
});
