/**
 * finalizeAttemptIfComplete (SP1) — the one shared "is this result complete?" rule.
 * Integration (testcontainers Postgres, full RLS stack).
 *
 * A result is complete iff EVERY frozen question (all five types) has an effective
 * grading whose status is not 'review_needed'. Finalising = score rollup +
 * status 'graded' (+ evaluation_released_at) + exactly one billing row, one tx.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { finalizeAttemptIfComplete } from "../finalize.js";
import { scoreMcqAndFinalizeIfComplete } from "../mcq.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["07-ai-grading", ["0040_gradings.sql", "0041_tenant_grading_budgets.sql", "0100_attempts_ai_proposals_cache.sql"]],
  ["09-scoring", undefined],
  ["19-billing", undefined],
];

type QType = "mcq" | "subjective" | "scenario" | "log_analysis" | "kql";

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_finalize" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_finalize`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-fin','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@fin.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** Seed an attempt with the given question types (10 points each). MCQ key = 1, candidate picked 1. */
async function seed(status: string, types: QType[]): Promise<{ attemptId: string; qids: string[] }> {
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
      [assessment, tenant, pack, level, Math.max(1, types.length), admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@fin.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, duration_seconds)
       VALUES ($1,$2,$3,$4,$5, now() - interval '10 minutes', 3600)`,
      [attemptId, tenant, assessment, cand, status],
    );
    let pos = 1;
    for (const type of types) {
      const qid = randomUUID();
      qids.push(qid);
      const content = JSON.stringify(
        type === "mcq" ? { question: "q", options: ["a", "b", "c", "d"], correct: 1, rationale: "r" } : { question: "q" },
      );
      await c.query(
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, content, version, created_by) VALUES ($1,$2,$3,$4,'t',10,'active',$5::jsonb,1,$6)`,
        [qid, pack, level, type, content, admin],
      );
      await c.query(`INSERT INTO question_versions (question_id, version, content, saved_by) VALUES ($1,1,$2::jsonb,$3)`, [qid, content, admin]);
      await c.query(`INSERT INTO attempt_questions (attempt_id, question_id, position, question_version) VALUES ($1,$2,$3,1)`, [attemptId, qid, pos++]);
      if (type === "mcq") {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ selected: 1 })]);
      }
    }
  });
  return { attemptId, qids };
}

interface G {
  grader?: "deterministic" | "ai" | "admin_override";
  status?: "correct" | "partial" | "incorrect" | "review_needed";
  earned: number;
  max?: number;
  sha?: string;
  /** SQL interval in the past, e.g. "1 minute"; default = now() of the statement's tx. */
  ago?: string;
}

/** Insert one gradings row as superuser (RLS bypassed). Returns its id. */
async function grade(c: Client, attemptId: string, qid: string, g: G): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO gradings (id, tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model, graded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'v1','m', ${g.ago !== undefined ? `now() - interval '${g.ago}'` : "now()"})`,
    [id, tenant, attemptId, qid, g.grader ?? "ai", g.earned, g.max ?? 10, g.status ?? "correct", g.sha ?? `sha-${randomUUID().slice(0, 8)}`],
  );
  return id;
}

const gradeOne = (attemptId: string, qid: string, g: G) => sup((c) => grade(c, attemptId, qid, g));
const finalize = (attemptId: string, markEvaluationReleased = true) =>
  withTenant(tenant, (c) => finalizeAttemptIfComplete(c, { tenantId: tenant, attemptId, markEvaluationReleased }));
const row = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT status, evaluation_released_at IS NOT NULL AS released, ai_proposals IS NULL AS cache_clear FROM attempts WHERE id=$1`, [id])
      .then((r) => r.rows[0] as { status: string; released: boolean; cache_clear: boolean }),
  );
