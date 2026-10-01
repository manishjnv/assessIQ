/**
 * SP1 — completion gate, manual first score, override recompute (testcontainers).
 *
 * Covers the 07-owned seams of module 09's finalizeAttemptIfComplete:
 *   - handleAdminAccept finalises ONLY when every question (incl. KQL) has a
 *     final, non-flagged grade; billing once, in the same tx.
 *   - handleAdminManualScore: first human score for an ungraded question (KQL);
 *     audit shape (no reason text), 409 / 422 / released guards, concurrency.
 *   - handleAdminOverride: recomputes attempt_scores in-tx, can complete a flagged
 *     attempt, and is refused once the result is published.
 *   - POST .../manual-score route: body/param validation + chain wiring.
 *   - Adversarial-review fixes: accept locks the attempt row first and refuses a
 *     released attempt (409, nothing written — incl. the real lock race against a
 *     Release); override rejects a score outside 0..score_max (422).
 *
 * No AI anywhere: runtime-selector is mocked and never called.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../runtime-selector.js", () => ({ gradeSubjective: vi.fn() }));

import { AppError } from "@assessiq/core";
import { setPoolForTesting, closePool } from "@assessiq/tenancy";
import { handleAdminAccept } from "../handlers/admin-accept.js";
import { handleAdminManualScore } from "../handlers/admin-manual-score.js";
import { handleAdminOverride } from "../handlers/admin-override.js";
import { registerGradingRoutes } from "../routes.js";
import type { GradingProposal } from "../types.js";

const toFsPath = (url: URL): string => url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODULES_ROOT = join(toFsPath(new URL(".", import.meta.url)), "..", "..", "..");
const DIRS: Array<[string, string[] | undefined]> = [
  ["02-tenancy", undefined],
  ["03-users", ["020_users.sql"]],
  ["14-audit-log", undefined],
  ["04-question-bank", undefined],
  ["05-assessment-lifecycle", undefined],
  ["06-attempt-engine", undefined],
  ["12-embed-sdk", ["0073_attempt_embed_origin.sql"]],
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

/** Resolves once some backend is blocked on a row/transaction lock (i.e. the code under test reached its lock). */
async function waitForLockWait(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await sup((c) =>
      c
        .query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
        .then((r) => r.rows[0].n as number),
    );
    if (n > 0) return;
    if (Date.now() > deadline) throw new Error("nothing is waiting on a lock: the code under test never blocked on the expected row");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_gate" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_gate`;

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
    await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,'t-gate','T')`, [tenant]);
    await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenant]);
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,'a@gate.test','A','admin','active')`,
      [admin, tenant],
    );
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

/** Seed an attempt; every question is worth 10 points. MCQ rows (correct) are inserted for mcq types. */
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
      [assessment, tenant, pack, level, types.length, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'C','candidate','active')`,
      [cand, tenant, `c-${randomUUID().slice(0, 6)}@gate.test`],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4,$5, now() - interval '30 minutes', now(), 3600)`,
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
        // the deterministic row the submit path would have written (correct = 10/10)
        await c.query(
          `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
           VALUES ($1,$2,$3,'deterministic',10,10,'correct','deterministic-mcq-v1','deterministic-mcq-v1','none')`,
          [tenant, attemptId, qid],
        );
      }
    }
  });
  return { attemptId, qids };
}

function proposal(attemptId: string, questionId: string, o: Partial<GradingProposal> = {}): GradingProposal {
  return {
    attempt_id: attemptId,
    question_id: questionId,
    anchors: [],
    band: { reasoning_band: 3, ai_justification: "ok", error_class: null, needs_escalation: false },
    score_earned: 8,
    score_max: 10,
    prompt_version_sha: `anchors:${randomUUID().slice(0, 8)};band:aaaaaaaa;escalate:-`,
    prompt_version_label: "v1",
    model: "test-model",
    escalation_chosen_stage: "2",
    generated_at: new Date().toISOString(),
    ...o,
  };
}

