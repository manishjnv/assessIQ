/**
 * Phase II (2026-10-01) — platform evaluation queue (SP9/SP10): smoke tests on the main
 * paths, postgres:16 testcontainer with real RLS + audit_log + billing. The AI runtime is
 * mocked (gradeSubjective) and never spawns anything.
 *
 *   - the platform queue lists eligible rows across tenants, with no candidate PII
 *   - the super admin evaluates ANOTHER tenant's attempt (grade -> accept -> manual score)
 *     and releases it to the tenant; evaluating alone never releases it
 *   - the tenant sees nothing (no grades / score / AI proposals) until the release, can
 *     override only after it, can send it back (no re-billing, audit without the note)
 *   - release-to-tenant refuses incomplete / flagged / erased / already-released /
 *     published attempts and suspended tenants; bulk = one tx per attempt
 *   - route layer: the tenant AI routes answer 403 AI_EVALUATION_BY_ASSESSIQ
 *   - owner decision 2026-10-01 (section 5): the accept / manual score / override that
 *     COMPLETES an attempt releases it to the company in the same tx (released_at + _by,
 *     hand-over recorded on that call's own audit row); a partial accept does not; a
 *     sent-back (already graded) attempt is never auto-released; the attempt-level Re-run AI
 *     on a sent-back attempt caches its proposals and accepting them (same prompt SHA) writes
 *     new rows + updates the score; an Auto-mode tenant's sweep then publishes it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import Fastify from "fastify";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("../runtime-selector.js", () => ({ gradeSubjective: vi.fn() }));
// The auto-release sweep (section 5) emails the candidate after each release; module 13 is covered by its own tests.
vi.mock("@assessiq/notifications", () => ({ emitAttemptEventAfterCommit: vi.fn(async () => undefined), notifyEvaluationReadyAfterCommit: vi.fn(async () => undefined), sendResultReleasedEmail: vi.fn(async () => undefined) }));

import { AppError } from "@assessiq/core";
import { setPoolForTesting, closePool, withTenant } from "@assessiq/tenancy";
import { sendResultReleasedEmail } from "@assessiq/notifications";
import { processAutoReleaseTick, resetAutoReleaseCooldownForTesting } from "../../../../apps/api/src/jobs/auto-release.js";
import { gradeSubjective } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";
import { handleAdminManualScore } from "../handlers/admin-manual-score.js";
import { handleAdminOverride } from "../handlers/admin-override.js";
import { handleAdminClaimAttempt } from "../handlers/admin-claim-release.js";
import { handleAdminSendBack } from "../handlers/admin-send-back.js";
import { assertTenantAiEnabled } from "../repository.js";
import {
  assertInEvaluationQueue,
  handleSuperGetEvaluation,
  handleSuperListEvaluations,
  handleSuperReleaseToTenant,
  handleSuperReleaseToTenantBulk,
  resolveEvaluationTenant,
} from "../handlers/super-evaluations.js";
import { registerGradingRoutes } from "../routes.js";
import { registerSuperEvaluationRoutes } from "../routes-super.js";
import type { GradingProposal } from "../types.js";

const mockGrade = vi.mocked(gradeSubjective);

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
  ["20-data-rights", ["0102_users_erased_at.sql"]],
];

type QType = "mcq" | "subjective" | "scenario" | "log_analysis" | "kql";

let container: StartedTestContainer;
let url: string;
let A: string; // active tenant
let B: string; // active tenant (the "other" tenant the super admin evaluates)
let C: string; // suspended tenant
let P: string; // platform tenant stand-in: the super admin's own (different) tenant
let adminA: string;
let adminB: string;
let adminC: string;
let superUser: string;

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
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "aiq_super_eval" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_super_eval`;

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

  [A, B, C, P] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  [adminA, adminB, adminC, superUser] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await sup(async (c) => {
    for (const [id, slug, name] of [
      [A, "t-a", "Tenant A"],
      [B, "t-b", "Tenant B"],
      [C, "t-c", "Tenant C"],
      [P, "t-platform", "Platform"],
    ] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [id, slug, name]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    }
    for (const [id, tenant, email] of [
      [adminA, A, "a@x.test"],
      [adminB, B, "b@x.test"],
      [adminC, C, "c@x.test"],
      [superUser, P, "super@x.test"],
    ] as const) {
      await c.query(
        `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`,
        [id, tenant, email],
      );
    }
    await c.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [C]);
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

beforeEach(() => {
  mockGrade.mockReset();
  if (singleFlight.isInFlight()) {
    const probe = singleFlight.acquire("__drain__");
    if (probe.kind === "acquired") probe.release();
  }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeedOpts {
  /** erase the candidate (users.erased_at) */
  erased?: boolean;
  /** attempts.evaluation_released_at = now() */
  evaluationReleased?: boolean;
  /** write final grades for every non-MCQ question: 'all' (complete) or 'flagged' (review_needed) */
  gradings?: "all" | "flagged";
}

const PII_EMAIL = "@pii.test";
const PII_NAME = "PII-Name";

