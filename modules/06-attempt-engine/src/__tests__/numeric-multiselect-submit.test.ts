/**
 * An attempt made only of numeric + multi_select questions auto-grades at candidate
 * submit (deterministic, no AI), exactly like an MCQ-only attempt. Testcontainers Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { submitAttempt } from "../service.js";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_numms" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_numms`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-numms','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@numms.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

interface Q {
  type: "numeric" | "multi_select" | "subjective";
  content: unknown;
  answer?: unknown;
  points: number;
}

async function seed(qs: Q[]): Promise<{ attemptId: string; userId: string }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const userId = randomUUID();
  const attemptId = randomUUID();
  await sup(async (c) => {
    await c.query(
      `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`,
      [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin],
    );
    await c.query(
      `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`,
      [level, pack],
    );
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',$5,$6)`,
      [assessment, tenant, pack, level, qs.length, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [userId, tenant, `c-${randomUUID().slice(0, 6)}@numms.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'in_progress', now() - interval '10 minutes', now() + interval '50 minutes', 3600)`,
      [attemptId, tenant, assessment, userId],
    );
    let pos = 1;
    for (const q of qs) {
      const qid = randomUUID();
      const content = JSON.stringify(q.content);
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',$5,'active',$6::jsonb,1,$7)`,
        [qid, pack, level, q.type, q.points, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos++]);
      if (q.answer !== undefined) {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify(q.answer)]);
      }
    }
  });
  return { attemptId, userId };
}

const NUM = { question: "q", answer: 100, tolerance: 0.5, unit: "km" };
const MS_PARTIAL = { question: "q", options: ["a", "b", "c", "d"], correct: [0, 2], scoring: "partial" };
const MS_ALL = { question: "q", options: ["a", "b", "c", "d"], correct: [0, 2] };

describe("numeric + multi_select auto-grade at submit", () => {
  it("only deterministic types -> graded at candidate submit, partial credit and totals correct", async () => {
    const { attemptId, userId } = await seed([
      { type: "numeric", content: NUM, answer: 100.4, points: 10 }, // within tolerance -> 10
      { type: "multi_select", content: MS_PARTIAL, answer: { selected: [0] }, points: 10 }, // half -> 5
      { type: "multi_select", content: MS_ALL, answer: { selected: [0] }, points: 10 }, // incomplete -> 0
    ]);
    await submitAttempt(tenant, userId, attemptId);

    const st = await sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [attemptId]).then((r) => r.rows[0].status as string));
    expect(st).toBe("graded");
    const g = await sup((c) =>
      c.query(`SELECT grader, status, score_earned::float e, score_max::float m FROM gradings WHERE attempt_id=$1 ORDER BY score_earned DESC`, [attemptId]).then((r) => r.rows),
    );
    expect(g.every((r) => r.grader === "deterministic")).toBe(true);
    expect(g.map((r) => [r.status, r.e, r.m])).toEqual([
      ["correct", 10, 10],
      ["partial", 5, 10],
      ["incorrect", 0, 10],
    ]);
    const s = await sup((c) => c.query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows[0]));
    expect(s).toMatchObject({ e: 15, m: 30 });
  });

  it("with a subjective question the attempt is NOT finalised (still needs the evaluator), deterministic rows exist", async () => {
    const { attemptId, userId } = await seed([
      { type: "numeric", content: NUM, answer: 100, points: 10 },
      { type: "subjective", content: { question: "why?" }, answer: { response: "x" }, points: 10 },
    ]);
    await submitAttempt(tenant, userId, attemptId);
    const st = await sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [attemptId]).then((r) => r.rows[0].status as string));
    expect(st).toBe("submitted");
    const n = await sup((c) => c.query(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='deterministic'`, [attemptId]).then((r) => Number(r.rows[0].n)));
    expect(n).toBe(1);
  });
});
