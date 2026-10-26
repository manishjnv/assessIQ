/**
 * EXP-28: a candidate reports a problem with a question. DB-backed (testcontainers Postgres, all migrations).
 * A report is stored once per attempt and question, only the attempt owner can send it, it never changes the
 * attempt, and the EXP-12 review queue (module 04) shows the count and a "reported" filter.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { startAttempt, recordTakeConsent } from "../service.js";
import { reportQuestion, MAX_REPORTS_PER_ATTEMPT } from "../report.js";
import { AE_ERROR_CODES } from "../types.js";
import { listReviewQueue } from "../../../04-question-bank/src/service/review.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();
const pack = randomUUID();
const level = randomUUID();
const qids = [randomUUID(), randomUUID(), randomUUID()];

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function setup(): Promise<{ attemptId: string; userId: string }> {
  const assessmentId = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, randomize, settings, created_by)
       VALUES ($1,$2,$3,$4,1,'A','active',3,false,'{}'::jsonb,$5)`,
      [assessmentId, tenant, pack, level, admin],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`, [userId, tenant, `c-${userId}@rep.test`]);
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

const rows = (attemptId: string) =>
  sup(async (c) => (await c.query<{ question_id: string; reason: string; note: string | null }>(`SELECT question_id, reason, note FROM question_reports WHERE attempt_id = $1`, [attemptId])).rows);

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_rep" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_rep`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-rep','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@rep.test','A','admin','active')`, [admin, tenant]);
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,'p-rep','P','soc','published',$3)`, [pack, tenant, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,3,60)`, [level, pack]);
    const content = JSON.stringify({ question: "q", options: ["a", "b"], correct: 1, rationale: "r" });
    for (const q of qids) {
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by)
         VALUES ($1,$2,$3,'mcq','t',1,'active',$4::jsonb,1,$5)`,
        [q, pack, level, content, admin],
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

describe("EXP-28 reportQuestion", () => {
  it("stores one report per attempt and question; a second report changes it, it does not add a row", async () => {
    const { attemptId, userId } = await setup();
    await reportQuestion(tenant, userId, { attemptId, questionId: qids[0] as string, reason: "unclear" });
    await reportQuestion(tenant, userId, { attemptId, questionId: qids[0] as string, reason: "wrong_answer", note: "  Option B is also right  " });
    expect(await rows(attemptId)).toEqual([{ question_id: qids[0], reason: "wrong_answer", note: "Option B is also right" }]);
    const attempt = await sup(async (c) => (await c.query<{ status: string }>(`SELECT status FROM attempts WHERE id = $1`, [attemptId])).rows[0]);
    expect(attempt?.status).toBe("in_progress"); // a report never changes the attempt
  });

  it("refuses another candidate's attempt, a question outside the attempt, a bad reason and a long note", async () => {
    const { attemptId, userId } = await setup();
    await expect(reportQuestion(tenant, randomUUID(), { attemptId, questionId: qids[0] as string, reason: "other" })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER },
    });
    await expect(reportQuestion(tenant, userId, { attemptId, questionId: randomUUID(), reason: "other" })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.UNKNOWN_QUESTION },
    });
    await expect(reportQuestion(tenant, userId, { attemptId, questionId: qids[0] as string, reason: "spam" as never })).rejects.toMatchObject({
      details: { param: "reason" },
    });
    await expect(reportQuestion(tenant, userId, { attemptId, questionId: qids[0] as string, reason: "other", note: "x".repeat(501) })).rejects.toMatchObject({
      details: { param: "note" },
    });
    expect(await rows(attemptId)).toEqual([]);
  });

  it("caps the reports per attempt but still lets the candidate change one already sent", async () => {
    const { attemptId, userId } = await setup();
    await reportQuestion(tenant, userId, { attemptId, questionId: qids[1] as string, reason: "unclear" });
    await sup(async (c) => {
      for (let i = 1; i < MAX_REPORTS_PER_ATTEMPT; i += 1) {
        await c.query(`INSERT INTO question_reports (tenant_id, attempt_id, question_id, user_id, reason) VALUES ($1,$2,$3,$4,'other')`, [tenant, attemptId, randomUUID(), userId]);
      }
    });
    await expect(reportQuestion(tenant, userId, { attemptId, questionId: qids[2] as string, reason: "other" })).rejects.toMatchObject({ details: { param: "question_id" } });
    await expect(reportQuestion(tenant, userId, { attemptId, questionId: qids[1] as string, reason: "wrong_answer" })).resolves.toEqual({ reported: true });
  });

  it("the review queue counts the reports and the reported filter lists only reported questions", async () => {
    const { attemptId, userId } = await setup();
    await reportQuestion(tenant, userId, { attemptId, questionId: qids[2] as string, reason: "wrong_answer" });
    const q = await listReviewQueue({ tenantId: tenant, userId: admin, role: "admin" }, "reported", 1, 25);
    expect(q.reported).toBeGreaterThanOrEqual(1);
    expect(q.items.every((i) => i.report_count > 0)).toBe(true);
    const item = q.items.find((i) => i.id === qids[2]);
    expect(item?.report_count).toBeGreaterThanOrEqual(1);
    const all = await listReviewQueue({ tenantId: tenant, userId: admin, role: "admin" }, "all", 1, 25);
    expect(all.items.find((i) => i.id === qids[0])?.report_count).toBeGreaterThanOrEqual(0);
  });
});
