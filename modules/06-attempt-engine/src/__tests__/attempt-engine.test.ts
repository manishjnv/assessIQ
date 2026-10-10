/**
 * Integration tests for modules/06-attempt-engine.
 *
 * Same testcontainer pattern as 05-assessment-lifecycle:
 *   1. ALL 02-tenancy migrations (0001–0004)
 *   2. 03-users 020_users.sql ONLY
 *   3. ALL 04-question-bank migrations (0010–0015)
 *   4. ALL 05-assessment-lifecycle migrations (0020–0022)
 *   5. ALL 06-attempt-engine migrations (0030–0033)
 *
 * The container is started ONCE in beforeAll and shared across every test.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";

// Route tests below drive the REAL engine + DB but stub the two external
// collaborators of /take/start (token resolution + session minting).
const routeCtx = vi.hoisted(() => ({
  resolved: null as unknown,
  session: null as { userId: string; tenantId: string } | null,
}));
vi.mock("@assessiq/assessment-lifecycle", async (orig) => ({
  ...(await orig<typeof import("@assessiq/assessment-lifecycle")>()),
  resolveInvitationToken: vi.fn(async () => routeCtx.resolved),
  markInvitationViewedByToken: vi.fn(async () => undefined),
}));
vi.mock("@assessiq/auth", async (orig) => ({
  ...(await orig<typeof import("@assessiq/auth")>()),
  mintCandidateSession: vi.fn(async () => ({ id: "sess-1", token: "sess-token" })),
  // Per-token throttle on /take/start (Redis-backed in prod) — allowed by default.
  consumeRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 60 })),
}));

// Module 06 surface
import {
  startAttempt as rawStartAttempt,
  getTakePreview,
  recordTakeConsent,
  getAttemptForCandidate,
  saveAnswer,
  toggleFlag,
  recordEvent,
  submitAttempt,
  sweepStaleTimersForTenant,
} from "../service.js";
import * as repo from "../repository.js";
import { registerAttemptTakeRoutes } from "../routes.take.js";
import { registerAttemptCandidateRoutes } from "../routes.candidate.js";

// Every non-embed Begin now needs a consent row (R4 invariant lives in
// startAttempt). Test wrapper records consent first (deduped) so the existing
// suites keep exercising the engine; consent-specific tests use rawStartAttempt.
async function startAttempt(
  tenantId: string,
  input: Parameters<typeof rawStartAttempt>[1],
): ReturnType<typeof rawStartAttempt> {
  if (input.embedOrigin !== true) {
    await recordTakeConsent(tenantId, { userId: input.userId, ip: null, userAgent: null });
  }
  return rawStartAttempt(tenantId, input);
}

import { AE_ERROR_CODES } from "../types.js";
import { _resetForTesting as resetRateCap, RATE_CAP_CONSTANTS } from "../rate-cap.js";

// Helpers from 04 + 05
import {
  createPack,
  addLevel,
  createQuestion,
  publishPack,
} from "../../../04-question-bank/src/service.js";
import {
  createAssessment,
  publishAssessment,
  inviteUsers,
} from "../../../05-assessment-lifecycle/src/service.js";

import { AuthzError, ConflictError, NotFoundError, ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Path helper — strip Windows leading slash before drive letter.
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) + sep;
const AE_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AE_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_MIGRATIONS_DIR = join(AE_MODULE_ROOT, "migrations");
// Test-infra catch-up (2026-05-11): 12-embed-sdk migration 0073 adds the
// embed_origin column referenced by repository.ts's ATTEMPT_COLUMNS SELECT;
// 14-audit-log/0050 supplies the audit_log table that G3.D's auditInTx
// wiring in 04-question-bank.createPack now requires.
const EMBED_SDK_MIGRATIONS_DIR = join(MODULES_ROOT, "12-embed-sdk", "migrations");
const AUDIT_LOG_MIGRATIONS_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");
// publishAssessment (called by buildActiveAssessmentWithInvite) calls
// assertPublishEntitled from @assessiq/billing, which queries tenant_plans.
// Without the billing schema migrations the test DB throws
// "relation \"tenant_plans\" does not exist" on every publish-path test.
const BILLING_MIGRATIONS_DIR = join(MODULES_ROOT, "19-billing", "migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let tenantA: string;
let tenantB: string;
let adminA: string;
let adminB: string;

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigrationsFromDir(client: Client, dir: string, only?: string[]): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const filtered = only !== undefined ? files.filter((f) => only.includes(f)) : files;
  for (const f of filtered) {
    const sql = await readFile(join(dir, f), "utf8");
    await client.query(sql);
  }
}

async function insertTenant(client: Client, id: string, slug: string, name: string): Promise<void> {
  await client.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, name]);
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

async function insertAdminUser(client: Client, id: string, tenantId: string, email: string): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Admin', 'admin', 'active')`,
    [id, tenantId, email],
  );
}

async function insertCandidateUser(
  client: Client,
  id: string,
  tenantId: string,
  email: string,
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, $4, 'candidate', 'active')`,
    [id, tenantId, email, name],
  );
}

/** Build a published+activated pack with N active mcq questions on a single level. */
async function buildPublishedPack(
  tenantId: string,
  adminId: string,
  questionCount: number,
  durationMinutes = 30,
): Promise<{ packId: string; levelId: string }> {
  const slug = `test-pack-${randomUUID().slice(0, 8)}`;
  const pack = await createPack(tenantId, { slug, name: "Test Pack", domain: "soc" }, adminId);
  const level = await addLevel(tenantId, pack.id, {
    position: 1,
    label: "L1",
    duration_minutes: durationMinutes,
    default_question_count: questionCount,
  });
  for (let i = 0; i < questionCount; i++) {
    await createQuestion(
      tenantId,
      {
        pack_id: pack.id,
        level_id: level.id,
        type: "mcq",
        topic: `q-topic-${i}`,
        points: 5,
        content: {
          question: `Test question ${i}?`,
          options: ["A", "B", "C", "D"],
          correct: 0,
          rationale: "A is correct.",
        },
      },
      adminId,
    );
  }
  await publishPack(tenantId, pack.id, adminId);

  // Same workflow gap as session 3: createQuestion defaults status=draft and
  // publishPack does not auto-flip; flip via superuser client.
  await withSuperClient(async (client) => {
    await client.query(
      `UPDATE questions SET status = 'active' WHERE pack_id = $1`,
      [pack.id],
    );
  });

  return { packId: pack.id, levelId: level.id };
}

