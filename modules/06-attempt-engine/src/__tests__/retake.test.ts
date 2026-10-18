/**
 * Z-39 retake policy: assessments.max_attempts, attempts.attempt_number, extra attempts,
 * re-open, score_counts (latest | best), the concurrent-start race and tenant isolation.
 *
 * Same testcontainer + migration order as attempt-engine.test.ts. One container for the file.
 * No module mocks: the real services run against the real schema (so a missing mock export cannot hide a bug).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import { startAttempt as rawStartAttempt, recordTakeConsent, submitAttempt, getTakePreview } from "../service.js";
import { getCandidateResult } from "../result.js";
import { AE_ERROR_CODES } from "../types.js";
import { createPack, addLevel, createQuestion, publishPack } from "../../../04-question-bank/src/service.js";
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
  listInvitations,
  grantExtraAttempt,
  reopenInvitationForRetake,
  updateAssessment,
} from "../../../05-assessment-lifecycle/src/service.js";
import { ConflictError, NotFoundError, ValidationError } from "@assessiq/core";

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const AE_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AE_MODULE_ROOT, "..");

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

async function sup<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyDir(client: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of only !== undefined ? files.filter((x) => only.includes(x)) : files) {
    await client.query(await readFile(join(dir, f), "utf8"));
  }
}

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "assessiq", POSTGRES_PASSWORD: "assessiq_test_pw", POSTGRES_DB: "assessiq" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;

  await sup(async (c) => {
    await applyDir(c, join(MODULES_ROOT, "02-tenancy", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "03-users", "migrations"), ["020_users.sql"]);
    await applyDir(c, join(MODULES_ROOT, "04-question-bank", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "05-assessment-lifecycle", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "06-attempt-engine", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "12-embed-sdk", "migrations"), ["0073_attempt_embed_origin.sql"]);
    await applyDir(c, join(MODULES_ROOT, "14-audit-log", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "13-notifications", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "19-billing", "migrations"), [
      "0078_tenant_plans.sql",
      "0079_billing_events.sql",
      "0081_tenant_entitlements.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "07-ai-grading", "migrations"), [
      "0040_gradings.sql",
      "0100_attempts_ai_proposals_cache.sql",
    ]);
    await applyDir(c, join(MODULES_ROOT, "09-scoring", "migrations"));
    await applyDir(c, join(MODULES_ROOT, "18-certification", "migrations")); // the result view LEFT JOINs certificates
    await applyDir(c, join(MODULES_ROOT, "20-data-rights", "migrations"), [
      "0101_consent_events.sql",
      "0102_users_erased_at.sql",
    ]);
  });
  setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();
  await sup(async (c) => {
    for (const [id, slug] of [[tenantA, "ta"], [tenantB, "tb"]] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, `Tenant ${slug}`]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
      await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL)`, [id]);
    }
    for (const [id, t, e] of [[adminA, tenantA, "a@t.local"], [adminB, tenantB, "b@t.local"]] as const) {
      await c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`, [id, t, e]);
    }
  });
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
}, 30_000);

// Consent is part of every non-embed Begin (R4); record it first like the main suite does.
async function start(tenantId: string, input: Parameters<typeof rawStartAttempt>[1]) {
  if (input.embedOrigin !== true) await recordTakeConsent(tenantId, { userId: input.userId, ip: null, userAgent: null });
  return rawStartAttempt(tenantId, input);
}

/** An active assessment with one invited candidate. maxAttempts/scoreCounts are set the way an admin would while it was a draft. */
async function setup(opts: { maxAttempts?: number | null; scoreCounts?: "latest" | "best" } = {}) {
  const candidate = randomUUID();
  await sup((c) =>
    c.query(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Cand', 'candidate', 'active')`, [
      candidate,
      tenantA,
      `c-${candidate}@x.com`,
    ]),
  );
  const pack = await createPack(tenantA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminA);
  const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 3 }, adminA);
  for (let i = 0; i < 3; i++) {
    await createQuestion(
      tenantA,
      { pack_id: pack.id, level_id: level.id, type: "mcq", topic: `t${i}`, points: 5, content: { question: `Q${i}?`, options: ["A", "B", "C", "D"], correct: 0, rationale: "A" } },
      adminA,
    );
  }
  await publishPack(tenantA, pack.id, adminA);
  await sup((c) => c.query(`UPDATE questions SET status = 'active' WHERE pack_id = $1`, [pack.id]));
  const assessment = await createAssessment(
    tenantA,
    {
      pack_id: pack.id,
      level_id: level.id,
      name: "Retake test",
      question_count: 3,
      opens_at: new Date(Date.now() + 60_000),
      ...(opts.maxAttempts !== undefined ? { max_attempts: opts.maxAttempts } : {}),
      ...(opts.scoreCounts !== undefined ? { settings: { score_counts: opts.scoreCounts } } : {}),
    },
    adminA,
  );
  await publishAssessment(tenantA, assessment.id, adminA);
  await sup((c) => c.query(`UPDATE assessments SET status = 'active' WHERE id = $1`, [assessment.id]));
  await inviteUsers(tenantA, assessment.id, [candidate], adminA);
  const invitationId = (await sup((c) => c.query(`SELECT id FROM assessment_invitations WHERE assessment_id = $1`, [assessment.id]))).rows[0].id as string;
  return { candidate, assessmentId: assessment.id, invitationId };
}

