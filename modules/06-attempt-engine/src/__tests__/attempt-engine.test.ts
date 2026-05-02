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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";
import type { PoolClient } from "pg";

// Module 06 surface
import {
  startAttempt,
  getAttemptForCandidate,
  saveAnswer,
  toggleFlag,
  recordEvent,
  submitAttempt,
  sweepStaleTimersForTenant,
} from "../service.js";
import * as repo from "../repository.js";
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

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AE_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AE_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_MIGRATIONS_DIR = join(AE_MODULE_ROOT, "migrations");

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
    },
    adminId,
  );
  await publishAssessment(tenantId, assessment.id);

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
      { pack_id: packId, level_id: levelId, name: "Draft", question_count: 3 },
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
      { pack_id: packId, level_id: levelId, name: "No invite", question_count: 3 },
      adminA,
    );
    await publishAssessment(tenantA, assessment.id);
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
    expect(r2.attempt.status).toBe("submitted");
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