/** Build assessment in 'active' state with an invitation for the given candidate. */
async function buildActiveAssessmentWithInvite(
  tenantId: string,
  adminId: string,
  candidateId: string,
  questionCount: number,
  durationMinutes = 30,
): Promise<{ assessmentId: string; packId: string }> {
  const { packId, levelId } = await buildPublishedPack(tenantId, adminId, questionCount, durationMinutes);
  const assessment = await createAssessment(
    tenantId,
    {
      pack_id: packId,
      level_id: levelId,
      name: "Active Assessment",
      question_count: questionCount,
      opens_at: new Date(Date.now() + 60_000),
    },
    adminId,
  );
  await publishAssessment(tenantId, assessment.id, adminId);

  // Flip published → active via superuser (state machine forbids direct
  // published → active; the boundary cron does it normally).
  await withSuperClient(async (client) => {
    await client.query(
      `UPDATE assessments SET status = 'active' WHERE id = $1`,
      [assessment.id],
    );
  });

  await inviteUsers(tenantId, assessment.id, [candidateId], adminId);
  return { assessmentId: assessment.id, packId };
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "assessiq",
      POSTGRES_PASSWORD: "assessiq_test_pw",
      POSTGRES_DB: "assessiq",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const port = container.getMappedPort(5432);
  const host = container.getHost();
  containerUrl = `postgres://assessiq:assessiq_test_pw@${host}:${port}/assessiq`;

  // Apply migrations in dependency order.
  await withSuperClient(async (client) => {
    await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AL_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AE_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, EMBED_SDK_MIGRATIONS_DIR, ["0073_attempt_embed_origin.sql"]);
    await applyMigrationsFromDir(client, AUDIT_LOG_MIGRATIONS_DIR);
    // Apply only the schema-creating billing migrations (0078 + 0081).
    // 0079 requires the attempts table (module 06) which may not yet exist at
    // this point in the apply sequence. 0080/0082 are backfills against live
    // data and are irrelevant in test containers. 0090 UPDATEs existing rows
    // (noop in an empty DB). Use the 'only' param to be surgical.
    await applyMigrationsFromDir(client, BILLING_MIGRATIONS_DIR, [
      "0078_tenant_plans.sql",
      "0079_billing_events.sql", // submit now finalises MCQ-only attempts (records billing)
      "0081_tenant_entitlements.sql",
    ]);
    // Deterministic MCQ scoring at submit writes gradings + attempt_scores.
    // 0100: finalizeAttemptIfComplete (SP1) clears the review-cache columns on the flip.
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "07-ai-grading", "migrations"), [
      "0040_gradings.sql",
      "0100_attempts_ai_proposals_cache.sql",
    ]);
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "09-scoring", "migrations"));
    // Candidate Begin consent ledger (recordTakeConsent).
    await applyMigrationsFromDir(client, join(MODULES_ROOT, "20-data-rights", "migrations"), [
      "0101_consent_events.sql",
      "0102_users_erased_at.sql", // 05 inviteUsers reads users.erased_at (E3)
    ]);
  });

  // Wire withTenant to point at the test container.
  setPoolForTesting(containerUrl);

  // Seed two tenants and their admin users.
  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "tenant-a", "Tenant A");
    await insertTenant(client, tenantB, "tenant-b", "Tenant B");
    await insertAdminUser(client, adminA, tenantA, "admin-a@test.local");
    await insertAdminUser(client, adminB, tenantB, "admin-b@test.local");
    // assertPublishEntitled (called by publishAssessment inside
    // buildActiveAssessmentWithInvite) queries tenant_plans.tier; tier='internal'
    // bypasses all entitlement checks. Without these rows every publish-path
    // test fails with a 403 ForbiddenError.
    await client.query(
      `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL) ON CONFLICT DO NOTHING`,
      [tenantA],
    );
    await client.query(
      `INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, 'internal', NULL) ON CONFLICT DO NOTHING`,
      [tenantB],
    );
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
}, 30_000);

