/**
 * Deterministic MCQ scoring — integration (testcontainers Postgres).
 * Covers scoreMcqForAttempt (frozen version, idempotency, concurrency) and
 * scoreMcqAndFinalizeIfComplete (MCQ-only -> graded + 1 billing row + audit;
 * mixed -> stays pending; auto_submitted -> graded).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { applyAllMigrations } from "../../../../tools/test-support/apply-all-migrations.js";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { scoreMcqForAttempt, scoreMcqAndFinalizeIfComplete, MCQ_SENTINEL_SHA } from "../mcq.js";


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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_mcq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_mcq`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-mcq','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@mcq.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

interface Q {
  type?: "mcq" | "subjective";
  points: number;
  correct?: number;
  answer?: unknown;
  /** If set, a v2 (live) version with this key exists; the attempt stays pinned to v1. */
  liveCorrect?: number;
}

async function seed(status: string, qs: Q[]): Promise<{ attemptId: string; qids: string[] }> {
  const pack = randomUUID();
  const level = randomUUID();
  const assessment = randomUUID();
  const cand = randomUUID();
  const attemptId = randomUUID();
  const qids: string[] = [];
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
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@mcq.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, duration_seconds) VALUES ($1,$2,$3,$4,$5, now() - interval '10 minutes', 3600)`,
      [attemptId, tenant, assessment, cand, status],
    );
    let pos = 1;
    for (const q of qs) {
      const qid = randomUUID();
      qids.push(qid);
      const type = q.type ?? "mcq";
      const mk = (correct: number): string =>
        JSON.stringify(
          type === "mcq"
            ? { question: "q", options: ["a", "b", "c", "d"], correct, rationale: "r" }
            : { question: "q" },
        );
      const version = q.liveCorrect !== undefined ? 2 : 1;
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',$5,'active',$6::jsonb,$7,$8)`,
        [qid, pack, level, type, q.points, mk(q.liveCorrect ?? q.correct ?? 0), version, admin],
      );
      await c.query(
        `INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`,
        [qid, mk(q.correct ?? 0), admin],
      );
      if (version === 2) {
        await c.query(
          `INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,2,$2::jsonb,$3)`,
          [qid, mk(q.liveCorrect as number), admin],
        );
      }
      await c.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`,
        [attemptId, qid, pos++],
      );
      if (q.answer !== undefined) {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [
          attemptId,
          qid,
          JSON.stringify(q.answer),
        ]);
      }
    }
  });
  return { attemptId, qids };
}

const gradings = (attemptId: string) =>
  sup((c) =>
    c
      .query(
        `SELECT question_id, grader, status, score_earned::float AS e, score_max::float AS m, prompt_version_sha FROM gradings WHERE attempt_id=$1 ORDER BY question_id`,
        [attemptId],
      )
      .then((r) => r.rows),
  );
const attemptStatus = (id: string) =>
  sup((c) => c.query(`SELECT status FROM attempts WHERE id=$1`, [id]).then((r) => r.rows[0].status as string));
const count = (sql: string, id: string) =>
  sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));

describe("scoreMcqForAttempt", () => {
  it("scores correct / wrong / unanswered / malformed; wrong+unanswered = 0, no negatives", async () => {
    const { attemptId, qids } = await seed("submitted", [
      { points: 10, correct: 1, answer: { selected: 1 } }, // correct
      { points: 10, correct: 1, answer: { selected: 3 } }, // wrong
      { points: 10, correct: 1 }, // unanswered
      { points: 10, correct: 1, answer: ["1"] }, // malformed
    ]);
    const n = await withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId));
    expect(n).toBe(4);
    const by = Object.fromEntries((await gradings(attemptId)).map((r) => [r.question_id, r]));
    expect(by[qids[0]!]).toMatchObject({ grader: "deterministic", status: "correct", e: 10, m: 10, prompt_version_sha: MCQ_SENTINEL_SHA });
    expect(by[qids[1]!]).toMatchObject({ status: "incorrect", e: 0, m: 10 });
    expect(by[qids[2]!]).toMatchObject({ status: "incorrect", e: 0, m: 10 });
    expect(by[qids[3]!]).toMatchObject({ status: "incorrect", e: 0 });
  });

  it("uses the FROZEN version, not the live (revised) question", async () => {
    // frozen v1 key=1; live v2 key=3. Candidate picked 1 -> correct under the frozen key.
    const { attemptId } = await seed("submitted", [{ points: 5, correct: 1, liveCorrect: 3, answer: { selected: 1 } }]);
    await withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId));
    expect((await gradings(attemptId))[0]).toMatchObject({ status: "correct", e: 5 });
  });

  it("is idempotent - second call inserts nothing", async () => {
    const { attemptId } = await seed("submitted", [{ points: 10, correct: 0, answer: { selected: 0 } }]);
    expect(await withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId))).toBe(1);
    expect(await withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId))).toBe(0);
    expect(await gradings(attemptId)).toHaveLength(1);
  });

  it("is safe under concurrent calls - no duplicates, no error", async () => {
    const { attemptId } = await seed("submitted", [
      { points: 10, correct: 0, answer: { selected: 0 } },
      { points: 10, correct: 0, answer: { selected: 1 } },
    ]);
    await Promise.all([1, 2, 3].map(() => withTenant(tenant, (c) => scoreMcqForAttempt(c, attemptId))));
    expect(await gradings(attemptId)).toHaveLength(2);
  });
});

describe("scoreMcqAndFinalizeIfComplete", () => {
  it("MCQ-only submitted attempt -> graded, correct total, one billing row, one audit row", async () => {
    const { attemptId } = await seed("submitted", [
      { points: 10, correct: 1, answer: { selected: 1 } },
      { points: 10, correct: 1, answer: { selected: 0 } },
    ]);
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r.finalized).toBe(true);
    expect(await attemptStatus(attemptId)).toBe("graded");
    const s = await sup((c) =>
      c
        .query(`SELECT total_earned::float e, total_max::float m, auto_pct::float p FROM attempt_scores WHERE attempt_id=$1`, [attemptId])
        .then((x) => x.rows[0]),
    );
    expect(s).toMatchObject({ e: 10, m: 20, p: 50 });
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
    expect(
      await count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.accepted' AND actor_kind='system'`, attemptId),
    ).toBe(1);

    // second call: no-op (already graded) - still one billing + one audit
    const again = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(again.finalized).toBe(false);
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.accepted'`, attemptId)).toBe(1);
  });

  it("auto_submitted MCQ-only attempt -> graded", async () => {
    const { attemptId } = await seed("auto_submitted", [{ points: 4, correct: 2, answer: { selected: 2 } }]);
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r.finalized).toBe(true);
    expect(await attemptStatus(attemptId)).toBe("graded");
  });

  it("mixed attempt -> MCQ rows written, NOT finalised, no billing", async () => {
    const { attemptId } = await seed("submitted", [
      { points: 10, correct: 1, answer: { selected: 1 } },
      { type: "subjective", points: 10 },
    ]);
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r).toMatchObject({ finalized: false, mcqRowsInserted: 1 });
    expect(await attemptStatus(attemptId)).toBe("submitted");
    expect(await gradings(attemptId)).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(0);
  });

  it("in_progress attempt is never finalised", async () => {
    const { attemptId } = await seed("in_progress", [{ points: 10, correct: 1, answer: { selected: 1 } }]);
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r.finalized).toBe(false);
    expect(await attemptStatus(attemptId)).toBe("in_progress");
  });

  it("partial-score guard: an MCQ whose frozen question_versions row is missing -> NOT finalised", async () => {
    const { attemptId, qids } = await seed("submitted", [
      { points: 10, correct: 1, answer: { selected: 1 } },
      { points: 10, correct: 1, answer: { selected: 1 } },
    ]);
    await sup((c) => c.query(`DELETE FROM question_versions WHERE question_id=$1`, [qids[1]]));
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r.finalized).toBe(false);
    expect(await attemptStatus(attemptId)).toBe("submitted");
    expect(await count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, attemptId)).toBe(0);
  });
});
