/**
 * Regression test suite pinning the attempt state machine for module 06.
 *
 * Companion to attempt-engine.test.ts. That file covers the happy-path
 * surface (startAttempt, getAttemptForCandidate, saveAnswer, toggleFlag,
 * recordEvent, submitAttempt, sweepStaleTimersForTenant); this file pins
 * the *transitions* — valid + invalid + cross-tenant + time-authority —
 * so future Phase 2 (grading) and Phase 3 (scheduler) work can't
 * silently drift the state machine.
 *
 * Coverage map (verdict matrix in the session-state handoff):
 *   T1 in_progress -> submitted via submitAttempt (idempotent, single event)
 *   T2 in_progress -> auto_submitted via sweepStaleTimersForTenant
 *   T3 in_progress -> auto_submitted opportunistic in getAttemptForCandidate
 *   T4 CHECK constraint accepts pending_admin_grading | graded | released
 *      but submitAttempt stops at 'submitted'
 *   I1 saveAnswer after terminal -> AE_WRITES_LOCKED
 *   I2 submitAttempt from submitted: idempotent; from auto_submitted:
 *      no-op (returns current state, DB row untouched)
 *   I3 recordEvent after terminal -> AE_WRITES_LOCKED
 *   I4 toggleFlag after terminal -> AE_WRITES_LOCKED
 *   I5 startAttempt double-start: same (assessment,user) returns same row,
 *      no second attempts row inserted
 *   X1 cross-tenant submitAttempt: RLS hides row -> AE_ATTEMPT_NOT_FOUND;
 *      source-tenant row remains unmutated
 *   X2 sweepStaleTimersForTenant(A) does not touch tenant B's stale attempts
 *   Z1 attempts.ends_at unchanged after admin edits level.duration_minutes
 *   Z2 client-supplied time_spent_seconds does not shift attempts.ends_at
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";

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
import { AE_ERROR_CODES, TERMINAL_ATTEMPT_STATUSES } from "../types.js";
import { _resetForTesting as resetRateCap } from "../rate-cap.js";

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

import { ConflictError, NotFoundError } from "@assessiq/core";

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
// 14-audit-log migrations are required because G3.D wired auditInTx into
// 04-question-bank.createPack (and others). Without 'audit_log' table the
// shared fixture's buildPublishedPack throws "relation audit_log does not
// exist". Mirrors bulk-status-route.test.ts fix.
const AUDIT_LOG_MIGRATIONS_DIR = join(MODULES_ROOT, "14-audit-log", "migrations");
// 12-embed-sdk migration 0073 adds the embed_origin column that
// modules/06-attempt-engine/src/repository.ts SELECT lists; without it
// every findAttemptById throws "column embed_origin does not exist".
const EMBED_SDK_MIGRATIONS_DIR = join(MODULES_ROOT, "12-embed-sdk", "migrations");

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
// Setup helpers (mirror attempt-engine.test.ts; copy, do not invent)
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

async function buildPublishedPack(
  tenantId: string,
  adminId: string,
  questionCount: number,
  durationMinutes = 30,
): Promise<{ packId: string; levelId: string }> {
  const slug = `sm-pack-${randomUUID().slice(0, 8)}`;
  const pack = await createPack(tenantId, { slug, name: "SM Pack", domain: "soc" }, adminId);
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
        topic: `sm-topic-${i}`,
        points: 5,
        content: {
          question: `SM question ${i}?`,
          options: ["A", "B", "C", "D"],
          correct: 0,
          rationale: "A is correct.",
        },
      },
      adminId,
    );
  }
  await publishPack(tenantId, pack.id, adminId);
  await withSuperClient(async (client) => {
    await client.query(
      `UPDATE questions SET status = 'active' WHERE pack_id = $1`,
      [pack.id],
    );
  });
  return { packId: pack.id, levelId: level.id };
}

async function buildActiveAssessmentWithInvite(
  tenantId: string,
  adminId: string,
  candidateId: string,
  questionCount: number,
  durationMinutes = 30,
): Promise<{ assessmentId: string; packId: string; levelId: string }> {
  const { packId, levelId } = await buildPublishedPack(
    tenantId,
    adminId,
    questionCount,
    durationMinutes,
  );
  const assessment = await createAssessment(
    tenantId,
    { pack_id: packId, level_id: levelId, name: "SM Assessment", question_count: questionCount },
    adminId,
  );
  await publishAssessment(tenantId, assessment.id);
  await withSuperClient((c) =>
    c.query(`UPDATE assessments SET status = 'active' WHERE id = $1`, [assessment.id]),
  );
  await inviteUsers(tenantId, assessment.id, [candidateId], adminId);
  return { assessmentId: assessment.id, packId, levelId };
}

/**
 * Seed a candidate + active assessment + start the attempt in one call.
 * Returns the seeded ids and the first question id (read via the
 * candidate view so the test doesn't have to know about pool order).
 */