/** Seed an attempt (every question worth 10). MCQ questions get their deterministic correct row. */
async function seed(
  tenant: string,
  admin: string,
  status: string,
  types: QType[],
  opts: SeedOpts = {},
): Promise<{ attemptId: string; qids: string[] }> {
  const [pack, level, assessment, cand, attemptId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
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
      `INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, status, question_count, created_by) VALUES ($1,$2,$3,$4,1,'Placement Test','active',$5,$6)`,
      [assessment, tenant, pack, level, types.length, admin],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, email, name, role, status, erased_at) VALUES ($1,$2,$3,$4,'candidate','active',$5)`,
      [cand, tenant, `c-${cand.slice(0, 8)}${PII_EMAIL}`, `${PII_NAME}-${cand.slice(0, 6)}`, opts.erased ? new Date() : null],
    );
    await c.query(
      `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, started_at, submitted_at, duration_seconds, evaluation_released_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours', now() - interval '1 hour', 3600, $6)`,
      [attemptId, tenant, assessment, cand, status, opts.evaluationReleased ? new Date() : null],
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
        await c.query(
          `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
           VALUES ($1,$2,$3,'deterministic',10,10,'correct','deterministic-mcq-v1','deterministic-mcq-v1','none')`,
          [tenant, attemptId, qid],
        );
      } else {
        await c.query(`INSERT INTO attempt_answers (attempt_id, question_id, answer) VALUES ($1,$2,$3::jsonb)`, [attemptId, qid, JSON.stringify({ response: "my written answer" })]);
        if (opts.gradings !== undefined) {
          await c.query(
            `INSERT INTO gradings (tenant_id, attempt_id, question_id, grader, score_earned, score_max, status, prompt_version_sha, prompt_version_label, model)
             VALUES ($1,$2,$3,'ai',$4,10,$5,$6,'v1','test-model')`,
            [tenant, attemptId, qid, opts.gradings === "all" ? 8 : 0, opts.gradings === "all" ? "correct" : "review_needed", `sha-${randomUUID().slice(0, 8)}`],
          );
        }
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

const att = (id: string) =>
  sup((c) =>
    c
      .query(
        `SELECT status, evaluation_released_at IS NOT NULL AS released, evaluation_released_by AS released_by,
                evaluation_sent_back_at IS NOT NULL AS sent_back
           FROM attempts WHERE id = $1`,
        [id],
      )
      .then((r) => r.rows[0] as { status: string; released: boolean; released_by: string | null; sent_back: boolean }),
  );
const billing = (id: string) =>
  sup((c) => c.query(`SELECT COUNT(*)::int n FROM billing_events WHERE attempt_id = $1 AND event_type = 'assessment_graded'`, [id]).then((r) => r.rows[0].n as number));
const aiGradingId = (id: string) =>
  sup((c) => c.query(`SELECT id FROM gradings WHERE attempt_id = $1 AND grader = 'ai' LIMIT 1`, [id]).then((r) => r.rows[0].id as string));
const auditRows = (entityId: string, action: string) =>
  sup((c) =>
    c
      .query(`SELECT tenant_id::text, actor_user_id::text, after FROM audit_log WHERE entity_id = $1 AND action = $2`, [entityId, action])
      .then((r) => r.rows as Array<{ tenant_id: string; actor_user_id: string; after: unknown }>),
  );

// ---------------------------------------------------------------------------
// 1. The queue
// ---------------------------------------------------------------------------

describe("platform evaluation queue — cross-tenant, blind", () => {
  it("lists only eligible rows across tenants and carries no candidate PII", async () => {
    const a1 = await seed(A, adminA, "submitted", ["mcq", "subjective"]);
    const b1 = await seed(B, adminB, "pending_admin_grading", ["subjective", "kql"]);
    const waiting = await seed(A, adminA, "graded", ["subjective"], { gradings: "all" }); // graded, not released yet
    const mcqOnly = await seed(A, adminA, "submitted", ["mcq"]);
    const erased = await seed(A, adminA, "submitted", ["subjective"], { erased: true });
    const published = await seed(A, adminA, "released", ["subjective"], { gradings: "all", evaluationReleased: true });
    const ready = await seed(A, adminA, "graded", ["subjective"], { gradings: "all", evaluationReleased: true });
    const suspended = await seed(C, adminC, "submitted", ["subjective"]);

    const q = await handleSuperListEvaluations();
    const ids = q.items.map((i) => i.attempt_id);
    expect(ids).toEqual(expect.arrayContaining([a1.attemptId, b1.attemptId, waiting.attemptId]));
    for (const x of [mcqOnly, erased, published, ready, suspended]) expect(ids).not.toContain(x.attemptId);

    expect(q.items.find((i) => i.attempt_id === b1.attemptId)).toMatchObject({
      tenant_id: B,
      tenant_name: "Tenant B",
      assessment_name: "Placement Test",
      level_label: "L1",
      status: "pending_admin_grading",
      written_count: 1,
      kql_count: 1,
      complete: false,
      grading_in_progress: false,
      sent_back: false,
      sent_back_note: null,
    });
    expect(q.items.find((i) => i.attempt_id === waiting.attemptId)).toMatchObject({ complete: true, status: "graded" });
    expect(q.items.find((i) => i.attempt_id === a1.attemptId)!.age_hours).toBeGreaterThanOrEqual(0.9); // submitted ~1 h ago
    expect(q.counts.pending).toBe(q.items.length);
    expect(q.counts.older_than_24h).toBe(0);

    // blind evaluation: no candidate identity anywhere in the payload
    expect(JSON.stringify(q)).not.toContain(PII_EMAIL);
    expect(JSON.stringify(q)).not.toContain(PII_NAME);
    for (const key of Object.keys(q.items[0]!)) expect(key).not.toMatch(/email|^name$|candidate|user_id/);

    // tenant filter
    const onlyB = await handleSuperListEvaluations({ tenantId: B });
    expect(onlyB.items.length).toBeGreaterThan(0);
    expect(onlyB.items.every((i) => i.tenant_id === B)).toBe(true);
    expect(onlyB.items.map((i) => i.attempt_id)).toContain(b1.attemptId);
  });

  it("resolveEvaluationTenant: 404 for an unknown attempt, 409 TENANT_NOT_ACTIVE for a suspended tenant", async () => {
    const ok = await seed(B, adminB, "submitted", ["subjective"]);
    expect(await resolveEvaluationTenant(ok.attemptId)).toBe(B);

    await expect(resolveEvaluationTenant(randomUUID())).rejects.toMatchObject({ code: "AIG_ATTEMPT_NOT_FOUND", status: 404 });

    const onSuspended = await seed(C, adminC, "submitted", ["subjective"]);
    await expect(resolveEvaluationTenant(onSuspended.attemptId)).rejects.toMatchObject({
      status: 409,
      details: { code: "TENANT_NOT_ACTIVE" },
    });
  });

  it("assertInEvaluationQueue: AI grade/rerun only on queue items", async () => {
    const inQueue = await seed(B, adminB, "submitted", ["subjective"]);
    await expect(assertInEvaluationQueue(inQueue.attemptId)).resolves.toBeUndefined();

    const mcqOnly = await seed(A, adminA, "submitted", ["mcq"]);
    const handedOver = await seed(A, adminA, "graded", ["subjective"], { gradings: "all", evaluationReleased: true });
    const published = await seed(A, adminA, "released", ["subjective"], { gradings: "all", evaluationReleased: true });
    for (const x of [mcqOnly, handedOver, published]) {
      await expect(assertInEvaluationQueue(x.attemptId)).rejects.toMatchObject({ code: "NOT_IN_EVALUATION_QUEUE", status: 409 });
    }
  });

  it("FU-A11: a company with ai_grading_enabled=false stays listed as ai_paused; grade/rerun guard answers 409 AIG_TENANT_AI_PAUSED", async () => {
    const paused = await seed(B, adminB, "submitted", ["subjective"]);
    const live = await seed(A, adminA, "submitted", ["subjective"]);
    await sup((c) => c.query(`UPDATE tenant_settings SET ai_grading_enabled = false WHERE tenant_id = $1`, [B]));
    try {
      const q = await handleSuperListEvaluations();
      expect(q.items.find((i) => i.attempt_id === paused.attemptId)).toMatchObject({ ai_paused: true });
      expect(q.items.find((i) => i.attempt_id === live.attemptId)).toMatchObject({ ai_paused: false });
      await expect(assertInEvaluationQueue(paused.attemptId)).rejects.toMatchObject({ code: "AIG_TENANT_AI_PAUSED", status: 409 });
      await expect(assertInEvaluationQueue(live.attemptId)).resolves.toBeUndefined();
    } finally {
      await sup((c) => c.query(`UPDATE tenant_settings SET ai_grading_enabled = true WHERE tenant_id = $1`, [B]));
    }
    await expect(assertInEvaluationQueue(paused.attemptId)).resolves.toBeUndefined();
  });

  it("FU-A11: assertTenantAiEnabled (the AI-start boundary re-check, inside the tenant tx) follows the live flag", async () => {
    await expect(withTenant(B, (c) => assertTenantAiEnabled(c, B))).resolves.toBeUndefined();
    await sup((c) => c.query(`UPDATE tenant_settings SET ai_grading_enabled = false WHERE tenant_id = $1`, [B]));
    try {
      await expect(withTenant(B, (c) => assertTenantAiEnabled(c, B))).rejects.toMatchObject({ code: "AIG_TENANT_AI_PAUSED", status: 409 });
    } finally {
      await sup((c) => c.query(`UPDATE tenant_settings SET ai_grading_enabled = true WHERE tenant_id = $1`, [B]));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The whole lifecycle across a tenant boundary
// ---------------------------------------------------------------------------

describe("evaluate another tenant's attempt -> release to tenant -> tenant review -> send back", () => {
  it("super admin evaluates tenant B's attempt; the tenant sees nothing until release; override gated; send-back keeps status and billing", async () => {
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "subjective", "kql"]);
    expect(await resolveEvaluationTenant(attemptId)).toBe(B);

    // Evaluate (the one AI trigger — mocked), with the SUPER admin as actor, in B's tenant context.
    mockGrade.mockResolvedValue(proposal(attemptId, qids[1]!));
    const g = await handleAdminGrade({ tenantId: B, userId: superUser, attemptId, sessionLastActivity: new Date() });
    expect(g.proposals).toHaveLength(1);
    expect(mockGrade).toHaveBeenCalledTimes(1);

    // Platform GET: sees the AI review state, blind to the candidate.
    const s0 = await handleSuperGetEvaluation({ tenantId: B, attemptId });
    expect(s0).toMatchObject({ tenant_id: B, tenant_name: "Tenant B", attempt: { id: attemptId, status: "submitted" } });
    expect(s0.ai_proposals).toHaveLength(1);
    expect(s0.frozen_questions).toHaveLength(3);
    expect(s0.attempt).not.toHaveProperty("candidate_email");
    expect(s0.attempt).not.toHaveProperty("candidate_name");
    expect(JSON.stringify(s0)).not.toContain(PII_EMAIL);
    expect(JSON.stringify(s0)).not.toContain(PII_NAME);

    // Tenant GET while the evaluation is with AssessIQ: no AI state, no grades, no score, no side effect.
    const t0 = await handleAdminClaimAttempt({ tenantId: B, userId: adminB, attemptId });
    expect(t0).toMatchObject({
      evaluation_status: "awaiting_evaluation",
      ai_proposals: null,
      grading_started_at: null,
      gradings: [],
      score: null,
      attempt: { status: "submitted", candidate_name: expect.stringContaining(PII_NAME) },
    });
    expect((await att(attemptId)).status).toBe("submitted");

    // Accept (platform): the KQL question is still ungraded -> incomplete -> cannot be released.
    const acc = await handleAdminAccept({ tenantId: B, userId: superUser, attemptId, proposals: g.proposals, markEvaluationReleased: false });
    expect(acc.attempt.status).toBe("pending_admin_grading");
    await expect(handleSuperReleaseToTenant({ tenantId: B, userId: superUser, attemptId })).rejects.toMatchObject({
      code: "EVALUATION_NOT_COMPLETE",
      status: 409,
    });

    // Manual KQL score (platform) completes it: graded + billed once, but NOT released to the tenant.
    const man = await handleAdminManualScore({
      tenantId: B, userId: superUser, attemptId, questionId: qids[2]!, scoreEarned: 7, reason: "query is right", markEvaluationReleased: false,
    });
    expect(man.attempt.status).toBe("graded");
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false });
    expect(await billing(attemptId)).toBe(1);
    expect((await handleSuperListEvaluations({ tenantId: B })).items.find((i) => i.attempt_id === attemptId)).toMatchObject({ complete: true });

    // Tenant override is refused until the release.
    const gid = await aiGradingId(attemptId);
    await expect(
      handleAdminOverride({ tenantId: B, userId: adminB, gradingId: gid, override: { score_earned: 3, reason: "x" }, requireEvaluationReleased: true }),
    ).rejects.toMatchObject({ code: "EVALUATION_NOT_RELEASED", status: 409 });

    // Release to tenant: sets the marker + one audit row in B's log with the super admin as actor.
    const rel = await handleSuperReleaseToTenant({ tenantId: B, userId: superUser, attemptId });
    expect(rel.attempt_id).toBe(attemptId);
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser, sent_back: false });
    const audits = await auditRows(attemptId, "grading.evaluation_released");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenant_id: B, actor_user_id: superUser });
    await expect(handleSuperReleaseToTenant({ tenantId: B, userId: superUser, attemptId })).rejects.toMatchObject({
      code: "EVALUATION_ALREADY_RELEASED",
    });
    expect((await handleSuperListEvaluations({ tenantId: B })).items.map((i) => i.attempt_id)).not.toContain(attemptId);

    // The tenant now sees the final grades and score, but never the AI review state.
    const t1 = await handleAdminClaimAttempt({ tenantId: B, userId: adminB, attemptId });
    expect(t1).toMatchObject({ evaluation_status: "ready_to_publish", ai_proposals: null });
    expect(t1.gradings).toHaveLength(3);
    expect(t1.score).toMatchObject({ total_max: 30 });

    // ... and may override a score now (status / release marker untouched).
    const ov = await handleAdminOverride({
      tenantId: B, userId: adminB, gradingId: gid, override: { score_earned: 3, reason: "recheck" }, requireEvaluationReleased: true,
    });
    expect(ov.grading).toMatchObject({ grader: "admin_override", score_earned: 3 });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true });

    // Send back: marker cleared, status stays 'graded', no second bill, audit row without the note.
    await handleAdminSendBack({ tenantId: B, userId: adminB, attemptId, note: "please re-check Q2 (private)" });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, sent_back: true });
    expect(await billing(attemptId)).toBe(1);
    const sb = await auditRows(attemptId, "grading.sent_back");
    expect(sb).toHaveLength(1);
    expect(JSON.stringify(sb[0])).not.toContain("private");

    // Back in the platform queue with the note; hidden from the tenant again.
    expect((await handleSuperListEvaluations({ tenantId: B })).items.find((i) => i.attempt_id === attemptId)).toMatchObject({
      sent_back: true,
      sent_back_note: "please re-check Q2 (private)",
      complete: true,
    });
    const t2 = await handleAdminClaimAttempt({ tenantId: B, userId: adminB, attemptId });
    expect(t2).toMatchObject({ evaluation_status: "awaiting_evaluation", gradings: [], score: null });

    // The platform re-evaluates (override is part of the evaluation — no "released first" gate;
    // a grading id from another attempt is refused) and releases again, which clears the marker.
    await expect(
      handleAdminOverride({ tenantId: B, userId: superUser, gradingId: gid, override: { score_earned: 9, reason: "r" }, expectedAttemptId: randomUUID() }),
    ).rejects.toMatchObject({ code: "AIG_GRADING_NOT_FOUND", status: 404 });
    await handleAdminOverride({
      tenantId: B, userId: superUser, gradingId: gid, override: { score_earned: 9, reason: "re-evaluated" },
      expectedAttemptId: attemptId, markEvaluationReleased: false,
    });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false });
    await handleSuperReleaseToTenant({ tenantId: B, userId: superUser, attemptId });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, sent_back: false });
  });
});