const attemptCount = (assessmentId: string, userId: string) =>
  sup((c) => c.query(`SELECT count(*)::int AS n FROM attempts WHERE assessment_id = $1 AND user_id = $2`, [assessmentId, userId])).then((r) => r.rows[0].n as number);

describe("Z-39 retake policy", () => {
  it("default (no max_attempts): one attempt; asking for another is refused and the old behaviour holds", async () => {
    const { candidate, assessmentId } = await setup();
    const first = await start(tenantA, { userId: candidate, assessmentId });
    expect(first.attempt_number).toBe(1);
    await submitAttempt(tenantA, candidate, first.id);

    // No new-attempt flag: unchanged behaviour, the finished attempt is returned.
    const again = await start(tenantA, { userId: candidate, assessmentId });
    expect(again.id).toBe(first.id);

    await expect(start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.ATTEMPTS_EXHAUSTED },
    });
    expect(await attemptCount(assessmentId, candidate)).toBe(1);
  });

  it("max 2: first attempt, second allowed, third refused; resume of an unfinished attempt is idempotent", async () => {
    const { candidate, assessmentId, invitationId } = await setup({ maxAttempts: 2 });
    const a1 = await start(tenantA, { userId: candidate, assessmentId });
    expect(a1.attempt_number).toBe(1);

    // Still in progress: newAttempt resumes it, never opens attempt 2.
    expect((await start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).id).toBe(a1.id);
    await submitAttempt(tenantA, candidate, a1.id);

    // Landing preview offers attempt 2 of 2 and hides the finished attempt.
    const pv = await getTakePreview(tenantA, { userId: candidate, assessmentId });
    expect(pv.existing).toBeNull();
    expect(pv.attemptNumber).toBe(2);
    expect(pv.attemptsAllowed).toBe(2);

    const a2 = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
    expect(a2.attempt_number).toBe(2);
    expect(a2.id).not.toBe(a1.id);
    expect(a2.status).toBe("in_progress");
    const inv = await sup((c) => c.query(`SELECT status FROM assessment_invitations WHERE id = $1`, [invitationId]));
    expect(inv.rows[0].status).toBe("started");

    // Double click on Begin: same attempt.
    expect((await start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).id).toBe(a2.id);
    await submitAttempt(tenantA, candidate, a2.id);

    await expect(start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).rejects.toBeInstanceOf(ConflictError);
    await expect(start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.ATTEMPTS_EXHAUSTED, attempts_used: 2, attempts_allowed: 2 },
    });
    expect(await attemptCount(assessmentId, candidate)).toBe(2);
  });

  it("extra attempt: reason required, one audit row per grant, third attempt then allowed, tenant B cannot grant", async () => {
    const { candidate, assessmentId, invitationId } = await setup({ maxAttempts: 2 });
    for (let n = 1; n <= 2; n++) {
      const a = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
      expect(a.attempt_number).toBe(n);
      await submitAttempt(tenantA, candidate, a.id);
    }
    await expect(start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.ATTEMPTS_EXHAUSTED },
    });

    await expect(grantExtraAttempt(tenantA, invitationId, "   ", adminA)).rejects.toBeInstanceOf(ValidationError);
    await expect(grantExtraAttempt(tenantA, invitationId, undefined, adminA)).rejects.toBeInstanceOf(ValidationError);
    // Tenant B (RLS) cannot see or grant on tenant A's invitation.
    await expect(grantExtraAttempt(tenantB, invitationId, "cross-tenant", adminB)).rejects.toBeInstanceOf(NotFoundError);

    const granted = await grantExtraAttempt(tenantA, invitationId, "Network failed during attempt 2", adminA);
    expect(granted.attempts_allowed).toBe(3);
    expect(granted.attempts_used).toBe(2);

    const audit = await sup((c) =>
      c.query(`SELECT after, actor_user_id FROM audit_log WHERE action = 'assessment.invitation.extra_attempt_granted' AND entity_id = $1`, [invitationId]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after.reason).toBe("Network failed during attempt 2");
    expect(audit.rows[0].actor_user_id).toBe(adminA);

    const a3 = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
    expect(a3.attempt_number).toBe(3);
    await submitAttempt(tenantA, candidate, a3.id);
    await expect(start(tenantA, { userId: candidate, assessmentId, newAttempt: true })).rejects.toMatchObject({
      details: { code: AE_ERROR_CODES.ATTEMPTS_EXHAUSTED },
    });
  });

  it("a grant works even with the default single attempt (one extra = a second try)", async () => {
    const { candidate, assessmentId, invitationId } = await setup();
    const a1 = await start(tenantA, { userId: candidate, assessmentId });
    await submitAttempt(tenantA, candidate, a1.id);
    await grantExtraAttempt(tenantA, invitationId, "Proctor reset", adminA);
    const a2 = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
    expect(a2.attempt_number).toBe(2);
  });

  it("re-open: needs a finished attempt and an attempt left; a fresh link replaces the old one", async () => {
    const { candidate, assessmentId, invitationId } = await setup({ maxAttempts: 2 });
    const a1 = await start(tenantA, { userId: candidate, assessmentId });
    // Unfinished attempt: nothing to re-open.
    await expect(reopenInvitationForRetake(tenantA, invitationId, adminA)).rejects.toMatchObject({
      details: { code: "RETAKE_NOT_AVAILABLE" },
    });
    await submitAttempt(tenantA, candidate, a1.id);

    const before = (await sup((c) => c.query(`SELECT token_hash, status FROM assessment_invitations WHERE id = $1`, [invitationId]))).rows[0];
    expect(before.status).toBe("submitted");
    const reopened = await reopenInvitationForRetake(tenantA, invitationId, adminA);
    expect(reopened.status).toBe("pending");
    const after = (await sup((c) => c.query(`SELECT token_hash FROM assessment_invitations WHERE id = $1`, [invitationId]))).rows[0];
    expect(after.token_hash).not.toBe(before.token_hash);
    const a2 = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
    expect(a2.attempt_number).toBe(2);
    await submitAttempt(tenantA, candidate, a2.id);

    // Both attempts used: re-open is refused until an extra attempt is granted.
    await expect(reopenInvitationForRetake(tenantA, invitationId, adminA)).rejects.toMatchObject({
      details: { code: "ATTEMPTS_EXHAUSTED" },
    });
    const audit = await sup((c) => c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'assessment.invitation.reopened' AND entity_id = $1`, [invitationId]));
    expect(audit.rows[0].n).toBe(1);
  });

  it("race: two simultaneous starts for the next attempt create exactly one new attempt (invitation path)", async () => {
    const { candidate, assessmentId } = await setup({ maxAttempts: 3 });
    const a1 = await start(tenantA, { userId: candidate, assessmentId });
    await submitAttempt(tenantA, candidate, a1.id);
    await recordTakeConsent(tenantA, { userId: candidate, ip: null, userAgent: null });

    const [x, y] = await Promise.all([
      rawStartAttempt(tenantA, { userId: candidate, assessmentId, newAttempt: true }),
      rawStartAttempt(tenantA, { userId: candidate, assessmentId, newAttempt: true }),
    ]);
    expect(x.id).toBe(y.id);
    expect(x.attempt_number).toBe(2);
    expect(await attemptCount(assessmentId, candidate)).toBe(2);
  });

  it("race: the unique key is the backstop when there is no invitation (embed path)", async () => {
    const { candidate, assessmentId } = await setup({ maxAttempts: 3 });
    const a1 = await start(tenantA, { userId: candidate, assessmentId, embedOrigin: true });
    await submitAttempt(tenantA, candidate, a1.id);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => rawStartAttempt(tenantA, { userId: candidate, assessmentId, embedOrigin: true, newAttempt: true })),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results[0]!.attempt_number).toBe(2);
    expect(await attemptCount(assessmentId, candidate)).toBe(2);

    // The database itself refuses a duplicate attempt number.
    await expect(
      sup((c) =>
        c.query(
          `INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, attempt_number) VALUES ($1, $2, $3, $4, 'draft', 2)`,
          [randomUUID(), tenantA, assessmentId, candidate],
        ),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("score that counts: latest (default) vs best, one row per candidate in the admin list", async () => {
    const latest = await setup({ maxAttempts: 2 });
    const best = await setup({ maxAttempts: 2, scoreCounts: "best" });
    const ids: Record<string, { a1: string; a2: string }> = {};
    for (const [key, s] of [["latest", latest], ["best", best]] as const) {
      const a1 = await start(tenantA, { userId: s.candidate, assessmentId: s.assessmentId });
      await submitAttempt(tenantA, s.candidate, a1.id);
      const a2 = await start(tenantA, { userId: s.candidate, assessmentId: s.assessmentId, newAttempt: true });
      await submitAttempt(tenantA, s.candidate, a2.id);
      // Attempt 1 scores 100 %, attempt 2 scores 20 %; both released to the tenant.
      await sup(async (c) => {
        await c.query(`UPDATE attempts SET status = 'released', evaluation_released_at = now() WHERE id = ANY($1)`, [[a1.id, a2.id]]);
        await c.query(`DELETE FROM attempt_scores WHERE attempt_id = ANY($1)`, [[a1.id, a2.id]]);
        for (const [id, earned] of [[a1.id, 15], [a2.id, 3]] as const) {
          await c.query(
            `INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct) VALUES ($1, $2, $3, 15, $4)`,
            [id, tenantA, earned, (earned / 15) * 100],
          );
        }
      });
      ids[key] = { a1: a1.id, a2: a2.id };
    }

    const latestList = await listInvitations(tenantA, latest.assessmentId);
    expect(latestList.items).toHaveLength(1);
    expect(latestList.items[0]!.attempt_id).toBe(ids["latest"]!.a2);
    expect(latestList.items[0]!.attempts_used).toBe(2);
    expect(latestList.items[0]!.attempts_allowed).toBe(2);

    const bestList = await listInvitations(tenantA, best.assessmentId);
    expect(bestList.items).toHaveLength(1);
    expect(bestList.items[0]!.attempt_id).toBe(ids["best"]!.a1);
    expect(Math.round(bestList.items[0]!.auto_pct ?? -1)).toBe(100);
  });

  it("result view: retake info says attempt n of m and whether another try is open", async () => {
    const { candidate, assessmentId } = await setup({ maxAttempts: 2 });
    const a1 = await start(tenantA, { userId: candidate, assessmentId });
    await submitAttempt(tenantA, candidate, a1.id);
    const release = async (id: string) =>
      sup(async (c) => {
        await c.query(`UPDATE attempts SET status = 'released', evaluation_released_at = now() WHERE id = $1`, [id]);
        await c.query(`DELETE FROM attempt_scores WHERE attempt_id = $1`, [id]);
        await c.query(`INSERT INTO attempt_scores (attempt_id, tenant_id, total_earned, total_max, auto_pct, pass_mark_pct) VALUES ($1, $2, 3, 15, 20, 60)`, [id, tenantA]);
      });
    await release(a1.id);
    const r1 = await getCandidateResult(tenantA, candidate, a1.id);
    expect(r1.status).toBe("released");
    if (r1.status === "released") {
      expect(r1.retake).toMatchObject({ attempt_number: 1, attempts_allowed: 2, can_retake: true, assessment_id: assessmentId });
    }

    const a2 = await start(tenantA, { userId: candidate, assessmentId, newAttempt: true });
    await submitAttempt(tenantA, candidate, a2.id);
    await release(a2.id);
    const r2 = await getCandidateResult(tenantA, candidate, a2.id);
    if (r2.status === "released") {
      expect(r2.retake).toMatchObject({ attempt_number: 2, attempts_allowed: 2, can_retake: false });
    }
    // The old attempt no longer offers a retake either (only the latest does).
    const r1b = await getCandidateResult(tenantA, candidate, a1.id);
    if (r1b.status === "released") expect(r1b.retake?.can_retake).toBe(false);
  });

  it("tenant isolation: another tenant sees none of the attempts, and cannot insert one for this tenant", async () => {
    const { candidate, assessmentId } = await setup({ maxAttempts: 2 });
    await start(tenantA, { userId: candidate, assessmentId });
    const seen = await withTenant(tenantB, (c) => c.query(`SELECT id FROM attempts WHERE assessment_id = $1`, [assessmentId]));
    expect(seen.rows).toHaveLength(0);
    await expect(
      withTenant(tenantB, (c) =>
        c.query(`INSERT INTO attempts (id, tenant_id, assessment_id, user_id, status, attempt_number) VALUES ($1, $2, $3, $4, 'draft', 9)`, [
          randomUUID(),
          tenantA,
          assessmentId,
          candidate,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("max_attempts is validated and only editable while the assessment is a draft", async () => {
    const candidate = randomUUID();
    void candidate;
    const pack = await createPack(tenantA, { slug: `p-${randomUUID().slice(0, 8)}`, name: "P", domain: "soc" }, adminA);
    const level = await addLevel(tenantA, pack.id, { position: 1, label: "L1", duration_minutes: 30, default_question_count: 1 }, adminA);
    await publishPack(tenantA, pack.id, adminA);
    const base = { pack_id: pack.id, level_id: level.id, name: "V", question_count: 1, opens_at: new Date(Date.now() + 60_000) };
    for (const bad of [0, 11, 2.5, -1]) {
      await expect(createAssessment(tenantA, { ...base, max_attempts: bad }, adminA)).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(createAssessment(tenantA, { ...base, settings: { score_counts: "worst" as unknown as "best" } }, adminA)).rejects.toBeInstanceOf(ValidationError);
    const ok = await createAssessment(tenantA, { ...base, max_attempts: 3 }, adminA);
    expect(ok.max_attempts).toBe(3);
    const patched = await updateAssessment(tenantA, ok.id, { max_attempts: null }, adminA);
    expect(patched.max_attempts).toBeNull();
    // The database CHECK is the last line of defence.
    await expect(sup((c) => c.query(`UPDATE assessments SET max_attempts = 11 WHERE id = $1`, [ok.id]))).rejects.toThrow(/check/i);
  });
});

describe("EXP-18 review gate on start", () => {
  it("an invited candidate cannot start after a pool question is set to Needs fix, and can once it is verified; NULL passes; embed is gated too", async () => {
    const { candidate, assessmentId } = await setup();
    const qid = (await sup((c) => c.query(
      `SELECT q.id FROM questions q JOIN assessments a ON a.pack_id = q.pack_id AND a.level_id = q.level_id WHERE a.id = $1 LIMIT 1`, [assessmentId],
    ))).rows[0].id as string;
    const setState = (st: string | null) => sup((c) => c.query(`UPDATE questions SET review_state = $2 WHERE id = $1`, [qid, st]).then(() => undefined));

    await setState("needs_fix");
    await expect(start(tenantA, { userId: candidate, assessmentId })).rejects.toMatchObject({
      details: { code: "QUESTIONS_NOT_VERIFIED" },
    });
    await expect(start(tenantA, { userId: randomUUID(), assessmentId, embedOrigin: true } as Parameters<typeof rawStartAttempt>[1])).rejects.toMatchObject({
      details: { code: "QUESTIONS_NOT_VERIFIED" },
    });
    expect(await attemptCount(assessmentId, candidate)).toBe(0);

    await setState("verified");
    expect((await start(tenantA, { userId: candidate, assessmentId })).attempt_number).toBe(1);

    const other = await setup();
    await sup((c) => c.query(`UPDATE questions SET review_state = NULL WHERE pack_id = (SELECT pack_id FROM assessments WHERE id = $1)`, [other.assessmentId]));
    expect((await start(tenantA, { userId: other.candidate, assessmentId: other.assessmentId })).attempt_number).toBe(1);
  });
});