const count = (sql: string, id: string) => sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));
const billing = (id: string) => count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, id);
const score = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT total_earned::float e, total_max::float m, pending_review FROM attempt_scores WHERE attempt_id=$1`, [id])
      .then((r) => r.rows[0] as { e: number; m: number; pending_review: boolean } | undefined),
  );

describe("finalizeAttemptIfComplete", () => {
  it("MCQ-only attempt completes: graded, evaluation released, score rolled up, billed once, review cache cleared", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq", "mcq"]);
    await sup(async (c) => {
      await c.query(`UPDATE attempts SET ai_proposals='[]'::jsonb, grading_started_at=now() WHERE id=$1`, [attemptId]);
      await grade(c, attemptId, qids[0]!, { grader: "deterministic", earned: 10 });
      await grade(c, attemptId, qids[1]!, { grader: "deterministic", status: "incorrect", earned: 0 });
    });
    expect(await finalize(attemptId)).toEqual({ finalized: true });
    expect(await row(attemptId)).toEqual({ status: "graded", released: true, cache_clear: true });
    expect(await score(attemptId)).toMatchObject({ e: 10, m: 20, pending_review: false });
    expect(await billing(attemptId)).toBe(1);
    // no audit row is written by finalize itself (callers own their audit row)
    expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1`, attemptId)).toBe(0);
  });

  it("markEvaluationReleased=false flips to graded but leaves evaluation_released_at NULL", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["subjective"]);
    await gradeOne(attemptId, qids[0]!, { earned: 8 });
    expect(await finalize(attemptId, false)).toEqual({ finalized: true });
    expect(await row(attemptId)).toMatchObject({ status: "graded", released: false });
    expect(await billing(attemptId)).toBe(1);
  });

  it("auto_submitted attempts finalise too", async () => {
    const { attemptId, qids } = await seed("auto_submitted", ["mcq"]);
    await gradeOne(attemptId, qids[0]!, { grader: "deterministic", earned: 10 });
    expect((await finalize(attemptId)).finalized).toBe(true);
  });

  it("all five question types count: complete only once EVERY type has a grading", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq", "subjective", "scenario", "log_analysis", "kql"]);
    for (let i = 0; i < 4; i++) {
      await gradeOne(attemptId, qids[i]!, { earned: 5, status: "partial" });
      expect((await finalize(attemptId)).finalized).toBe(false); // KQL (index 4) still ungraded
    }
    expect(await row(attemptId)).toMatchObject({ status: "submitted", released: false });
    expect(await billing(attemptId)).toBe(0);
    expect(await score(attemptId)).toBeUndefined(); // never a partial rollup from finalize

    await gradeOne(attemptId, qids[4]!, { earned: 5, status: "partial" });
    expect((await finalize(attemptId)).finalized).toBe(true);
    expect(await score(attemptId)).toMatchObject({ e: 25, m: 50 });
    expect(await billing(attemptId)).toBe(1);
  });

  it("MCQ + KQL: stays pending after MCQ scoring; completes after a manual KQL score (admin_override, no AI)", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq", "kql"]);
    // deterministic MCQ scoring (the submit path) must NOT finalise while KQL is ungraded
    const r = await withTenant(tenant, (c) => scoreMcqAndFinalizeIfComplete(c, tenant, attemptId));
    expect(r).toMatchObject({ finalized: false, mcqRowsInserted: 1 });
    expect((await row(attemptId)).status).toBe("submitted");
    expect(await billing(attemptId)).toBe(0);

    await gradeOne(attemptId, qids[1]!, { grader: "admin_override", sha: "manual:v1", earned: 7 });
    expect(await finalize(attemptId)).toEqual({ finalized: true });
    expect(await score(attemptId)).toMatchObject({ e: 17, m: 20 }); // 10 (MCQ) + 7 (KQL)
    expect(await billing(attemptId)).toBe(1);
  });

  it("a review_needed grade blocks completion; an override of it (same-tx timestamp tie) completes it", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["subjective", "scenario"]);
    await gradeOne(attemptId, qids[0]!, { earned: 8 });
    const flagged = await gradeOne(attemptId, qids[1]!, { status: "review_needed", earned: 0 });
    expect((await finalize(attemptId)).finalized).toBe(false);
    expect(await billing(attemptId)).toBe(0);

    // override row inserted in the SAME tx as nothing else -> its own now(); force an exact tie
    // with the flagged row by giving it the identical graded_at.
    await sup(async (c) => {
      await c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model, override_of, graded_at)
         SELECT tenant_id, attempt_id, question_id, 'admin_override', 9, 10, 'correct', prompt_version_sha, prompt_version_label, model, id, graded_at
           FROM gradings WHERE id = $1`,
        [flagged],
      );
    });
    expect((await finalize(attemptId)).finalized).toBe(true);
    expect(await score(attemptId)).toMatchObject({ e: 17, m: 20, pending_review: false });
  });

  it("effective grade = newest row: a later override replaces the AI score in the total", async () => {
    const { attemptId, qids } = await seed("submitted", ["subjective"]);
    const ai = await gradeOne(attemptId, qids[0]!, { earned: 4, status: "partial", ago: "1 minute" });
    await sup((c) =>
      c.query(
        `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model, override_of)
         SELECT tenant_id, attempt_id, question_id, 'admin_override', 10, 10, 'correct', prompt_version_sha, prompt_version_label, model, id FROM gradings WHERE id=$1`,
        [ai],
      ),
    );
    expect((await finalize(attemptId)).finalized).toBe(true);
    expect(await score(attemptId)).toMatchObject({ e: 10, m: 10 });
  });

  it("a newer review_needed re-run row supersedes an older good grade (newest wins) and blocks", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["subjective"]);
    await gradeOne(attemptId, qids[0]!, { earned: 9, ago: "2 minutes", sha: "old" });
    await gradeOne(attemptId, qids[0]!, { earned: 0, status: "review_needed", sha: "new" });
    expect((await finalize(attemptId)).finalized).toBe(false);
  });

  it("only pre-graded statuses finalise; in_progress / graded / released return false and never bill", async () => {
    for (const status of ["in_progress", "graded", "released"]) {
      const { attemptId, qids } = await seed(status, ["mcq"]);
      await gradeOne(attemptId, qids[0]!, { grader: "deterministic", earned: 10 });
      expect(await finalize(attemptId)).toEqual({ finalized: false });
      expect((await row(attemptId)).status).toBe(status);
      expect(await billing(attemptId)).toBe(0);
    }
  });

  it("an attempt with no frozen questions is never complete", async () => {
    const { attemptId } = await seed("submitted", []);
    expect(await finalize(attemptId)).toEqual({ finalized: false });
    expect(await billing(attemptId)).toBe(0);
  });

  it("is idempotent and safe under concurrency: billed exactly once", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq", "mcq"]);
    await gradeOne(attemptId, qids[0]!, { grader: "deterministic", earned: 10 });
    await gradeOne(attemptId, qids[1]!, { grader: "deterministic", earned: 10 });
    const results = await Promise.all([1, 2, 3].map(() => finalize(attemptId)));
    expect(results.filter((r) => r.finalized)).toHaveLength(1);
    expect(await finalize(attemptId)).toEqual({ finalized: false });
    expect(await billing(attemptId)).toBe(1);
  });

  it("billing failure rolls the WHOLE finalize back (status, score, evaluation flag)", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq"]);
    await gradeOne(attemptId, qids[0]!, { grader: "deterministic", earned: 10 });
    await sup((c) =>
      c.query(`CREATE OR REPLACE FUNCTION t_fin_billing_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'billing down'; END $$;
               CREATE TRIGGER t_fin_billing_fail BEFORE INSERT ON billing_events FOR EACH ROW EXECUTE FUNCTION t_fin_billing_fail()`),
    );
    try {
      await expect(finalize(attemptId)).rejects.toThrow(/billing down/);
      expect(await row(attemptId)).toMatchObject({ status: "submitted", released: false });
      expect(await score(attemptId)).toBeUndefined();
    } finally {
      await sup((c) => c.query(`DROP TRIGGER t_fin_billing_fail ON billing_events`));
    }
    expect((await finalize(attemptId)).finalized).toBe(true);
    expect(await billing(attemptId)).toBe(1);
  });
});