async function seedAndStart(
  tenantId: string,
  adminId: string,
  questionCount = 3,
  durationMinutes = 30,
): Promise<{
  candidateId: string;
  assessmentId: string;
  levelId: string;
  attemptId: string;
  firstQid: string;
}> {
  const candidateId = randomUUID();
  await withSuperClient((c) =>
    insertCandidateUser(c, candidateId, tenantId, `sm-${candidateId}@x.com`, "SM Cand"),
  );
  const { assessmentId, levelId } = await buildActiveAssessmentWithInvite(
    tenantId,
    adminId,
    candidateId,
    questionCount,
    durationMinutes,
  );
  const attempt = await startAttempt(tenantId, { userId: candidateId, assessmentId });
  const view = await getAttemptForCandidate(tenantId, attempt.id, candidateId);
  const firstQid = view.questions[0]!.question_id;
  return {
    candidateId,
    assessmentId,
    levelId,
    attemptId: attempt.id,
    firstQid,
  };
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

  await withSuperClient(async (client) => {
    await applyMigrationsFromDir(client, TENANCY_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, USERS_MIGRATIONS_DIR, ["020_users.sql"]);
    await applyMigrationsFromDir(client, QB_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AL_MIGRATIONS_DIR);
    await applyMigrationsFromDir(client, AE_MIGRATIONS_DIR);
    // Order: embed_origin column add must follow 0030; audit_log is standalone.
    await applyMigrationsFromDir(client, EMBED_SDK_MIGRATIONS_DIR, ["0073_attempt_embed_origin.sql"]);
    await applyMigrationsFromDir(client, AUDIT_LOG_MIGRATIONS_DIR);
  });

  setPoolForTesting(containerUrl);

  tenantA = randomUUID();
  tenantB = randomUUID();
  adminA = randomUUID();
  adminB = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, "sm-tenant-a", "SM Tenant A");
    await insertTenant(client, tenantB, "sm-tenant-b", "SM Tenant B");
    await insertAdminUser(client, adminA, tenantA, "sm-admin-a@test.local");
    await insertAdminUser(client, adminB, tenantB, "sm-admin-b@test.local");
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

// ===========================================================================
// T1–T4 — valid transitions
// ===========================================================================

describe("T1 valid: in_progress -> submitted via submitAttempt", () => {
  it("transitions the row, sets submitted_at, marks invitation submitted", async () => {
    const { candidateId, assessmentId, attemptId } = await seedAndStart(tenantA, adminA);

    const r = await submitAttempt(tenantA, candidateId, attemptId);
    expect(r.status).toBe("submitted");
    expect(r.attempt.status).toBe("submitted");
    expect(r.attempt.submitted_at).not.toBeNull();

    await withSuperClient(async (c) => {
      const inv = await c.query<{ status: string }>(
        `SELECT status FROM assessment_invitations WHERE assessment_id = $1 AND user_id = $2`,
        [assessmentId, candidateId],
      );
      expect(inv.rows[0]!.status).toBe("submitted");
    });
  });

  it("idempotent on second call: same submitted_at, no new attempt_events row", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);

    const r1 = await submitAttempt(tenantA, candidateId, attemptId);
    const eventsBefore = await withTenant(tenantA, async (client) => {
      return repo.listAttemptEvents(client, attemptId);
    });

    const r2 = await submitAttempt(tenantA, candidateId, attemptId);

    expect(r2.attempt.id).toBe(r1.attempt.id);
    expect(r2.attempt.status).toBe("submitted");
    expect(r2.attempt.submitted_at).toEqual(r1.attempt.submitted_at);

    const eventsAfter = await withTenant(tenantA, async (client) => {
      return repo.listAttemptEvents(client, attemptId);
    });
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });
});

