/**
 * Test sections (migration 0132): per-section server-authoritative deadlines.
 * DB-backed (testcontainers Postgres). Time is moved by rewriting attempts.* in the
 * past — the code under test only ever compares against the DB-stored instants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import {
  startAttempt,
  recordTakeConsent,
  getAttemptForCandidate,
  saveAnswer,
  finishSection,
} from "../service.js";
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

/** New active assessment + invited candidate; returns ids. */
async function setup(settings: object | null): Promise<{ assessmentId: string; userId: string }> {
  const assessmentId = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',4,false,$5::jsonb,$6)`,
      [assessmentId, tenant, pack, level, JSON.stringify(settings ?? {}), admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [userId, tenant, `c-${userId}@sec.test`],
    );
    await c.query(
      `INSERT INTO assessment_invitations (assessment_id, user_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3, now() + interval '7 days', $4)`,
      [assessmentId, userId, `h-${userId}`, admin],
    );
  });
  await recordTakeConsent(tenant, { userId, ip: null, userAgent: null });
  return { assessmentId, userId };
}

const SECTIONS = [
  { name: "Quantitative", category_ids: [catX], minutes: 1, calculator: true },
  { name: "Logical", category_ids: [catY], question_count: 2, minutes: 1 },
];

async function sectionOf(attemptId: string): Promise<Map<string, number>> {
  const r = await sup((c) =>
    c.query<{ question_id: string; section_index: number }>(
      `SELECT question_id, section_index FROM attempt_questions WHERE attempt_id = $1`,
      [attemptId],
    ),
  );
  return new Map(r.rows.map((x) => [x.question_id, x.section_index]));
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_sec" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_sec`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-sec','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@sec.test','A','admin','active')`, [admin, tenant]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-sec','P','soc','published',$3)`, [pack, tenant, admin]);
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

describe("test sections", () => {
  it("groups questions by section at start, freezes the order, total time = sum of minutes", async () => {
    const { assessmentId, userId } = await setup({ sections: SECTIONS });
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(attempt.duration_seconds).toBe(120); // level says 60 min; sections win
    const sec = await sectionOf(attempt.id);
    expect(qids.slice(0, 2).every((q) => sec.get(q) === 0)).toBe(true);
    expect(qids.slice(2).every((q) => sec.get(q) === 1)).toBe(true);

    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections).toMatchObject({ current: 0, total: 2, name: "Quantitative", calculator: true });
    expect(v.questions.map((q) => q.question_id).sort()).toEqual(qids.slice(0, 2).sort()); // section 2 hidden
    expect(v.questions.map((q) => q.position)).toEqual([1, 2]);
  });

  it("rejects an answer after the section deadline, opens the next section", async () => {
    const { assessmentId, userId } = await setup({ sections: SECTIONS });
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[0] as string, answer: { selected: 1 } });

    // Section 0 started 61 s ago -> over (overall ends_at is still ~59 s away).
    await sup((c) =>
      c.query(
        `UPDATE attempts SET section_progress = jsonb_build_object('current', 0, 'started_at', (now() - interval '61 seconds')),
                started_at = now() - interval '61 seconds', ends_at = now() + interval '59 seconds' WHERE id = $1`,
        [attempt.id],
      ),
    );
    await expect(
      saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[0] as string, answer: { selected: 0 } }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_LOCKED } });
    // Not-yet-opened/finished section questions stay rejected consistently, new section accepts.
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[2] as string, answer: { selected: 1 } });

    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections).toMatchObject({ current: 1, name: "Logical", calculator: false });
    expect(v.questions.map((q) => q.question_id).sort()).toEqual(qids.slice(2).sort());
    // Section 0's saved answer is intact.
    const kept = await sup((c) => c.query(`SELECT answer FROM attempt_answers WHERE attempt_id=$1 AND question_id=$2`, [attempt.id, qids[0]]));
    expect(kept.rows[0].answer).toEqual({ selected: 1 });
  });

  it("auto-submits when the last section ends", async () => {
    const { assessmentId, userId } = await setup({ sections: SECTIONS });
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    await sup((c) =>
      c.query(
        `UPDATE attempts SET section_progress = jsonb_build_object('current', 1, 'started_at', (now() - interval '61 seconds')),
                started_at = now() - interval '121 seconds', ends_at = now() - interval '1 second' WHERE id = $1`,
        [attempt.id],
      ),
    );
    await expect(
      saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[2] as string, answer: { selected: 1 } }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.TIMER_EXPIRED } });
    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.attempt.status).toBe("auto_submitted");
    expect(v.sections).toBeUndefined();
  });

  it("finishSection opens the next section now, re-pins ends_at, cannot go back; last section is not finishable", async () => {
    const { assessmentId, userId } = await setup({ sections: SECTIONS });
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(await finishSection(tenant, userId, attempt.id)).toEqual({ section_index: 1 });
    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections?.current).toBe(1);
    expect(v.sections?.remaining_seconds).toBeGreaterThan(55);
    // ends_at = now + section 2's minutes (60 s), not the original 120 s.
    expect(Date.parse(v.attempt.ends_at as unknown as string) - Date.now()).toBeLessThan(61_000);
    await expect(
      saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[0] as string, answer: { selected: 1 } }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.SECTION_LOCKED } });
    await expect(finishSection(tenant, userId, attempt.id)).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_NOT_FINISHABLE },
    });
  });

  it("another candidate cannot finish someone else's section", async () => {
    const a = await setup({ sections: SECTIONS });
    const b = await setup({ sections: SECTIONS });
    const attempt = await startAttempt(tenant, a);
    await expect(finishSection(tenant, b.userId, attempt.id)).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER },
    });
  });

  it("pool too small for a section fails the start with a section-named error", async () => {
    const { assessmentId, userId } = await setup({
      sections: [{ name: "Big", category_ids: [catX], question_count: 5, minutes: 5 }],
    });
    await expect(startAttempt(tenant, { assessmentId, userId })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.POOL_TOO_SMALL, section: "Big" },
    });
  });

  it("REGRESSION: assessment without sections behaves as before", async () => {
    const { assessmentId, userId } = await setup(null);
    const attempt = await startAttempt(tenant, { assessmentId, userId });
    expect(attempt.duration_seconds).toBe(3600); // level duration
    const sec = await sectionOf(attempt.id);
    expect([...sec.values()].every((s) => s === null)).toBe(true);
    const v = await getAttemptForCandidate(tenant, attempt.id, userId);
    expect(v.sections).toBeUndefined();
    expect(v.questions).toHaveLength(4);
    await saveAnswer(tenant, userId, { attemptId: attempt.id, questionId: qids[3] as string, answer: { selected: 1 } });
    await expect(finishSection(tenant, userId, attempt.id)).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.SECTION_NOT_FINISHABLE },
    });
  });
});