beforeEach(() => {
  resetRateCap();
});

// ---------------------------------------------------------------------------
// 1. startAttempt
// ---------------------------------------------------------------------------

describe("startAttempt", () => {
  it("happy path — creates attempt + frozen questions + empty answers", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "C1"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 5);

    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    expect(attempt.status).toBe("in_progress");
    expect(attempt.user_id).toBe(candidate);
    expect(attempt.tenant_id).toBe(tenantA);
    expect(attempt.started_at).not.toBeNull();
    expect(attempt.ends_at).not.toBeNull();
    expect(attempt.duration_seconds).toBe(30 * 60);

    // Question + answer rows exist in the right shape.
    await withTenant(tenantA, async (client) => {
      const aqs = await repo.listFrozenQuestionsForAttempt(client, attempt.id);
      expect(aqs).toHaveLength(5);
      expect(aqs.map((q) => q.position).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

      const answers = await repo.listAttemptAnswers(client, attempt.id);
      expect(answers).toHaveLength(5);
      expect(answers.every((a) => a.client_revision === 0)).toBe(true);
      expect(answers.every((a) => a.answer === null)).toBe(true);
    });
  });

  it("idempotent — second call for same (assessment, user) returns existing", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "C2"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);

    const first = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const second = await startAttempt(tenantA, { userId: candidate, assessmentId });

    expect(second.id).toBe(first.id);
    expect(second.started_at).toEqual(first.started_at);
  });

  it("rejects when assessment is not active", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "C3"));
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "Draft", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    // Leave in 'draft'.

    let caught: unknown;
    try {
      await startAttempt(tenantA, { userId: candidate, assessmentId: assessment.id });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.ASSESSMENT_NOT_ACTIVE } });
  });

  it("rejects when no invitation exists", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "C4"));
    const { packId, levelId } = await buildPublishedPack(tenantA, adminA, 3);
    const assessment = await createAssessment(
      tenantA,
      { pack_id: packId, level_id: levelId, name: "No invite", question_count: 3, opens_at: new Date(Date.now() + 60_000) },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id, adminA);
    await withSuperClient((c) =>
      c.query(`UPDATE assessments SET status='active' WHERE id=$1`, [assessment.id]),
    );

    let caught: unknown;
    try {
      await startAttempt(tenantA, { userId: candidate, assessmentId: assessment.id });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.INVITATION_NOT_FOUND } });
  });
});

// ---------------------------------------------------------------------------
// 1b. Frozen-pool resolution ("lock at assignment", migration 0096)
//
// buildActiveAssessmentWithInvite calls publishAssessment, which now freezes the
// eligible pool — so every startAttempt test above already exercises the FROZEN
// path. These two cases prove the novel guarantees: (a) the frozen set is
// immutable against questions added to the pack after publish, and (b) an
// assessment with NO frozen rows (legacy/pre-0096) falls back to the live pool.
// ---------------------------------------------------------------------------

