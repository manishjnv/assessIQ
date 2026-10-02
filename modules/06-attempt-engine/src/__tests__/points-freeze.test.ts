/**
 * E12 — question points are frozen per attempt (attempt_questions.points, migration 0128).
 * Editing questions.points AFTER attempt start must not change the score or the
 * candidate-facing points. DB-backed (testcontainers Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { scoreMcqForAttempt } from "@assessiq/scoring";
import { insertAttemptQuestions, listFrozenQuestionsForAttempt } from "../repository.js";

let container: StartedTestContainer;
let url: string;
const tenant = randomUUID();
const admin = randomUUID();

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_pts" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_pts`;
  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-pts','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@pts.test','A','admin','active')`, [admin, tenant]);
  });
  await setPoolForTesting(url);
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

describe("attempt_questions.points freeze (E12)", () => {
  it("startAttempt INSERT freezes points; later questions.points edits do not move score or candidate points", async () => {
    const pack = randomUUID();
    const level = randomUUID();
    const assessment = randomUUID();
    const cand = randomUUID();
    const attemptId = randomUUID();
    const qid = randomUUID();
    const content = JSON.stringify({ question: "q", options: ["a", "b"], correct: 1, rationale: "r" });
    await sup(async (c) => {
      await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${pack.slice(0, 8)}`, admin]);
      await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [level, pack]);
      await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',1,$5)`, [assessment, tenant, pack, level, admin]);
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'c@pts.test','C','candidate','active')`, [cand, tenant]);
      await c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, duration_seconds) VALUES ($1,$2,$3,$4,'submitted', now() - interval '5 minutes', 3600)`, [attemptId, tenant, assessment, cand]);
      await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'mcq','t',4,'active',$4::jsonb,1,$5)`, [qid, pack, level, content, admin]);
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
    });

    await withTenant(tenant, (c) => insertAttemptQuestions(c, attemptId, [{ questionId: qid, position: 1, questionVersion: 1 }]));
    await sup(async (c) => {
      await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,'{"selected":1}'::jsonb)`, [attemptId, qid]);
      await c.query(`UPDATE questions SET points = 9 WHERE id = $1`, [qid]); // admin edit after start
    });

    await withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId));
    const g = await sup((c) => c.query(`SELECT score_earned::float e, score_max::float m FROM gradings WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows[0]));
    expect(g).toMatchObject({ e: 4, m: 4 });
    const frozen = await withTenant(tenant, (c) => listFrozenQuestionsForAttempt(c, attemptId));
    expect(frozen[0]?.points).toBe(4);
  });
});