// ---------------------------------------------------------------------------
// 3. Release-to-tenant refusals + bulk
// ---------------------------------------------------------------------------

describe("release to tenant — refusals and bulk (one tx per attempt)", () => {
  it("releases only the complete one; reports every other attempt with a stable code", async () => {
    const good = await seed(A, adminA, "graded", ["subjective"], { gradings: "all" });
    const incomplete = await seed(A, adminA, "pending_admin_grading", ["subjective"]);
    const flagged = await seed(A, adminA, "graded", ["subjective"], { gradings: "flagged" });
    const erased = await seed(A, adminA, "graded", ["subjective"], { gradings: "all", erased: true });
    const published = await seed(A, adminA, "released", ["subjective"], { gradings: "all", evaluationReleased: true });
    const onSuspended = await seed(C, adminC, "graded", ["subjective"], { gradings: "all" });
    const unknown = randomUUID();

    const res = await handleSuperReleaseToTenantBulk({
      userId: superUser,
      attemptIds: [
        good.attemptId, incomplete.attemptId, flagged.attemptId, erased.attemptId,
        published.attemptId, onSuspended.attemptId, unknown, good.attemptId /* duplicate: once */,
      ],
    });
    expect(res.released).toEqual([good.attemptId]);
    expect(Object.fromEntries(res.skipped.map((s) => [s.id, s.code]))).toEqual({
      [incomplete.attemptId]: "EVALUATION_NOT_COMPLETE",
      [flagged.attemptId]: "EVALUATION_NOT_COMPLETE",
      [erased.attemptId]: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED",
      [published.attemptId]: "RESULT_ALREADY_PUBLISHED",
      [onSuspended.attemptId]: "TENANT_NOT_ACTIVE",
      [unknown]: "AIG_ATTEMPT_NOT_FOUND",
    });

    expect(await att(good.attemptId)).toMatchObject({ released: true, released_by: superUser });
    for (const x of [incomplete, flagged, erased, onSuspended]) expect((await att(x.attemptId)).released).toBe(false);
    expect(await auditRows(good.attemptId, "grading.evaluation_released")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Route layer
// ---------------------------------------------------------------------------

function newApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.toJson() });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  return app;
}

describe("route layer", () => {
  it("tenant grade / accept / rerun / manual-score / grading-jobs retry -> 403 AI_EVALUATION_BY_ASSESSIQ; override gated; send-back validated", async () => {
    const app = newApp();
    const session = async (req: { session?: unknown }) => {
      req.session = { tenantId: A, userId: adminA, lastSeenAt: new Date().toISOString() };
    };
    await registerGradingRoutes(app, { adminOnly: [session as never], adminFreshMfa: [session as never] });

    const q = randomUUID();
    for (const urlPath of [
      `/api/admin/attempts/${randomUUID()}/grade`,
      `/api/admin/attempts/${randomUUID()}/accept`,
      `/api/admin/attempts/${randomUUID()}/rerun`,
      `/api/admin/attempts/${randomUUID()}/questions/${q}/manual-score`,
      `/api/admin/grading-jobs/${randomUUID()}/retry`,
    ]) {
      const res = await app.inject({ method: "POST", url: urlPath, payload: {} });
      expect(res.statusCode, urlPath).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "AI_EVALUATION_BY_ASSESSIQ" } });
    }

    // Override before the platform released the evaluation -> 409.
    const waiting = await seed(A, adminA, "graded", ["subjective"], { gradings: "all" });
    const gid = await aiGradingId(waiting.attemptId);
    const ov = await app.inject({ method: "POST", url: `/api/admin/gradings/${gid}/override`, payload: { score_earned: 5, reason: "r" } });
    expect(ov.statusCode).toBe(409);
    expect(ov.json()).toMatchObject({ error: { code: "EVALUATION_NOT_RELEASED" } });

    // Send-back: a note is required; and only a released evaluation can be sent back.
    const noNote = await app.inject({ method: "POST", url: `/api/admin/attempts/${waiting.attemptId}/send-back`, payload: { note: "  " } });
    expect(noNote.statusCode).toBe(400);
    const notReleased = await app.inject({ method: "POST", url: `/api/admin/attempts/${waiting.attemptId}/send-back`, payload: { note: "why" } });
    expect(notReleased.statusCode).toBe(409);
    expect(notReleased.json()).toMatchObject({ error: { code: "EVALUATION_NOT_RELEASED" } });
    await app.close();
  });

  it("platform routes: queue without PII, 404 for unknown attempts, release-to-tenant (single + bulk), tenant never taken from the session", async () => {
    const app = newApp();
    // A different tenant id in the session proves the attempt's tenant is resolved from the DB.
    const session = async (req: { session?: unknown }) => {
      req.session = { tenantId: P, userId: superUser, lastSeenAt: new Date().toISOString() };
    };
    await registerSuperEvaluationRoutes(app, { superAdminOnly: [session as never], superAdminFreshMfa: [session as never] });

    const target = await seed(B, adminB, "graded", ["subjective"], { gradings: "all" });
    const target2 = await seed(B, adminB, "graded", ["subjective"], { gradings: "all" });

    const list = await app.inject({ method: "GET", url: `/api/admin/super/evaluations?tenant_id=${B}` });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(PII_EMAIL);
    expect(list.json().items.map((i: { attempt_id: string }) => i.attempt_id)).toContain(target.attemptId);

    const detail = await app.inject({ method: "GET", url: `/api/admin/super/evaluations/${target.attemptId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ tenant_id: B, evaluation_released_at: null });
    expect(detail.body).not.toContain(PII_EMAIL);

    expect((await app.inject({ method: "GET", url: `/api/admin/super/evaluations/${randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/admin/super/evaluations/not-a-uuid` })).statusCode).toBe(400);

    const one = await app.inject({ method: "POST", url: `/api/admin/super/evaluations/${target.attemptId}/release-to-tenant` });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ attempt_id: target.attemptId, evaluation_released_at: expect.any(String) });
    expect((await att(target.attemptId)).released).toBe(true);

    const bulk = await app.inject({
      method: "POST",
      url: `/api/admin/super/evaluations/release-to-tenant`,
      payload: { attempt_ids: [target.attemptId, target2.attemptId] },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toEqual({
      released: [target2.attemptId],
      skipped: [{ id: target.attemptId, code: "EVALUATION_ALREADY_RELEASED" }],
    });
    const empty = await app.inject({ method: "POST", url: `/api/admin/super/evaluations/release-to-tenant`, payload: { attempt_ids: [] } });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Owner decision 2026-10-01: the LAST accept / score releases to the company
// ---------------------------------------------------------------------------

const cacheState = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT ai_proposals IS NOT NULL AS cached, grading_started_at IS NOT NULL AS marker FROM attempts WHERE id = $1`, [id])
      .then((r) => r.rows[0] as { cached: boolean; marker: boolean }),
  );
const totals = (id: string) =>
  sup((c) =>
    c
      .query(`SELECT total_earned::float AS e, total_max::float AS m FROM attempt_scores WHERE attempt_id = $1`, [id])
      .then((r) => r.rows[0] as { e: number; m: number } | undefined),
  );
/** The AI rows of one question, oldest first. */
const aiRows = (attemptId: string, questionId: string) =>
  sup((c) =>
    c
      .query(
        `SELECT id::text, score_earned::float AS score_earned, override_of::text AS override_of, prompt_version_sha
           FROM gradings WHERE attempt_id = $1 AND question_id = $2 AND grader = 'ai' ORDER BY graded_at, id`,
        [attemptId, questionId],
      )
      .then((r) => r.rows as Array<{ id: string; score_earned: number; override_of: string | null; prompt_version_sha: string }>),
  );
/** grading.override audit rows written for one attempt (manual first score or override). */
const overrideAudits = (gradingId: string) => auditRows(gradingId, "grading.override");

describe("release on the last accept (owner decision 2026-10-01)", () => {
  const SESSION = async (req: { session?: unknown }) => {
    req.session = { tenantId: P, userId: superUser, lastSeenAt: new Date().toISOString() };
  };
  let app: ReturnType<typeof newApp>;
  let D: string; // Auto-mode tenant (the sweep publishes what it is handed)
  let adminD: string;
  let E: string; // manual tenant that switches to Auto AFTER a result became ready
  let adminE: string;

  const post = (path: string, payload?: object) =>
    payload === undefined
      ? app.inject({ method: "POST", url: `/api/admin/super/evaluations/${path}` })
      : app.inject({ method: "POST", url: `/api/admin/super/evaluations/${path}`, payload });

  beforeAll(async () => {
    app = newApp();
    await registerSuperEvaluationRoutes(app, { superAdminOnly: [SESSION as never], superAdminFreshMfa: [SESSION as never] });
    [D, E, adminD, adminE] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await sup(async (c) => {
      for (const [id, slug, admin, mode] of [
        [D, "t-auto", adminD, "auto"],
        [E, "t-late-auto", adminE, "manual"],
      ] as const) {
        await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)`, [id, slug, `Tenant ${slug}`]);
        await c.query(
          `INSERT INTO tenant_settings (tenant_id, result_release_mode, result_release_auto_since)
           VALUES ($1, $2, ${mode === "auto" ? "now() - interval '1 hour'" : "NULL"})`,
          [id, mode],
        );
        await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'Admin','admin','active')`, [admin, id, `${slug}@x.test`]);
      }
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("the accept that COMPLETES the attempt releases it: released_at + released_by, off the queue, tenant sees ready_to_publish, billed once, hand-over on the accept's own audit row", async () => {
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "subjective"]);
    const res = await post(`${attemptId}/accept`, { proposals: [proposal(attemptId, qids[1]!)] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attempt: { id: attemptId, status: "graded" } });

    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser, sent_back: false });
    expect(await billing(attemptId)).toBe(1);
    expect((await handleSuperListEvaluations({ tenantId: B })).items.map((i) => i.attempt_id)).not.toContain(attemptId);

    const t = await handleAdminClaimAttempt({ tenantId: B, userId: adminB, attemptId });
    expect(t).toMatchObject({ evaluation_status: "ready_to_publish", ai_proposals: null });
    expect(t.score).toMatchObject({ total_earned: 18, total_max: 20 });

    // No new audit call site: the hand-over rides on the existing accept row (target tenant's log, super admin as actor).
    const accepted = await auditRows(attemptId, "grading.accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ tenant_id: B, actor_user_id: superUser, after: { attempt_status_now: "graded", evaluation_released: true } });
    expect(await auditRows(attemptId, "grading.evaluation_released")).toHaveLength(0);

    // Released attempts are not in the queue any more, so the AI cannot be run on them again.
    const again = await post(`${attemptId}/rerun`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "NOT_IN_EVALUATION_QUEUE" } });
  });

  it("an accept that does NOT complete it leaves it unreleased; the manual KQL score that completes it releases it (audit on the manual-score row)", async () => {
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "subjective", "kql"]);
    const acc = await post(`${attemptId}/accept`, { proposals: [proposal(attemptId, qids[1]!)] });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ attempt: { status: "pending_admin_grading" } });
    expect((await att(attemptId)).released).toBe(false);
    expect(await billing(attemptId)).toBe(0);
    const partial = await auditRows(attemptId, "grading.accepted");
    expect(partial[0]!.after).toMatchObject({ attempt_status_now: "pending_admin_grading" });
    expect(partial[0]!.after).not.toHaveProperty("evaluation_released");

    const man = await post(`${attemptId}/questions/${qids[2]}/manual-score`, { score_earned: 7, reason: "query is right" });
    expect(man.statusCode).toBe(200);
    expect(man.json()).toMatchObject({ attempt: { status: "graded" } });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser });
    expect(await billing(attemptId)).toBe(1);
    const audit = await overrideAudits(man.json().grading.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tenant_id: B, actor_user_id: superUser, after: { kind: "manual_first_score", evaluation_released: true } });
    expect(JSON.stringify(audit[0])).not.toContain("query is right"); // PII policy unchanged
  });

  it("an override that resolves the last flagged grade completes + releases it; on a SENT-BACK attempt an override never releases — only Release to company does", async () => {
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "scenario"]);
    const failed = proposal(attemptId, qids[1]!, {
      band: { reasoning_band: 0, ai_justification: "", error_class: "AIG_RUNTIME_FAILURE", needs_escalation: false },
      score_earned: 0,
      prompt_version_sha: "error:no-sha",
      model: "none",
      escalation_chosen_stage: null,
    });
    const acc = await post(`${attemptId}/accept`, { proposals: [failed] });
    expect(acc.json()).toMatchObject({ attempt: { status: "pending_admin_grading" }, gradings: [{ status: "review_needed" }] });
    expect((await att(attemptId)).released).toBe(false);

    const flaggedId = acc.json().gradings[0].id as string;
    const ov = await post(`${attemptId}/gradings/${flaggedId}/override`, { score_earned: 9, reason: "AI failed; graded by hand" });
    expect(ov.statusCode).toBe(200);
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser });
    expect((await overrideAudits(ov.json().grading.id))[0]).toMatchObject({ after: { evaluation_released: true } });

    // The company sends it back; the evaluator re-evaluates with an override: still graded, NOT auto-released.
    await handleAdminSendBack({ tenantId: B, userId: adminB, attemptId, note: "please re-check" });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, sent_back: true });
    const ov2 = await post(`${attemptId}/gradings/${ov.json().grading.id}/override`, { score_earned: 6, reason: "second look" });
    expect(ov2.statusCode).toBe(200);
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, released_by: null, sent_back: true });
    expect(await billing(attemptId)).toBe(1);
    const second = (await overrideAudits(ov2.json().grading.id))[0]!;
    expect(second.after).not.toHaveProperty("evaluation_released");
    expect(await totals(attemptId)).toMatchObject({ e: 16, m: 20 });

    // Release to company (the recovery action) hands it back and clears the send-back marker.
    const rel = await post(`${attemptId}/release-to-tenant`);
    expect(rel.statusCode).toBe(200);
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser, sent_back: false });
  });

  it("Re-run AI on a sent-back attempt: marker held during the run, proposals cached; accepting them (SAME prompt sha) writes NEW rows and updates the score; replays and stale proposals are skipped", async () => {
    const SHA = "anchors:11111111;band:22222222;escalate:-";
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "subjective"]);
    // first evaluation: 8/10 on Q2; the accept completes and releases it
    const first = await post(`${attemptId}/accept`, { proposals: [proposal(attemptId, qids[1]!, { prompt_version_sha: SHA, score_earned: 8 })] });
    expect(first.statusCode).toBe(200);
    expect(await totals(attemptId)).toMatchObject({ e: 18, m: 20 });
    await handleAdminSendBack({ tenantId: B, userId: adminB, attemptId, note: "Q2 looks too generous" });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, sent_back: true });

    // Re-run AI (attempt level). Mocked runtime: same prompt sha as the first pass, a different verdict.
    let markerDuring: boolean | undefined;
    mockGrade.mockImplementation(async (input) => {
      markerDuring = (await cacheState(attemptId)).marker;
      return proposal(input.attempt_id, input.question_id, { prompt_version_sha: SHA, score_earned: 4 });
    });
    const rr = await post(`${attemptId}/rerun`, {});
    expect(rr.statusCode).toBe(200);
    const proposals = rr.json().proposals as GradingProposal[];
    expect(proposals).toHaveLength(1); // only the AI-gradeable question
    expect(markerDuring).toBe(true);
    expect(await cacheState(attemptId)).toEqual({ cached: true, marker: false });
    // same rubric resolution as Grade all (a rubric-less subjective question grades on the reasoning band, not a hard fail)
    expect(mockGrade.mock.calls[0]![0].rubric).toMatchObject({ anchor_weight_total: 0, reasoning_weight_total: 100 });
    // the evaluate page's GET returns the cached proposals (survives a dropped response / tab navigation)
    const detail = await app.inject({ method: "GET", url: `/api/admin/super/evaluations/${attemptId}` });
    expect(detail.json()).toMatchObject({ attempt: { status: "graded" }, evaluation_released_at: null });
    expect(detail.json().ai_proposals).toHaveLength(1);
    // D8: nothing is committed by the re-run itself
    expect(await totals(attemptId)).toMatchObject({ e: 18, m: 20 });
    expect(await aiRows(attemptId, qids[1]!)).toHaveLength(1);

    // Accept the re-run result: a NEW row that supersedes the old one (same sha -> override_of keeps the D7 index happy)
    const acc = await post(`${attemptId}/accept`, { proposals });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ attempt: { status: "graded" } });
    const rows = await aiRows(attemptId, qids[1]!);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ score_earned: 4, override_of: rows[0]!.id, prompt_version_sha: SHA });
    expect(await totals(attemptId)).toMatchObject({ e: 14, m: 20 }); // recomputed in the same locked tx
    // still graded + unreleased (a sent-back attempt is never auto-released), billed exactly once
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, released_by: null, sent_back: true });
    expect(await billing(attemptId)).toBe(1);
    const audits = await auditRows(attemptId, "grading.accepted");
    expect(audits.at(-1)!.after).toMatchObject({ attempt_status_now: "graded", grading_count: 1 });
    expect(audits.at(-1)!.after).not.toHaveProperty("evaluation_released");

    // Replaying the same Accept (double click / retry) writes nothing more.
    await post(`${attemptId}/accept`, { proposals });
    expect(await aiRows(attemptId, qids[1]!)).toHaveLength(2);

    // A human override made AFTER the re-run beats a stale re-run proposal.
    const ov = await post(`${attemptId}/gradings/${rows[1]!.id}/override`, { score_earned: 9, reason: "re-checked by hand" });
    expect(ov.statusCode).toBe(200);
    await post(`${attemptId}/accept`, { proposals });
    expect(await aiRows(attemptId, qids[1]!)).toHaveLength(2);
    expect(await totals(attemptId)).toMatchObject({ e: 19, m: 20 });

    // Release to company hands it back; the send-back marker and the review cache are cleared.
    expect((await post(`${attemptId}/release-to-tenant`)).statusCode).toBe(200);
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: true, released_by: superUser, sent_back: false });
    expect(await cacheState(attemptId)).toEqual({ cached: false, marker: false });
  });

  it("Re-run on a PRE-graded attempt keeps its old behaviour: no marker, no cache (the per-question Opus helper)", async () => {
    const { attemptId } = await seed(B, adminB, "pending_admin_grading", ["subjective"]);
    mockGrade.mockImplementation(async (input) => proposal(input.attempt_id, input.question_id));
    const rr = await post(`${attemptId}/rerun`, { forceEscalate: true });
    expect(rr.statusCode).toBe(200);
    expect(rr.json().proposals).toHaveLength(1);
    expect(await cacheState(attemptId)).toEqual({ cached: false, marker: false });
  });

  it("a failed Re-run AI never leaves the in-progress marker behind (and the AI is only reachable on a click: 409 for an attempt not in the queue)", async () => {
    const { attemptId } = await seed(B, adminB, "graded", ["subjective"], { gradings: "all" });
    await sup((c) => c.query(`UPDATE attempts SET evaluation_sent_back_at = now() WHERE id = $1`, [attemptId]));
    // the audit write (last step of the run) fails -> the whole run errors after the marker was set
    await sup((c) =>
      c.query(`CREATE OR REPLACE FUNCTION t_rerun_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'grading.retry' AND NEW.entity_id = '${attemptId}' THEN RAISE EXCEPTION 'audit down'; END IF; RETURN NEW; END $$;
               CREATE TRIGGER t_rerun_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION t_rerun_audit_fail()`),
    );
    mockGrade.mockImplementation(async (input) => proposal(input.attempt_id, input.question_id));
    try {
      const rr = await post(`${attemptId}/rerun`, {});
      expect(rr.statusCode).toBe(500);
    } finally {
      await sup((c) => c.query(`DROP TRIGGER t_rerun_audit_fail ON audit_log`));
    }
    expect(await cacheState(attemptId)).toEqual({ cached: false, marker: false });
    // single-flight slot was released: a second run is accepted
    const ok = await post(`${attemptId}/rerun`, {});
    expect(ok.statusCode).toBe(200);
  });

  it("an erased candidate's completed attempt is NEVER handed to the company (gate unchanged): graded, unreleased, release-to-tenant still 422", async () => {
    const { attemptId, qids } = await seed(B, adminB, "submitted", ["mcq", "subjective"], { erased: true });
    const res = await post(`${attemptId}/accept`, { proposals: [proposal(attemptId, qids[1]!)] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attempt: { status: "graded" } });
    expect(await att(attemptId)).toMatchObject({ status: "graded", released: false, released_by: null });
    expect((await auditRows(attemptId, "grading.accepted"))[0]!.after).not.toHaveProperty("evaluation_released");
    await expect(handleSuperReleaseToTenant({ tenantId: B, userId: superUser, attemptId })).rejects.toMatchObject({
      code: "AIG_ATTEMPT_NOT_RELEASABLE_ERASED",
      status: 422,
    });
  });

  it("Auto-mode tenant: the completion-time release is what the sweep publishes (audit actor = the evaluator, trigger auto); a manual tenant, and a result ready BEFORE the switch to Auto, stay with the company", async () => {
    resetAutoReleaseCooldownForTesting();
    vi.mocked(sendResultReleasedEmail).mockClear();
    const auto = await seed(D, adminD, "submitted", ["mcq", "subjective"]);
    const manual = await seed(B, adminB, "submitted", ["mcq", "subjective"]);
    const early = await seed(E, adminE, "submitted", ["mcq", "subjective"]); // E is still manual when this completes
    for (const x of [auto, manual, early]) {
      expect((await post(`${x.attemptId}/accept`, { proposals: [proposal(x.attemptId, x.qids[1]!)] })).statusCode).toBe(200);
      expect((await att(x.attemptId)).released).toBe(true); // handed to the company at completion time
    }
    // E switches to Auto only now (what the real settings service stamps): the result was ready before the switch
    await sup((c) => c.query(`UPDATE tenant_settings SET result_release_mode = 'auto', result_release_auto_since = now() WHERE tenant_id = $1`, [E]));

    const tick = await processAutoReleaseTick();
    expect(tick.failed).toBe(0);
    expect((await att(auto.attemptId)).status).toBe("released");
    expect((await att(manual.attemptId)).status).toBe("graded");
    expect((await att(early.attemptId)).status).toBe("graded");
    const released = await auditRows(auto.attemptId, "grading.released");
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ tenant_id: D, actor_user_id: superUser, after: { trigger: "auto" } });
    expect(vi.mocked(sendResultReleasedEmail)).toHaveBeenCalledWith({ tenantId: D, attemptId: auto.attemptId });
    expect(vi.mocked(sendResultReleasedEmail)).not.toHaveBeenCalledWith({ tenantId: B, attemptId: manual.attemptId });
  });
});