describe("take landing — clock starts at Begin, not at link-open", () => {
  it("preview creates no attempt and starts no clock; Begin (startAttempt) sets it; reopen resumes; Begin twice is idempotent", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Pia"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 4, 20);
    const input = { userId: candidate, assessmentId };

    // 1. Opening the link = preview only.
    const preview = await getTakePreview(tenantA, input);
    expect(preview.existing).toBeNull();
    expect(preview.questionCount).toBe(4);
    expect(preview.companyName).toBe("Tenant A");
    const rows = await withSuperClient((c) =>
      c.query("SELECT 1 FROM attempts WHERE assessment_id = $1 AND user_id = $2", [assessmentId, candidate]),
    );
    expect(rows.rowCount).toBe(0);

    // 2. Begin sets started_at / ends_at at click time (after the preview).
    await new Promise((r) => setTimeout(r, 25));
    const beforeBegin = Date.now();
    const attempt = await startAttempt(tenantA, input);
    expect(attempt.started_at!.getTime()).toBeGreaterThanOrEqual(beforeBegin);
    expect(attempt.ends_at!.getTime() - attempt.started_at!.getTime()).toBe(20 * 60 * 1000);

    // 3. Reopen after Begin: preview reports the same attempt, same ends_at.
    const reopened = await getTakePreview(tenantA, input);
    expect(reopened.existing?.id).toBe(attempt.id);
    expect(reopened.existing?.ends_at).toEqual(attempt.ends_at);

    // 4. Begin twice does not reset the clock.
    await new Promise((r) => setTimeout(r, 25));
    const again = await startAttempt(tenantA, input);
    expect(again.id).toBe(attempt.id);
    expect(again.started_at).toEqual(attempt.started_at);
    expect(again.ends_at).toEqual(attempt.ends_at);
  });

  it("preview rejects a non-active assessment with no attempt (same as Begin would)", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Quin"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 2);
    await withSuperClient((c) => c.query("UPDATE assessments SET status = 'closed' WHERE id = $1", [assessmentId]));
    await expect(getTakePreview(tenantA, { userId: candidate, assessmentId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("recordTakeConsent appends a data_processing consent row", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Rae"));
    await recordTakeConsent(tenantA, { userId: candidate, ip: "203.0.113.9", userAgent: "vitest" });
    const res = await withSuperClient((c) =>
      c.query("SELECT purpose, lawful_basis, policy_version, host(ip) AS ip FROM consent_events WHERE user_id = $1", [candidate]),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ purpose: "data_processing", lawful_basis: "consent", ip: "203.0.113.9" });
  });
});

describe("consent invariant + Begin race (R4 review fixes)", () => {
  it("new non-embed attempt without a consent row -> CONSENT_REQUIRED (422), no attempt row; resume needs no consent", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Sol"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 2);
    const input = { userId: candidate, assessmentId };
    await expect(rawStartAttempt(tenantA, input)).rejects.toMatchObject({
      code: AE_ERROR_CODES.CONSENT_REQUIRED,
      status: 422,
    });
    const rows = await withSuperClient((c) =>
      c.query("SELECT 1 FROM attempts WHERE assessment_id = $1 AND user_id = $2", [assessmentId, candidate]),
    );
    expect(rows.rowCount).toBe(0);
    await recordTakeConsent(tenantA, { userId: candidate, ip: null, userAgent: null });
    const attempt = await rawStartAttempt(tenantA, input);
    // resume: no further consent check, returns the same attempt
    expect((await rawStartAttempt(tenantA, input)).id).toBe(attempt.id);
  });

  it("embed attempt without consent is allowed (host-asserted consent)", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Emb"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 2);
    const attempt = await rawStartAttempt(tenantA, { userId: candidate, assessmentId, embedOrigin: true });
    expect(attempt.id).toBeTruthy();
  });

  it("concurrent startAttempt x2 resolves to the same attempt (no 500 / aborted tx)", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Race"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    await recordTakeConsent(tenantA, { userId: candidate, ip: null, userAgent: null });
    const input = { userId: candidate, assessmentId };
    const [a, b] = await Promise.all([rawStartAttempt(tenantA, input), rawStartAttempt(tenantA, input)]);
    expect(a.id).toBe(b.id);
    expect(a.ends_at).toEqual(b.ends_at);
    const rows = await withSuperClient((c) =>
      c.query("SELECT 1 FROM attempts WHERE assessment_id = $1 AND user_id = $2", [assessmentId, candidate]),
    );
    expect(rows.rowCount).toBe(1);
  });

  it("recordTakeConsent is deduped per (tenant,user,policy version), even concurrently", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Dup"));
    const args = { userId: candidate, ip: null, userAgent: null };
    await Promise.all([recordTakeConsent(tenantA, args), recordTakeConsent(tenantA, args)]);
    await recordTakeConsent(tenantA, args);
    const res = await withSuperClient((c) =>
      c.query("SELECT 1 FROM consent_events WHERE user_id = $1", [candidate]),
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("HTTP routes — consent invariant (R4 review fixes)", () => {
  const TOKEN = "tok_0123456789abcdef0123456789abcdef";

  async function buildApp() {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { status?: number; toJson?: () => unknown };
      if (typeof e.toJson === "function") return reply.code(e.status ?? 500).send({ error: e.toJson() });
      return reply.code(500).send({ error: { code: "INTERNAL" } });
    });
    await registerAttemptTakeRoutes(app, { publicChain: [] });
    await registerAttemptCandidateRoutes(app, {
      candidateOnly: async (req) => {
        (req as unknown as { session: unknown }).session = routeCtx.session;
      },
    });
    return app;
  }

  async function setup(label: string) {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, label));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 2, 15);
    routeCtx.resolved = {
      already_submitted: false,
      assessment: { id: assessmentId, tenant_id: tenantA, name: "Active Assessment" },
      invitation: { id: randomUUID() },
      candidate: { id: candidate, name: label },
      level: { duration_minutes: 15 },
    };
    routeCtx.session = { userId: candidate, tenantId: tenantA };
    return { candidate, assessmentId };
  }

  const counts = (candidate: string, assessmentId: string) =>
    withSuperClient(async (c) => ({
      attempts: (await c.query("SELECT 1 FROM attempts WHERE assessment_id = $1 AND user_id = $2", [assessmentId, candidate])).rowCount,
      consents: (await c.query("SELECT 1 FROM consent_events WHERE user_id = $1", [candidate])).rowCount,
    }));

  it("/take/start preview: 200, no Set-Cookie, no attempt, no consent row", async () => {
    const { candidate, assessmentId } = await setup("Prev");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, preview: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.json().attempt_id).toBeNull();
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 0, consents: 0 });
  });

  it("/take/start per-token throttle: exhausted bucket -> 429 + Retry-After, key is a hash (no plaintext token)", async () => {
    const { candidate, assessmentId } = await setup("Thr");
    const auth = await import("@assessiq/auth");
    vi.mocked(auth.consumeRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, preview: true } });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
    const key = vi.mocked(auth.consumeRateLimit).mock.calls.at(-1)![0];
    expect(key.startsWith("aiq:rl:take-token:")).toBe(true);
    expect(key.includes(TOKEN)).toBe(false);
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 0, consents: 0 });
  });

  it("/take/start Begin without consent and no attempt -> 422 CONSENT_REQUIRED, nothing created", async () => {
    const { candidate, assessmentId } = await setup("NoCons");
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("CONSENT_REQUIRED");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 0, consents: 0 });
  });

  it("/take/start Begin with consent -> 201 + cookie + one consent row; second Begin = same attempt, same ends_at, still one consent row", async () => {
    const { candidate, assessmentId } = await setup("Begin");
    const app = await buildApp();
    const r1 = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, consent: true } });
    expect(r1.statusCode).toBe(201);
    expect(String(r1.headers["set-cookie"])).toContain("sess-token");
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 1, consents: 1 });
    const endsAt1 = (await withSuperClient((c) => c.query("SELECT ends_at FROM attempts WHERE id = $1", [r1.json().attempt_id]))).rows[0].ends_at;
    await new Promise((r) => setTimeout(r, 25));
    const r2 = await app.inject({ method: "POST", url: "/take/start", payload: { token: TOKEN, consent: true } });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().attempt_id).toBe(r1.json().attempt_id);
    const endsAt2 = (await withSuperClient((c) => c.query("SELECT ends_at FROM attempts WHERE id = $1", [r2.json().attempt_id]))).rows[0].ends_at;
    expect(endsAt2).toEqual(endsAt1);
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 1, consents: 1 });
  });

  it("/api/me/assessments/:id/start: no consent on file -> 422; with {consent:true} -> 201 + consent row", async () => {
    const { candidate, assessmentId } = await setup("Me");
    const app = await buildApp();
    const url = `/api/me/assessments/${assessmentId}/start`;
    const denied = await app.inject({ method: "POST", url });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().error.code).toBe("CONSENT_REQUIRED");
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 0, consents: 0 });
    const ok = await app.inject({ method: "POST", url, payload: { consent: true } });
    expect(ok.statusCode).toBe(201);
    expect(await counts(candidate, assessmentId)).toEqual({ attempts: 1, consents: 1 });
  });

  it("GET /api/me/assessments (FU-C10): shapes id/duration_seconds/question_count; hides a not-yet-open assessment; shows it once opened", async () => {
    const { assessmentId } = await setup("Wire");
    const app = await buildApp();

    // buildActiveAssessmentWithInvite sets opens_at 60s in the future — the
    // invite should NOT appear yet.
    const before = await app.inject({ method: "GET", url: "/api/me/assessments" });
    expect(before.statusCode).toBe(200);
    expect(before.json().items.find((i: { id: string }) => i.id === assessmentId)).toBeUndefined();

    // Open it (simulate the opens_at boundary passing) and confirm the aligned
    // field shape: id (not assessment_id), duration_seconds (not
    // duration_minutes), question_count present.
    await withSuperClient((c) =>
      c.query("UPDATE assessments SET opens_at = now() - interval '1 minute' WHERE id = $1", [assessmentId]),
    );
    const after = await app.inject({ method: "GET", url: "/api/me/assessments" });
    expect(after.statusCode).toBe(200);
    const item = after.json().items.find((i: { id: string }) => i.id === assessmentId);
    expect(item).toBeDefined();
    expect(item.duration_seconds).toBe(15 * 60);
    expect(item.question_count).toBe(2);
    expect(item).not.toHaveProperty("assessment_id");
    expect(item).not.toHaveProperty("duration_minutes");
  });

  it("GET /api/me/assessments (FU-C10): hides an invitation past its own expiry even while the assessment is open", async () => {
    const { assessmentId } = await setup("Expired");
    const app = await buildApp();
    await withSuperClient((c) =>
      c.query("UPDATE assessments SET opens_at = now() - interval '1 minute' WHERE id = $1", [assessmentId]),
    );
    await withSuperClient((c) =>
      c.query(
        "UPDATE assessment_invitations SET expires_at = now() - interval '1 minute' WHERE assessment_id = $1",
        [assessmentId],
      ),
    );
    const res = await app.inject({ method: "GET", url: "/api/me/assessments" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.find((i: { id: string }) => i.id === assessmentId)).toBeUndefined();
  });
});