const accept = (attemptId: string, proposals: GradingProposal[]) =>
  handleAdminAccept({ tenantId: tenant, userId: admin, attemptId, proposals });
const manual = (attemptId: string, questionId: string, scoreEarned: number, reason = "reviewed the query result") =>
  handleAdminManualScore({ tenantId: tenant, userId: admin, attemptId, questionId, scoreEarned, reason });
const att = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT status, evaluation_released_at IS NOT NULL AS eval_released, ai_proposals IS NULL AS cache_clear FROM attempts WHERE id=$1`, [id])
      .then((r) => r.rows[0] as { status: string; eval_released: boolean; cache_clear: boolean }),
  );
const count = (sql: string, id: string) => sup((c) => c.query(sql, [id]).then((r) => Number(r.rows[0].n)));
const billing = (id: string) => count(`SELECT COUNT(*) n FROM billing_events WHERE attempt_id=$1`, id);
const totals = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT total_earned::float e, total_max::float m, pending_review FROM attempt_scores WHERE attempt_id=$1`, [id])
      .then((r) => r.rows[0] as { e: number; m: number; pending_review: boolean } | undefined),
  );

describe("handleAdminAccept — completion gate (SP1)", () => {
  it("AI questions accepted but a KQL question ungraded -> stays pending_admin_grading, no billing", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective", "kql"]);
    const r = await accept(attemptId, [proposal(attemptId, qids[1]!)]);
    expect(r.attempt.status).toBe("pending_admin_grading");
    expect((await att(attemptId)).status).toBe("pending_admin_grading");
    expect(await billing(attemptId)).toBe(0);
    // the partial rollup still exists for the admin view, never exposed to the candidate (P1)
    expect(await totals(attemptId)).toMatchObject({ e: 18, m: 20 });
  });

  it("... and the manual KQL score completes it: graded, evaluation released, billed once, KQL in the total", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective", "kql"]);
    await accept(attemptId, [proposal(attemptId, qids[1]!)]);
    const m = await manual(attemptId, qids[2]!, 7);
    expect(m.attempt.status).toBe("graded");
    expect(m.grading).toMatchObject({ grader: "admin_override", override_of: null, model: "manual", score_earned: 7, score_max: 10, status: "partial" });
    expect(await att(attemptId)).toEqual({ status: "graded", eval_released: true, cache_clear: true });
    expect(await totals(attemptId)).toMatchObject({ e: 25, m: 30, pending_review: false });
    expect(await billing(attemptId)).toBe(1);
  });

  it("a review_needed AI grade (runtime failure placeholder) blocks; overriding it completes the attempt", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "scenario"]);
    await sup((c) => c.query(`UPDATE attempts SET ai_proposals='[{"x":1}]'::jsonb WHERE id=$1`, [attemptId]));
    const failed = proposal(attemptId, qids[1]!, {
      band: { reasoning_band: 0, ai_justification: "", error_class: "AIG_RUNTIME_FAILURE", needs_escalation: false },
      score_earned: 0,
      prompt_version_sha: "error:no-sha",
    });
    const r = await accept(attemptId, [failed]);
    expect(r.gradings[0]!.status).toBe("review_needed");
    expect(r.attempt.status).toBe("pending_admin_grading");
    expect(await billing(attemptId)).toBe(0);

    await handleAdminOverride({
      tenantId: tenant,
      userId: admin,
      gradingId: r.gradings[0]!.id,
      override: { score_earned: 9, reason: "AI failed; graded by hand" },
    });
    expect(await att(attemptId)).toMatchObject({ status: "graded", eval_released: true });
    expect(await totals(attemptId)).toMatchObject({ e: 19, m: 20, pending_review: false });
    expect(await billing(attemptId)).toBe(1);
  });

  it("accepting every AI question of a mixed attempt finalises it once (billing once, review cache cleared)", async () => {
    const { attemptId, qids } = await seed("submitted", ["mcq", "subjective", "log_analysis"]);
    await sup((c) => c.query(`UPDATE attempts SET ai_proposals='[{"x":1}]'::jsonb, grading_started_at=now() WHERE id=$1`, [attemptId]));
    const proposals = [proposal(attemptId, qids[1]!), proposal(attemptId, qids[2]!, { score_earned: 10 })];
    const r = await accept(attemptId, proposals);
    expect(r.attempt.status).toBe("graded");
    expect(await att(attemptId)).toEqual({ status: "graded", eval_released: true, cache_clear: true });
    expect(await billing(attemptId)).toBe(1);
    // re-accepting the SAME proposals is idempotent (D7): no new rows, no second bill
    const again = await accept(attemptId, proposals);
    expect(again.gradings.map((g) => g.id).sort()).toEqual(r.gradings.map((g) => g.id).sort());
    expect(await billing(attemptId)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='ai'`, attemptId)).toBe(2);
    // the first accept audit row records the honest post-gate status
    const audits = await sup((c) =>
      c
        .query(`SELECT after->>'attempt_status_now' AS s FROM audit_log WHERE entity_id=$1 AND action='grading.accepted' ORDER BY id`, [attemptId])
        .then((x) => x.rows.map((y) => y.s as string)),
    );
    expect(audits[0]).toBe("graded");
  });
});

describe("handleAdminAccept — a published result is final; attempt row lock first (review fix: accept/release race)", () => {
  /** The AI-failure placeholder the runtime produces: accepting it writes a review_needed grade. */
  const failedProposal = (attemptId: string, qid: string) =>
    proposal(attemptId, qid, {
      band: { reasoning_band: 0, ai_justification: "", error_class: "AIG_RUNTIME_FAILURE", needs_escalation: false },
      score_earned: 0,
      prompt_version_sha: "error:no-sha",
    });
  const gradingCount = (id: string) => count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, id);
  const acceptAudits = (id: string) => count(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=$1 AND action='grading.accepted'`, id);

  it("accept on a released attempt -> 409 RESULT_ALREADY_PUBLISHED; zero new gradings, no audit row, score untouched", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective"]);
    await accept(attemptId, [proposal(attemptId, qids[1]!, { score_earned: 6 })]); // completes it -> graded
    await sup((c) => c.query(`UPDATE attempts SET status='released' WHERE id=$1`, [attemptId]));
    const gradingsBefore = await gradingCount(attemptId);
    const totalsBefore = await totals(attemptId);

    await expect(accept(attemptId, [failedProposal(attemptId, qids[1]!)])).rejects.toMatchObject({
      code: "RESULT_ALREADY_PUBLISHED",
      status: 409,
    });
    expect(await gradingCount(attemptId)).toBe(gradingsBefore);
    expect(await totals(attemptId)).toEqual(totalsBefore);
    expect(await acceptAudits(attemptId)).toBe(1); // only the first accept
    expect((await att(attemptId)).status).toBe("released");
  });

  it("accept on an unknown attempt -> 404 AIG_ATTEMPT_NOT_FOUND (was a misleading 422)", async () => {
    const ghost = randomUUID();
    await expect(accept(ghost, [proposal(ghost, randomUUID())])).rejects.toMatchObject({
      code: "AIG_ATTEMPT_NOT_FOUND",
      status: 404,
    });
  });

  it("a proposal addressed to ANOTHER attempt than attemptId is refused (422) before anything is written — the lock cannot be sidestepped to grade a published attempt", async () => {
    const published = await seed("released", ["subjective"]);
    const open = await seed("pending_admin_grading", ["subjective"]);
    await expect(accept(open.attemptId, [failedProposal(published.attemptId, published.qids[0]!)])).rejects.toMatchObject({
      code: "AIG_INVALID_BODY",
      status: 422,
    });
    expect(await gradingCount(published.attemptId)).toBe(0);
    expect(await gradingCount(open.attemptId)).toBe(0);
  });

  it("race: a Release holds the attempt lock when accept arrives -> accept waits, then sees 'released' and writes nothing", async () => {
    const { attemptId, qids } = await seed("graded", ["subjective"]);
    const releasing = new Client({ connectionString: url });
    await releasing.connect();
    try {
      await releasing.query("BEGIN");
      // the first thing module 09 releaseAttemptInTx does
      await releasing.query(`SELECT status FROM attempts WHERE id=$1 FOR UPDATE`, [attemptId]);
      const accepting = accept(attemptId, [failedProposal(attemptId, qids[0]!)]).then(
        () => "accepted" as const,
        (e: unknown) => e,
      );
      await waitForLockWait(); // accept is queued behind the release on the attempt row
      await releasing.query(`UPDATE attempts SET status='released' WHERE id=$1`, [attemptId]);
      await releasing.query("COMMIT");
      expect(await accepting).toMatchObject({ code: "RESULT_ALREADY_PUBLISHED", status: 409 });
    } finally {
      await releasing.query("ROLLBACK").catch(() => undefined);
      await releasing.end();
    }
    expect(await gradingCount(attemptId)).toBe(0);
    expect((await att(attemptId)).status).toBe("released");
  });
});

