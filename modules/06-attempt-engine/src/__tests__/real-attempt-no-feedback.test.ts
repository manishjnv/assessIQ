/**
 * Z-159 CI invariant (D4): a Real attempt never returns feedback (testcontainers Postgres).
 * For every feedback level and embed_origin true/false, a released Real attempt gets
 * { level: 'none', items: [] } from getCandidateFeedback and feedback_level 'none' from getCandidateResult.
 * Mock and embed cases stay in candidate-feedback.test.ts and effective-level-call-sites.test.ts.
 * Fixtures are copied from candidate-feedback.test.ts (one graded MCQ, so a leak would show items).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { getCandidateFeedback } from "../feedback.js";
import { getCandidateResult } from "../result.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const MODULES_ROOT = join(THIS_DIR, "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql", "0168_gradings_cli_version_stage_inputs.sql", "0258_gradings_ai_cost.sql"]],
  ["09-scoring", undefined],
  ["13-notifications", undefined],
  ["18-certification", undefined],
  ["19-billing", undefined],
];

const LEVELS = ["none", "right_wrong", "with_expected_answer", "with_ai_justification"] as const;

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_rnf" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_rnf`;

  await sup(async (c) => {
    await c.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    for (const r of ["assessiq_app", "assessiq_system"]) {
      const bypass = r === "assessiq_system" ? " BYPASSRLS" : "";
      await c.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN CREATE ROLE ${r}${bypass}; END IF; END $$;`,
      );
      await c.query(`GRANT ${r} TO test`);
    }
    for (const [mod, only] of DIRS) {
      const dir = join(MODULES_ROOT, mod, "migrations");
      const files = (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && (only === undefined || only.includes(f)))
        .sort();
      for (const f of files) await c.query(await readFile(join(dir, f), "utf-8"));
    }
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  });
  await setPoolForTesting(url);

  tenant = randomUUID();
  admin = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-rnf','Acme University')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@x.test','Admin','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** A released Real attempt with one graded MCQ. The assessment carries the feedback level. */
async function seedRealAttempt(level: string, embed: boolean): Promise<{ attemptId: string; userId: string }> {
  const pack = randomUUID();
  const lvl = randomUUID();
  const assessmentId = randomUUID();
  const userId = randomUUID();
  const attemptId = randomUUID();
  const qid = randomUUID();
  const content = JSON.stringify({ question: "Which is private?", options: ["8.8.8.8", "10.0.0.1", "1.1.1.1", "9.9.9.9"], correct: 1 });
  await sup(async (c) => {
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by) VALUES ($1,$2,$3,'P','soc','published',$4)`, [pack, tenant, `p-${randomUUID().slice(0, 8)}`, admin]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count, passing_score_pct) VALUES ($1,$2,1,'L1',60,1,60)`, [lvl, pack]);
    await c.query(
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by, settings) VALUES ($1,$2,$3,$4,1,'SOC Analyst L1','active',1,$5,$6::jsonb)`,
      [assessmentId, tenant, pack, lvl, admin, JSON.stringify({ feedback_level: level })],
    );
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Riya','candidate','active')`, [userId, tenant, `r-${userId.slice(0, 6)}@x.test`]);
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, delivery_mode, embed_origin) VALUES ($1,$2,$3,$4,'released', now() - interval '20 minutes', now() + interval '40 minutes', now(), 3600, 'real', $5)`,
      [attemptId, tenant, assessmentId, userId, embed],
    );
    await c.query(`INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,'mcq','Fallback topic',10,'active',$4::jsonb,1,$5)`, [qid, pack, lvl, content, admin]);
    await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
    await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,1,1)`, [attemptId, qid]);
    await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: 1 })]);
    await c.query(
      `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model) VALUES ($1,$2,$3,'deterministic',10,10,'correct','sha','lbl','m')`,
      [tenant, attemptId, qid],
    );
    await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pending_review) VALUES ($1,$2,10,10,100,false)`, [attemptId, tenant]);
  });
  return { attemptId, userId };
}

const CASES = LEVELS.flatMap((level) => [false, true].map((embed) => ({ level, embed })));

describe("Z-159: a Real attempt never returns feedback", () => {
  it.each(CASES)("getCandidateFeedback is { level: 'none', items: [] } (level $level, embed $embed)", async ({ level, embed }) => {
    const s = await seedRealAttempt(level, embed);
    expect(await getCandidateFeedback(tenant, s.userId, s.attemptId)).toEqual({ level: "none", items: [] });
  });

  it.each(CASES)("getCandidateResult has feedback_level 'none' (level $level, embed $embed)", async ({ level, embed }) => {
    const s = await seedRealAttempt(level, embed);
    const view = await getCandidateResult(tenant, s.userId, s.attemptId);
    expect(view.status).toBe("released");
    if (view.status !== "released") throw new Error("unreachable");
    expect(view.feedback_level).toBe("none");
  });
});