describe("T2 valid: in_progress -> auto_submitted via sweepStaleTimersForTenant", () => {
  it("sweep transitions status; no answer write accepted after sweep", async () => {
    const { candidateId, attemptId, firstQid } = await seedAndStart(tenantA, adminA);

    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '5 minutes' WHERE id = $1`, [attemptId]),
    );

    const sweep = await sweepStaleTimersForTenant(tenantA);
    expect(sweep.autoSubmitted).toBeGreaterThanOrEqual(1);
    expect(sweep.attemptIds).toContain(attemptId);

    await withSuperClient(async (c) => {
      const r = await c.query<{ status: string; submitted_at: Date | null }>(
        `SELECT status, submitted_at FROM attempts WHERE id = $1`,
        [attemptId],
      );
      expect(r.rows[0]!.status).toBe("auto_submitted");
      expect(r.rows[0]!.submitted_at).not.toBeNull();
    });

    let caught: unknown;
    try {
      await saveAnswer(tenantA, candidateId, {
        attemptId,
        questionId: firstQid,
        answer: 1,
        client_revision: 0,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.WRITES_LOCKED } });
  });
});

describe("T3 valid: in_progress -> auto_submitted safety-net via getAttemptForCandidate", () => {
  it("opportunistic auto-submit when candidate fetches past ends_at; emits time_milestone auto_submit", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);

    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '1 minute' WHERE id = $1`, [attemptId]),
    );

    const view = await getAttemptForCandidate(tenantA, attemptId, candidateId);
    expect(view.attempt.status).toBe("auto_submitted");
    expect(view.remaining_seconds).toBe(0);

    const events = await withTenant(tenantA, async (client) =>
      repo.listAttemptEvents(client, attemptId),
    );
    const autoSubmitMarker = events.find(
      (e) =>
        e.event_type === "time_milestone" &&
        e.payload !== null &&
        typeof e.payload === "object" &&
        (e.payload as { kind?: string }).kind === "auto_submit",
    );
    expect(autoSubmitMarker).toBeDefined();
  });
});