describe("startAttempt — frozen-pool resolution (lock at assignment)", () => {
  it("draws ONLY from the pool frozen at publish, ignoring questions added to the pack afterwards", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) =>
      insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cfrozen"),
    );
    // publishAssessment (inside the builder) freezes the eligible pool = 3 Qs.
    const { assessmentId, packId } = await buildActiveAssessmentWithInvite(
      tenantA,
      adminA,
      candidate,
      3,
    );

    const frozenIds = await withSuperClient(async (c) => {
      const r = await c.query<{ question_id: string }>(
        `SELECT question_id FROM assessment_frozen_pool WHERE assessment_id = $1`,
        [assessmentId],
      );
      return r.rows.map((x) => x.question_id).sort();
    });
    expect(frozenIds).toHaveLength(3);

    // Add a 4th ACTIVE question (with a v1 snapshot, so the LIVE pool query's
    // INNER JOIN question_versions would include it) to the pack AFTER publish.
    const levelId = await withSuperClient(async (c) => {
      const r = await c.query<{ level_id: string }>(
        `SELECT level_id FROM questions WHERE pack_id = $1 LIMIT 1`,
        [packId],
      );
      return r.rows[0]!.level_id;
    });
    const extraQid = randomUUID();
    const extraContent =
      '{"question":"Added after publish?","options":["A","B","C","D"],"correct":0,"rationale":"x"}';
    await withSuperClient(async (c) => {
      await c.query(
        // questions is not tenant-scoped directly (inherits tenant via its pack).
        `INSERT INTO questions (id, pack_id, level_id, type, topic, points, status, version, content, created_by)
         VALUES ($1, $2, $3, 'mcq', 'extra-after-publish', 5, 'active', 2, $4::jsonb, $5)`,
        [extraQid, packId, levelId, extraContent, adminA],
      );
      await c.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
         VALUES ($1, $2, 1, $3::jsonb, NULL, $4)`,
        [randomUUID(), extraQid, extraContent, adminA],
      );
    });

    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const drawnIds = await withSuperClient(async (c) => {
      const r = await c.query<{ question_id: string }>(
        `SELECT question_id FROM attempt_questions WHERE attempt_id = $1`,
        [attempt.id],
      );
      return r.rows.map((x) => x.question_id).sort();
    });
    expect(drawnIds).toHaveLength(3);
    expect(drawnIds).toEqual(frozenIds);
    expect(drawnIds).not.toContain(extraQid);
  });

  it("falls back to the live pool for a legacy assessment with no frozen rows", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) =>
      insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Clegacy"),
    );
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 4);

    // Simulate a pre-0096 (legacy) assessment: delete its frozen pool so
    // countFrozenPool() === 0 and the live-pool fallback path runs unchanged.
    await withSuperClient((c) =>
      c.query(`DELETE FROM assessment_frozen_pool WHERE assessment_id = $1`, [assessmentId]),
    );

    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const count = await withSuperClient(async (c) => {
      const r = await c.query<{ count: string }>(
        `SELECT count(*) FROM attempt_questions WHERE attempt_id = $1`,
        [attempt.id],
      );
      return Number(r.rows[0]!.count);
    });
    expect(count).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 2. getAttemptForCandidate (frozen-version invariant)
// ---------------------------------------------------------------------------

describe("getAttemptForCandidate", () => {
  it("returns frozen content even after admin edits live question", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cfreeze"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);

    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const initial = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    expect(initial.questions).toHaveLength(3);
    const firstQid = initial.questions[0]!.question_id;
    const frozenContent = initial.questions[0]!.content as { question: string };
    expect(frozenContent.question).toMatch(/^Test question/);

    // Admin edits the live question content + bumps its version.
    await withSuperClient((c) =>
      c.query(
        `UPDATE questions SET content = $1::jsonb, version = version + 1, updated_at = now()
         WHERE id = $2`,
        [JSON.stringify({ question: "EDITED", options: ["X","Y","Z","W"], correct: 1, rationale: "" }), firstQid],
      ),
    );

    // Candidate re-reads the attempt — content must still be the frozen version.
    const after = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const stillFrozen = after.questions.find((q) => q.question_id === firstQid)!.content as { question: string };
    expect(stillFrozen.question).toBe(frozenContent.question);
    expect(stillFrozen.question).not.toBe("EDITED");
  });

  it("auto-submits an in_progress attempt whose timer has expired", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cexp"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);

    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    // Force ends_at into the past via superuser (no other way — the timer is
    // server-pinned at start).
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '1 minute' WHERE id = $1`, [attempt.id]),
    );

    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    expect(view.attempt.status).toBe("auto_submitted");
    expect(view.remaining_seconds).toBe(0);
  });

  it("denies cross-user reads with AuthzError", async () => {
    const candidate1 = randomUUID();
    const candidate2 = randomUUID();
    await withSuperClient(async (c) => {
      await insertCandidateUser(c, candidate1, tenantA, `c1-${candidate1}@x.com`, "C1x");
      await insertCandidateUser(c, candidate2, tenantA, `c2-${candidate2}@x.com`, "C2x");
    });
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate1, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate1, assessmentId });

    let caught: unknown;
    try {
      await getAttemptForCandidate(tenantA, attempt.id, candidate2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthzError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.NOT_OWNED_BY_USER } });
  });
});