describe("handleAdminManualScore", () => {
  it("writes the row + exactly one grading.override audit row (manual_first_score, NO reason text)", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql", "mcq"]);
    const secret = "contains-candidate-PII-should-stay-out-of-audit";
    const m = await manual(attemptId, qids[0]!, 9, secret);
    expect(m.grading).toMatchObject({
      grader: "admin_override",
      override_of: null,
      prompt_version_sha: "manual:v1",
      model: "manual",
      escalation_chosen_stage: "manual",
      graded_by: admin,
      override_reason: secret, // lives on the immutable row only
      status: "correct", // 9/10 >= 0.85
    });
    const rows = await sup((c) =>
      c.query(`SELECT actor_kind, actor_user_id::text, entity_type, entity_id::text, after FROM audit_log WHERE tenant_id=$1 AND action='grading.override' AND after->>'attempt_id'=$2`, [tenant, attemptId])
        .then((x) => x.rows),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: "user", actor_user_id: admin, entity_type: "grading", entity_id: m.grading.id });
    expect(rows[0].after).toMatchObject({ kind: "manual_first_score", question_id: qids[0], new_grading_id: m.grading.id });
    expect(JSON.stringify(rows[0].after)).not.toContain(secret);
  });

  it("409 when the question already has a grade (use override); nothing is written", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql", "kql"]);
    await manual(attemptId, qids[0]!, 5);
    await expect(manual(attemptId, qids[0]!, 6)).rejects.toMatchObject({ code: "AIG_QUESTION_ALREADY_GRADED", status: 409 });
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(1);
  });

  it.each([[-1], [10.01], [11], [1e9]])("422 when score_earned=%s is outside 0..points(10)", async (score) => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql"]);
    await expect(manual(attemptId, qids[0]!, score)).rejects.toMatchObject({ code: "AIG_INVALID_BODY", status: 422 });
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(0);
  });

  it("accepts the boundary scores 0 and points", async () => {
    const a = await seed("pending_admin_grading", ["kql"]);
    expect((await manual(a.attemptId, a.qids[0]!, 0)).grading.status).toBe("incorrect");
    const b = await seed("pending_admin_grading", ["kql"]);
    expect((await manual(b.attemptId, b.qids[0]!, 10)).grading.status).toBe("correct");
  });

  it("422 when the question is not part of this attempt's frozen set", async () => {
    const a = await seed("pending_admin_grading", ["kql"]);
    const b = await seed("pending_admin_grading", ["kql"]);
    await expect(manual(a.attemptId, b.qids[0]!, 5)).rejects.toMatchObject({ code: "AIG_INVALID_BODY", status: 422 });
  });

  it("404 for an unknown attempt, 422 for an in_progress attempt, 409 RESULT_ALREADY_PUBLISHED for a released one", async () => {
    await expect(manual(randomUUID(), randomUUID(), 5)).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_FOUND", status: 404 });
    const ip = await seed("in_progress", ["kql"]);
    await expect(manual(ip.attemptId, ip.qids[0]!, 5)).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_GRADEABLE", status: 422 });
    const rel = await seed("released", ["kql"]);
    await expect(manual(rel.attemptId, rel.qids[0]!, 5)).rejects.toMatchObject({ code: "RESULT_ALREADY_PUBLISHED", status: 409 });
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, rel.attemptId)).toBe(0);
  });

  it("a legacy graded attempt with an ungraded KQL question can still be scored (rollup recomputed)", async () => {
    const { attemptId, qids } = await seed("graded", ["mcq", "kql"]);
    await manual(attemptId, qids[1]!, 6);
    expect((await att(attemptId)).status).toBe("graded");
    expect(await totals(attemptId)).toMatchObject({ e: 16, m: 20 });
  });

  it("two concurrent manual scores for the same question: one wins, the other gets 409 (no 23505, no duplicate row)", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql"]);
    const res = await Promise.allSettled([manual(attemptId, qids[0]!, 4), manual(attemptId, qids[0]!, 5)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AppError);
    expect((rejected.reason as AppError).status).toBe(409);
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(1);
  });
});

