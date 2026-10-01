/**
 * MCQ scoring wired into the submit paths (testcontainers Postgres).
 * Regression: MCQ questions were never scored, so MCQ-only attempts never
 * reached 'graded' (no release / cert / billing) - see RCA_LOG 2026-10-01.
 *
 * Covers: candidate submit, timer sweep auto-submit, candidate-view
 * auto-submit, mixed attempt (MCQ rows only, stays 'submitted').
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { scoreMcqAndFinalizeIfComplete } from "@assessiq/scoring";
import { submitAttempt, sweepStaleTimersForTenant, getAttemptForCandidate } from "../service.js";


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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_ae_mcq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_ae_mcq`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-ae-mcq','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@aemcq.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** Seed an in_progress attempt: 2 MCQ (key=1, answers 1 and 0) [+1 subjective]. endsInPast -> timer expired. */
async function seed(opts: { mixed?: boolean; endsInPast?: boolean }): Promise<{ attemptId: string; userId: string }> {
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
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'A','active',3,$5)`,
      [assessment, tenant, pack, level, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [userId, tenant, `c-${randomUUID().slice(0, 6)}@aemcq.test`],
    );
    const ends = opts.endsInPast === true ? "now() - interval '1 minute'" : "now() + interval '50 minutes'";
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds)
       VALUES ($1,$2,$3,$4,'in_progress', now() - interval '61 minutes', ${ends}, 3600)`,
      [attemptId, tenant, assessment, userId],
    );
    const types = opts.mixed === true ? ["mcq", "mcq", "subjective"] : ["mcq", "mcq"];
    let pos = 1;
    for (const type of types) {
      const qid = randomUUID();
      const content = JSON.stringify(
        type === "mcq" ? { question: "q", options: ["a", "b", "c", "d"], correct: 1, rationale: "r" } : { question: "q" },
      );
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [qid, pack, level, type, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos]);
      if (type === "mcq") {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [
          attemptId,
          qid,
          JSON.stringify({ selected: pos === 1 ? 1 : 0 }), // first correct, second wrong
        ]);
      }
      pos++;
    }
  });
  return { attemptId, userId };
}

const status = (id: string) =>
  sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const count = (sql: string, id: string) => sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));

async function expectFinalised(attemptId: string): Promise<void> {
  expect(await status(attemptId)).toBe("graded");
  expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='deterministic'`, attemptId)).toBe(2);
  const s = await sup((c) =>
    c.query(`SELECT total_earned::float e, total_max::float m FROM attempt_scores WHERE attempt_id=$1`, [attemptId]).then((r) => r.rows[0]),
  );
  expect(s).toMatchObject({ e: 10, m: 20 });
  expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
  expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.accepted'`, attemptId)).toBe(1);
}

describe("MCQ scoring wired into submit paths", () => {
  it("candidate submit of an MCQ-only attempt -> graded, scored, billed once, audited", async () => {
    const { attemptId, userId } = await seed({});
    const r = await submitAttempt(tenant, userId, attemptId);
    expect(r.status).toBe("submitted"); // candidate-facing shape unchanged
    await expectFinalised(attemptId);
    // idempotent resubmit: still one billing row
    await submitAttempt(tenant, userId, attemptId);
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
  });

  it("timer sweep auto-submit of an MCQ-only attempt -> graded, scored, billed once", async () => {
    const { attemptId } = await seed({ endsInPast: true });
    const res = await sweepStaleTimersForTenant(tenant);
    expect(res.attemptIds).toContain(attemptId);
    await expectFinalised(attemptId);
  });

  it("candidate-view auto-submit (timer expired on read) -> graded, scored, billed once", async () => {
    const { attemptId, userId } = await seed({ endsInPast: true });
    await getAttemptForCandidate(tenant, attemptId, userId);
    await expectFinalised(attemptId);
  });

  it("mixed attempt submit -> MCQ rows written, attempt stays 'submitted', no billing", async () => {
    const { attemptId, userId } = await seed({ mixed: true });
    await submitAttempt(tenant, userId, attemptId);
    expect(await status(attemptId)).toBe("submitted");
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='deterministic'`, attemptId)).toBe(2);
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(0);
  });

  it("submit still succeeds when finalising fails (billing down); rolled back; admin path then finalises", async () => {
    const { attemptId, userId } = await seed({});
    await sup((c) =>
      c.query(`CREATE OR REPLACE FUNCTION t_billing_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'billing down'; END $$;
               CREATE TRIGGER t_billing_fail BEFORE INSERT ON billing_events FOR EACH ROW EXECUTE FUNCTION t_billing_fail()`),
    );
    try {
      const r = await submitAttempt(tenant, userId, attemptId);
      expect(r.status).toBe("submitted");
      expect(await status(attemptId)).toBe("submitted");
      expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(0);
      expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(0);
    } finally {
      await sup((c) => c.query(`DROP TRIGGER t_billing_fail ON billing_events`));
    }
    const res = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(res.finalized).toBe(true);
    await expectFinalised(attemptId);
  });
});