// ---------------------------------------------------------------------------
// 3. saveAnswer + multi_tab_conflict
// ---------------------------------------------------------------------------

describe("saveAnswer", () => {
  it("last-write-wins increments client_revision monotonically", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Csave"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const qid = view.questions[0]!.question_id;

    const r1 = await saveAnswer(tenantA, candidate, {
      attemptId: attempt.id, questionId: qid, answer: 1, client_revision: 0,
    });
    const r2 = await saveAnswer(tenantA, candidate, {
      attemptId: attempt.id, questionId: qid, answer: 2, client_revision: r1.client_revision,
    });
    expect(r2.client_revision).toBeGreaterThan(r1.client_revision);
  });

  it("scenario question: a wrong answer shape is rejected, the canonical shape is saved (N15)", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cscen"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const qid = view.questions[0]!.question_id;
    // The check is keyed on the question TYPE frozen on the attempt's question_version (N21).
    await withSuperClient(async (c) => {
      await c.query(`UPDATE questions SET type = 'scenario' WHERE id = $1`, [qid]);
      await c.query(`UPDATE question_versions SET type = 'scenario' WHERE question_id = $1`, [qid]);
    });

    await expect(
      saveAnswer(tenantA, candidate, { attemptId: attempt.id, questionId: qid, answer: "free text", client_revision: 0 }),
    ).rejects.toMatchObject({ details: { code: AE_ERROR_CODES.INVALID_PARAM, param: "answer" } });

    const ok = await saveAnswer(tenantA, candidate, {
      attemptId: attempt.id, questionId: qid, answer: { steps: [{ stepIndex: 0, response: "a" }] }, client_revision: 0,
    });
    expect(ok.client_revision).toBeGreaterThan(0);
  });

  it("logs multi_tab_conflict event when incoming revision < stored", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cconf"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const qid = view.questions[0]!.question_id;

    // Tab A: saves at revision 0 → stored becomes 1
    await saveAnswer(tenantA, candidate, {
      attemptId: attempt.id, questionId: qid, answer: "A", client_revision: 0,
    });
    // Tab B: also saves with stale revision 0 → stored becomes 2, conflict logged
    const r2 = await saveAnswer(tenantA, candidate, {
      attemptId: attempt.id, questionId: qid, answer: "B", client_revision: 0,
    });
    expect(r2.client_revision).toBeGreaterThan(0);

    await withTenant(tenantA, async (client) => {
      const events = await repo.listAttemptEvents(client, attempt.id);
      const conflict = events.find((e) => e.event_type === "multi_tab_conflict");
      expect(conflict).toBeDefined();
      expect(conflict!.question_id).toBe(qid);
    });
  });

  it("rejects writes after timer expires", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cttl"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const qid = view.questions[0]!.question_id;

    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '1 second' WHERE id = $1`, [attempt.id]),
    );

    let caught: unknown;
    try {
      await saveAnswer(tenantA, candidate, {
        attemptId: attempt.id, questionId: qid, answer: 0, client_revision: 0,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.TIMER_EXPIRED } });
  });
});

// ---------------------------------------------------------------------------
// 4. recordEvent — known/unknown types, payload validation, rate cap
// ---------------------------------------------------------------------------

describe("recordEvent", () => {
  it("rejects unknown event_type with VALIDATION_FAILED", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Ce1"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    let caught: unknown;
    try {
      await recordEvent(tenantA, candidate, {
        attemptId: attempt.id, event_type: "ransomware_clicked", payload: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.UNKNOWN_EVENT_TYPE } });
  });

  it("validates payload shape per Zod schema", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Ce2"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    let caught: unknown;
    try {
      await recordEvent(tenantA, candidate, {
        attemptId: attempt.id,
        event_type: "flag",
        payload: { flagged: "yes" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.INVALID_EVENT_PAYLOAD } });
  });

  it("per-second rate cap drops bursts above 10/sec", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cer"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    // Fire 25 events synchronously in a tight loop — only the first 10 should
    // be admitted (per-second window).
    let admitted = 0;
    let dropped = 0;
    for (let i = 0; i < 25; i++) {
      const out = await recordEvent(tenantA, candidate, {
        attemptId: attempt.id,
        event_type: "tab_focus",
        payload: {},
      });
      if (out !== null) admitted++;
      else dropped++;
    }
    expect(admitted).toBeLessThanOrEqual(RATE_CAP_CONSTANTS.PER_SECOND_LIMIT);
    expect(admitted + dropped).toBe(25);
    expect(dropped).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. submitAttempt — idempotent
// ---------------------------------------------------------------------------

describe("submitAttempt", () => {
  it("transitions in_progress → submitted; second call is idempotent", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Csub"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    const r1 = await submitAttempt(tenantA, candidate, attempt.id);
    expect(r1.attempt.status).toBe("submitted");
    expect(r1.attempt.submitted_at).not.toBeNull();

    const r2 = await submitAttempt(tenantA, candidate, attempt.id);
    expect(r2.attempt.id).toBe(r1.attempt.id);
    expect(r2.attempt.status).toBe("graded"); // MCQ-only fixture finalised at submit (2026-10-01)
    expect(r2.attempt.submitted_at).toEqual(r1.attempt.submitted_at);
  });

  it("marks invitation 'submitted' on candidate submit", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Csubi"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    await submitAttempt(tenantA, candidate, attempt.id);

    await withSuperClient(async (c) => {
      const result = await c.query<{ status: string }>(
        `SELECT status FROM assessment_invitations WHERE assessment_id = $1 AND user_id = $2`,
        [assessmentId, candidate],
      );
      expect(result.rows[0]!.status).toBe("submitted");
    });
  });
});

// ---------------------------------------------------------------------------
// 6. toggleFlag
// ---------------------------------------------------------------------------

describe("toggleFlag", () => {
  it("flips flag and emits flag/unflag events", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Cflag"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });
    const view = await getAttemptForCandidate(tenantA, attempt.id, candidate);
    const qid = view.questions[0]!.question_id;

    const f1 = await toggleFlag(tenantA, candidate, { attemptId: attempt.id, questionId: qid, flagged: true });
    expect(f1.flagged).toBe(true);

    const f2 = await toggleFlag(tenantA, candidate, { attemptId: attempt.id, questionId: qid, flagged: false });
    expect(f2.flagged).toBe(false);

    await withTenant(tenantA, async (client) => {
      const events = await repo.listAttemptEvents(client, attempt.id);
      const types = events.map((e) => e.event_type);
      expect(types).toContain("flag");
      expect(types).toContain("unflag");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. sweepStaleTimers
// ---------------------------------------------------------------------------

describe("sweepStaleTimersForTenant", () => {
  it("auto-submits in_progress attempts past ends_at; idempotent on second pass", async () => {
    const candidate = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidate, tenantA, `c-${candidate}@x.com`, "Csw"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidate, 3);
    const attempt = await startAttempt(tenantA, { userId: candidate, assessmentId });

    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '5 minutes' WHERE id = $1`, [attempt.id]),
    );

    const r1 = await sweepStaleTimersForTenant(tenantA);
    expect(r1.autoSubmitted).toBeGreaterThanOrEqual(1);
    expect(r1.attemptIds).toContain(attempt.id);

    const r2 = await sweepStaleTimersForTenant(tenantA);
    expect(r2.autoSubmitted).toBe(0);
    expect(r2.attemptIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-tenant RLS denial
// ---------------------------------------------------------------------------

describe("cross-tenant RLS", () => {
  it("tenant B cannot read tenant A's attempt rows", async () => {
    const candidateA = randomUUID();
    await withSuperClient((c) => insertCandidateUser(c, candidateA, tenantA, `c-${candidateA}@x.com`, "Cta"));
    const { assessmentId } = await buildActiveAssessmentWithInvite(tenantA, adminA, candidateA, 3);
    const attempt = await startAttempt(tenantA, { userId: candidateA, assessmentId });

    // From tenantB's RLS context, the attempt should be invisible.
    await withTenant(tenantB, async (client) => {
      const found = await repo.findAttemptById(client, attempt.id);
      expect(found).toBeNull();

      // Child tables also invisible (JOIN-RLS).
      const aqs = await repo.listFrozenQuestionsForAttempt(client, attempt.id);
      expect(aqs).toHaveLength(0);

      const events = await repo.listAttemptEvents(client, attempt.id);
      expect(events).toHaveLength(0);
    });
  });
});