describe("handleAdminOverride — rollup + published-is-final (SP1)", () => {
  it("recomputes attempt_scores in the same tx: the total reflects the override immediately", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective"]);
    const r = await accept(attemptId, [proposal(attemptId, qids[1]!, { score_earned: 5 })]);
    expect(r.attempt.status).toBe("graded");
    expect(await totals(attemptId)).toMatchObject({ e: 15, m: 20 });
    const ov = await handleAdminOverride({ tenantId: tenant, userId: admin, gradingId: r.gradings[0]!.id, override: { score_earned: 10, reason: "rubric met" } });
    expect(await totals(attemptId)).toMatchObject({ e: 20, m: 20 });
    expect(await billing(attemptId)).toBe(1); // override never bills again
    // exactly ONE audit row for the override; the derived rollup writes none
    expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE action='grading.override' AND entity_id=$1`, ov.grading.id)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE action='attempt_scores.recomputed_by_admin' AND entity_id=$1`, attemptId)).toBe(0);
  });

  it("409 RESULT_ALREADY_PUBLISHED once the attempt is released; no override row, score unchanged", async () => {
    const { attemptId, qids } = await seed("pending_admin_grading", ["subjective"]);
    const r = await accept(attemptId, [proposal(attemptId, qids[0]!, { score_earned: 5 })]);
    await sup((c) => c.query(`UPDATE attempts SET status='released' WHERE id=$1`, [attemptId]));
    await expect(
      handleAdminOverride({ tenantId: tenant, userId: admin, gradingId: r.gradings[0]!.id, override: { score_earned: 10, reason: "too late" } }),
    ).rejects.toMatchObject({ code: "RESULT_ALREADY_PUBLISHED", status: 409 });
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(1);
    expect(await totals(attemptId)).toMatchObject({ e: 5, m: 10 });
  });
});