describe("T4 valid: CHECK constraint accepts forward-compat statuses; service stops at 'submitted'", () => {
  it("pending_admin_grading | graded | released are valid DB values", async () => {
    const { attemptId } = await seedAndStart(tenantA, adminA);

    for (const status of ["pending_admin_grading", "graded", "released"] as const) {
      await withSuperClient(async (c) => {
        await c.query(`UPDATE attempts SET status = $1 WHERE id = $2`, [status, attemptId]);
        const r = await c.query<{ status: string }>(
          `SELECT status FROM attempts WHERE id = $1`,
          [attemptId],
        );
        expect(r.rows[0]!.status).toBe(status);
      });
    }
  });

  it("submitAttempt from in_progress lands at 'submitted', never at a Phase-2 status", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);
    const r = await submitAttempt(tenantA, candidateId, attemptId);

    expect(r.attempt.status).toBe("submitted");
    expect(["pending_admin_grading", "graded", "released"]).not.toContain(r.attempt.status);

    await withSuperClient(async (c) => {
      const row = await c.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1`,
        [attemptId],
      );
      expect(row.rows[0]!.status).toBe("submitted");
    });
  });
});

// ===========================================================================
// I1–I5 — invalid transitions / idempotency pins
// ===========================================================================

describe("I1 invalid: saveAnswer after terminal -> AE_WRITES_LOCKED", () => {
  it("submitted attempt rejects saveAnswer", async () => {
    const { candidateId, attemptId, firstQid } = await seedAndStart(tenantA, adminA);
    await submitAttempt(tenantA, candidateId, attemptId);

    let caught: unknown;
    try {
      await saveAnswer(tenantA, candidateId, {
        attemptId,
        questionId: firstQid,
        answer: 2,
        client_revision: 0,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.WRITES_LOCKED } });
  });
});

describe("I2 invalid: submitAttempt no-op from terminal statuses", () => {
  it("submitAttempt from auto_submitted returns idempotently; DB row not mutated", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);

    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET ends_at = now() - INTERVAL '1 minute' WHERE id = $1`, [attemptId]),
    );
    await sweepStaleTimersForTenant(tenantA);

    const before = await withSuperClient((c) =>
      c.query<{ status: string; submitted_at: Date | null }>(
        `SELECT status, submitted_at FROM attempts WHERE id = $1`,
        [attemptId],
      ),
    );
    expect(before.rows[0]!.status).toBe("auto_submitted");
    const submittedAtBefore = before.rows[0]!.submitted_at;

    const r = await submitAttempt(tenantA, candidateId, attemptId);
    // The terminal-no-op branch returns the existing row wrapped with the
    // literal status='submitted' return shape; the DB row keeps its actual
    // auto_submitted status. Both halves of this contract are pinned.
    expect(r.status).toBe("submitted");
    expect(r.attempt.status).toBe("auto_submitted");

    const after = await withSuperClient((c) =>
      c.query<{ status: string; submitted_at: Date | null }>(
        `SELECT status, submitted_at FROM attempts WHERE id = $1`,
        [attemptId],
      ),
    );
    expect(after.rows[0]!.status).toBe("auto_submitted");
    expect(after.rows[0]!.submitted_at).toEqual(submittedAtBefore);
  });

  it("TERMINAL_ATTEMPT_STATUSES contains both 'submitted' and 'auto_submitted'", () => {
    // Pin the terminal set so a Phase-2 refactor that narrows it is caught.
    expect(TERMINAL_ATTEMPT_STATUSES.has("submitted")).toBe(true);
    expect(TERMINAL_ATTEMPT_STATUSES.has("auto_submitted")).toBe(true);
    // Phase-2 reserved statuses that ARE structurally terminal:
    expect(TERMINAL_ATTEMPT_STATUSES.has("graded")).toBe(true);
    expect(TERMINAL_ATTEMPT_STATUSES.has("released")).toBe(true);
    expect(TERMINAL_ATTEMPT_STATUSES.has("cancelled")).toBe(true);
    // pending_admin_grading is NOT terminal — submitAttempt rejects it.
    expect(TERMINAL_ATTEMPT_STATUSES.has("pending_admin_grading")).toBe(false);
  });

  it("submitAttempt from pending_admin_grading throws WRITES_LOCKED (non-terminal non-in_progress)", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'pending_admin_grading' WHERE id = $1`, [attemptId]),
    );

    let caught: unknown;
    try {
      await submitAttempt(tenantA, candidateId, attemptId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.WRITES_LOCKED } });
  });
});

describe("I3 invalid: recordEvent after terminal -> AE_WRITES_LOCKED", () => {
  it("submitted attempt rejects recordEvent with WRITES_LOCKED", async () => {
    const { candidateId, attemptId } = await seedAndStart(tenantA, adminA);
    await submitAttempt(tenantA, candidateId, attemptId);

    let caught: unknown;
    try {
      await recordEvent(tenantA, candidateId, {
        attemptId,
        event_type: "tab_focus",
        payload: {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.WRITES_LOCKED } });
  });
});

describe("I4 invalid: toggleFlag after terminal -> AE_WRITES_LOCKED", () => {
  it("submitted attempt rejects toggleFlag with WRITES_LOCKED", async () => {
    const { candidateId, attemptId, firstQid } = await seedAndStart(tenantA, adminA);
    await submitAttempt(tenantA, candidateId, attemptId);

    let caught: unknown;
    try {
      await toggleFlag(tenantA, candidateId, {
        attemptId,
        questionId: firstQid,
        flagged: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.WRITES_LOCKED } });
  });
});

describe("I5 invalid: startAttempt double-start returns existing, no new row", () => {
  it("second startAttempt for same (assessment, user) returns existing; attempts table row count unchanged", async () => {
    const { candidateId, assessmentId, attemptId } = await seedAndStart(tenantA, adminA);

    const countBefore = await withSuperClient((c) =>
      c.query<{ count: string }>(`SELECT count(*)::text AS count FROM attempts WHERE assessment_id = $1`, [assessmentId]),
    );
    expect(countBefore.rows[0]!.count).toBe("1");

    const second = await startAttempt(tenantA, { userId: candidateId, assessmentId });
    expect(second.id).toBe(attemptId);

    const countAfter = await withSuperClient((c) =>
      c.query<{ count: string }>(`SELECT count(*)::text AS count FROM attempts WHERE assessment_id = $1`, [assessmentId]),
    );
    expect(countAfter.rows[0]!.count).toBe("1");
  });
});

// ===========================================================================
// X1–X2 — tenancy invariants
// ===========================================================================

describe("X1 tenancy: cross-tenant submitAttempt denied by RLS; source-tenant row unmutated", () => {
  it("submitAttempt under tenantB context against tenantA's attempt throws ATTEMPT_NOT_FOUND", async () => {
    const { candidateId: candidateA, attemptId } = await seedAndStart(tenantA, adminA);

    let caught: unknown;
    try {
      // The candidateA user-id is irrelevant once RLS hides the row — but we
      // pass it to mimic what an attacker would do.
      await submitAttempt(tenantB, candidateA, attemptId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).toMatchObject({ details: { code: AE_ERROR_CODES.ATTEMPT_NOT_FOUND } });

    // Source-tenant row is still in_progress (no mutation, no submitted_at).
    await withSuperClient(async (c) => {
      const r = await c.query<{ status: string; submitted_at: Date | null }>(
        `SELECT status, submitted_at FROM attempts WHERE id = $1`,
        [attemptId],
      );
      expect(r.rows[0]!.status).toBe("in_progress");
      expect(r.rows[0]!.submitted_at).toBeNull();
    });
  });
});

describe("X2 tenancy: sweepStaleTimersForTenant(A) leaves tenant B's stale attempts untouched", () => {
  it("only tenantA's expired attempts transition; tenantB's stays in_progress", async () => {
    const aSeed = await seedAndStart(tenantA, adminA);
    const bSeed = await seedAndStart(tenantB, adminB);

    await withSuperClient(async (c) => {
      await c.query(
        `UPDATE attempts SET ends_at = now() - INTERVAL '5 minutes' WHERE id = ANY($1::uuid[])`,
        [[aSeed.attemptId, bSeed.attemptId]],
      );
    });

    const r = await sweepStaleTimersForTenant(tenantA);
    expect(r.attemptIds).toContain(aSeed.attemptId);
    expect(r.attemptIds).not.toContain(bSeed.attemptId);

    await withSuperClient(async (c) => {
      const rows = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM attempts WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[aSeed.attemptId, bSeed.attemptId]],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row.status]));
      expect(byId.get(aSeed.attemptId)).toBe("auto_submitted");
      expect(byId.get(bSeed.attemptId)).toBe("in_progress");
    });
  });
});

// ===========================================================================
// Z1–Z2 — time-authority invariants
// ===========================================================================

describe("Z1 time-authority: attempts.ends_at is pinned against subsequent level edits", () => {
  it("admin bumps level.duration_minutes after start; attempt ends_at and duration_seconds unchanged", async () => {
    const { attemptId, levelId } = await seedAndStart(tenantA, adminA, 3, 30);

    const before = await withSuperClient((c) =>
      c.query<{ ends_at: Date | null; duration_seconds: number | null }>(
        `SELECT ends_at, duration_seconds FROM attempts WHERE id = $1`,
        [attemptId],
      ),
    );
    const endsAtBefore = before.rows[0]!.ends_at;
    const durationBefore = before.rows[0]!.duration_seconds;
    expect(durationBefore).toBe(30 * 60);
    expect(endsAtBefore).not.toBeNull();

    await withSuperClient((c) =>
      c.query(`UPDATE levels SET duration_minutes = 60 WHERE id = $1`, [levelId]),
    );

    const after = await withSuperClient((c) =>
      c.query<{ ends_at: Date | null; duration_seconds: number | null }>(
        `SELECT ends_at, duration_seconds FROM attempts WHERE id = $1`,
        [attemptId],
      ),
    );
    expect(after.rows[0]!.duration_seconds).toBe(durationBefore);
    expect(after.rows[0]!.ends_at).toEqual(endsAtBefore);
  });
});

describe("Z2 time-authority: client-supplied time_spent_seconds does not shift attempts.ends_at", () => {
  it("saveAnswer with a huge time_spent_seconds records it on attempt_answers but ends_at is untouched", async () => {
    const { candidateId, attemptId, firstQid } = await seedAndStart(tenantA, adminA);

    const before = await withSuperClient((c) =>
      c.query<{ ends_at: Date | null }>(`SELECT ends_at FROM attempts WHERE id = $1`, [attemptId]),
    );
    const endsAtBefore = before.rows[0]!.ends_at;

    await saveAnswer(tenantA, candidateId, {
      attemptId,
      questionId: firstQid,
      answer: 1,
      client_revision: 0,
      time_spent_seconds: 9_999_999,
    });

    const after = await withSuperClient((c) =>
      c.query<{ ends_at: Date | null }>(`SELECT ends_at FROM attempts WHERE id = $1`, [attemptId]),
    );
    expect(after.rows[0]!.ends_at).toEqual(endsAtBefore);

    // Confirm the candidate's value did land on the answer row (so the
    // assertion above isn't trivially true because the write failed).
    const answer = await withTenant(tenantA, async (client) =>
      repo.findAttemptAnswer(client, attemptId, firstQid),
    );
    expect(answer).not.toBeNull();
    expect(answer!.time_spent_seconds).toBe(9_999_999);
  });
});