describe("handleAdminOverride — score_earned must be within 0..score_max (review fix)", () => {
  /** An AI-graded subjective question (score_max 10, earned 5) in an otherwise complete attempt. */
  async function aiGraded(): Promise<{ attemptId: string; gradingId: string }> {
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective"]);
    const r = await accept(attemptId, [proposal(attemptId, qids[1]!, { score_earned: 5 })]);
    return { attemptId, gradingId: r.gradings[0]!.id };
  }
  const override = (gradingId: string, score: number) =>
    handleAdminOverride({ tenantId: tenant, userId: admin, gradingId, override: { score_earned: score, reason: "range check" } });

  it.each([[-1], [-0.01], [10.01], [11], [1e9], [NaN], [Infinity], [-Infinity]])(
    "422 AIG_INVALID_BODY (details.score_max 10) for score_earned=%s; nothing written, rollup unchanged",
    async (score) => {
      const { attemptId, gradingId } = await aiGraded();
      const before = await totals(attemptId);
      await expect(override(gradingId, score)).rejects.toMatchObject({
        code: "AIG_INVALID_BODY",
        status: 422,
        details: { score_max: 10 },
      });
      expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='admin_override'`, attemptId)).toBe(0);
      expect(await count(`SELECT COUNT(*) n FROM audit_log WHERE action='grading.override' AND after->>'override_of'=$1`, gradingId)).toBe(0);
      expect(await totals(attemptId)).toEqual(before);
    },
  );

  it("accepts both bounds: 0 (incorrect) and score_max (correct); the rollup follows the newest override", async () => {
    const { attemptId, gradingId } = await aiGraded();
    expect((await override(gradingId, 0)).grading).toMatchObject({ score_earned: 0, score_max: 10, status: "incorrect" });
    expect(await totals(attemptId)).toMatchObject({ e: 10, m: 20 });
    expect((await override(gradingId, 10)).grading).toMatchObject({ score_earned: 10, score_max: 10, status: "correct" });
    expect(await totals(attemptId)).toMatchObject({ e: 20, m: 20 });
  });
});

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  const session = async (req: { session?: unknown }) => {
    req.session = { tenantId: tenant, userId: admin, lastSeenAt: new Date().toISOString() };
  };
  await registerGradingRoutes(app, { adminOnly: [session as never], adminFreshMfa: [session as never] });
  return app;
}

describe("POST /api/admin/gradings/:id/override (route) — score range", () => {
  it("422 AIG_INVALID_BODY with details.score_max when score_earned is out of range; 200 at the boundary", async () => {
    const app = await buildApp();
    const { attemptId, qids } = await seed("pending_admin_grading", ["mcq", "subjective"]);
    const gradingId = (await accept(attemptId, [proposal(attemptId, qids[1]!, { score_earned: 5 })])).gradings[0]!.id;
    for (const bad of [-1, 11]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/gradings/${gradingId}/override`,
        payload: { score_earned: bad, reason: "out of range" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "AIG_INVALID_BODY", details: { score_max: 10 } } });
    }
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1 AND grader='admin_override'`, attemptId)).toBe(0);

    const ok = await app.inject({
      method: "POST",
      url: `/api/admin/gradings/${gradingId}/override`,
      payload: { score_earned: 10, reason: "full marks" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ grading: { score_earned: 10, score_max: 10 } });
    await app.close();
  });
});

describe("POST /api/admin/attempts/:id/questions/:questionId/manual-score (route)", () => {
  it("200 with the new grading; the chain is the fresh-MFA chain (session injected by it)", async () => {
    const app = await buildApp();
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql"]);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/attempts/${attemptId}/questions/${qids[0]}/manual-score`,
      payload: { score_earned: 8, reason: "query returns the expected rows" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ grading: { model: "manual", score_earned: 8 }, attempt: { id: attemptId, status: "graded" } });
    await app.close();
  });

  it.each([
    ["missing reason", { score_earned: 5 }],
    ["empty reason", { score_earned: 5, reason: "   " }],
    ["reason > 500", { score_earned: 5, reason: "x".repeat(501) }],
    ["negative score", { score_earned: -1, reason: "r" }],
    ["non-number score", { score_earned: "5", reason: "r" }],
    ["unknown field", { score_earned: 5, reason: "r", extra: 1 }],
  ])("400 VALIDATION_FAILED for %s", async (_label, payload) => {
    const app = await buildApp();
    const { attemptId, qids } = await seed("pending_admin_grading", ["kql"]);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/attempts/${attemptId}/questions/${qids[0]}/manual-score`,
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(await count(`SELECT COUNT(*) n FROM gradings WHERE attempt_id=$1`, attemptId)).toBe(0);
    await app.close();
  });

  it("400 for a non-UUID id / questionId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/attempts/not-a-uuid/questions/${randomUUID()}/manual-score`,
      payload: { score_earned: 5, reason: "r" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
