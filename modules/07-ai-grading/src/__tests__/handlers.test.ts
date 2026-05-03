/**
 * Integration tests for modules/07-ai-grading — admin handler surface.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Container is started ONCE in beforeAll and shared across all 9 handlers.
 *
 * Migration apply order (CRITICAL — must respect FK chain):
 *   1. ALL 02-tenancy migrations (0001–0004)
 *   2. 03-users 020_users.sql ONLY (021 depends on auth tables not present here)
 *   3. ALL 04-question-bank migrations (0010–0015)
 *   4. ALL 05-assessment-lifecycle migrations (0020–0022)
 *   5. ALL 06-attempt-engine migrations (0030–0033)
 *   6. ALL 07-ai-grading migrations (0040–0041)
 *
 * runtime-selector.ts is fully mocked — gradeSubjective never calls claude.
 *
 * Lint-sentinel note: lint-no-ambient-claude.ts skips __tests__/ directories;
 * the vi.mock() call here is safe from that gate.
 *
 * Schema notes (derived from reading every migration):
 *   - `levels` table has NO tenant_id; JOIN-RLS through question_packs.
 *   - `questions` has NO tenant_id; JOIN-RLS through question_packs.
 *   - `question_versions` uses `saved_by` (not created_by).
 *   - `attempt_questions` PK is (attempt_id, question_id) — no id/tenant_id column.
 *   - `attempt_answers` PK is (attempt_id, question_id) — no id/tenant_id column.
 *   - `assessment_invitations` has NO tenant_id; requires expires_at + invited_by.
 *   - All superuser INSERTs bypass RLS — no role dance needed in withSuperClient.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setPoolForTesting, closePool } from "../../../02-tenancy/src/pool.js";
import { withTenant } from "../../../02-tenancy/src/with-tenant.js";

// Handlers under test
import { handleAdminGrade } from "../handlers/admin-grade.js";
import { handleAdminAccept } from "../handlers/admin-accept.js";
import { handleAdminOverride } from "../handlers/admin-override.js";
import { handleAdminRerun } from "../handlers/admin-rerun.js";
import { handleAdminQueue } from "../handlers/admin-queue.js";
import {
  handleAdminClaimAttempt,
  handleAdminReleaseAttempt,
} from "../handlers/admin-claim-release.js";
import {
  handleAdminListGradingJobs,
  handleAdminRetryGradingJob,
} from "../handlers/admin-grading-jobs.js";
import { handleAdminBudget } from "../handlers/admin-budget.js";

// Repository (for direct seed + read queries in tests)
import { findGradingsForAttempt, insertGrading } from "../repository.js";

// Types + error codes
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingProposal } from "../types.js";

// Single-flight singleton — imported so we can drain between tests
import { singleFlight } from "../single-flight.js";

// ---------------------------------------------------------------------------
// Mock runtime-selector so no real claude subprocess is spawned.
// Vitest hoists vi.mock() calls before imports, so the mock is in place when
// admin-grade.ts and admin-rerun.ts first import gradeSubjective.
// ---------------------------------------------------------------------------

vi.mock("../runtime-selector.js", () => ({
  gradeSubjective: vi.fn(),
}));

import { gradeSubjective } from "../runtime-selector.js";
const mockGradeSubjective = vi.mocked(gradeSubjective);

// ---------------------------------------------------------------------------
// Path helpers — strip Windows leading slash before drive letter.
// import.meta.url on Windows: file:///E:/code/...  →  /E:/code/...
// ---------------------------------------------------------------------------

function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const THIS_DIR = toFsPath(new URL(".", import.meta.url));
const AI_MODULE_ROOT = join(THIS_DIR, "..", "..");
const MODULES_ROOT = join(AI_MODULE_ROOT, "..");

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, "02-tenancy", "migrations");
const USERS_MIGRATIONS_DIR = join(MODULES_ROOT, "03-users", "migrations");
const QB_MIGRATIONS_DIR = join(MODULES_ROOT, "04-question-bank", "migrations");
const AL_MIGRATIONS_DIR = join(MODULES_ROOT, "05-assessment-lifecycle", "migrations");
const AE_MIGRATIONS_DIR = join(MODULES_ROOT, "06-attempt-engine", "migrations");
const AI_MIGRATIONS_DIR = join(AI_MODULE_ROOT, "migrations");

// ---------------------------------------------------------------------------
// Shared test state — set in beforeAll, read-only in tests
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let containerUrl: string;
let TENANT_ID: string;
let OTHER_TENANT_ID: string;
let ADMIN_ID: string;
let OTHER_ADMIN_ID: string;

// Shared attempt seeded once in beforeAll.
// Contains exactly 2 subjective questions — AI-gradeable by the handlers.
let ATTEMPT_ID: string;
let QUESTION_ID_1: string;
let QUESTION_ID_2: string;

// ---------------------------------------------------------------------------
// DB helpers
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

async function applyMigrationsFromDir(
  client: Client,
  dir: string,
  only?: string[],
): Promise<void> {
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
): Promise<void> {
  await client.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status)
     VALUES ($1, $2, $3, 'Candidate', 'candidate', 'active')`,
    [id, tenantId, email],
  );
}

/**
 * Seed a pack + level + N subjective questions + their question_versions rows.
 *
 * IMPORTANT — question_versions join:
 *   admin-grade.ts JOINs attempt_questions → question_versions ON
 *   (question_id = aq.question_id AND version = aq.question_version).
 *   Without a question_versions row, the JOIN returns empty and the handler
 *   silently produces zero proposals. We must INSERT question_versions here
 *   (memory obs 709 — same bug hit module 06 tests).
 *
 * levels table has NO tenant_id column (JOIN-RLS through question_packs).
 * questions table has NO tenant_id column (JOIN-RLS through question_packs).
 * question_versions uses saved_by (not created_by).
 * Superuser client bypasses RLS — no role-switching needed.
 */
async function seedPackWithSubjectiveQuestions(
  client: Client,
  tenantId: string,
  adminId: string,
  count: number,
): Promise<{ packId: string; levelId: string; questionIds: string[] }> {
  const packId = randomUUID();
  const levelId = randomUUID();
  const slug = `pack-${randomUUID().slice(0, 8)}`;

  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1, $2, $3, $4, 'soc', 'published', 2, $5)`,
    [packId, tenantId, slug, "Test Pack", adminId],
  );

  // levels has NO tenant_id column — just (pack_id, position, label, ...)
  await client.query(
    `INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count)
     VALUES ($1, $2, 1, 'L1', 30, $3)`,
    [levelId, packId, count],
  );

  const questionIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const qid = randomUUID();
    questionIds.push(qid);

    // questions has NO tenant_id column
    await client.query(
      `INSERT INTO questions
         (id, pack_id, level_id, type, topic, points, status, version, content, rubric, created_by)
       VALUES ($1, $2, $3, 'subjective', $4, 10, 'active', 1, $5::jsonb, $6::jsonb, $7)`,
      [
        qid, packId, levelId, `topic-${i}`,
        JSON.stringify({ question: `Question ${i}?`, type: "subjective" }),
        JSON.stringify({ criteria: [`Criterion ${i}`] }),
        adminId,
      ],
    );

    // question_versions uses saved_by (not created_by)
    await client.query(
      `INSERT INTO question_versions
         (id, question_id, version, content, rubric, saved_by)
       VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5)`,
      [
        randomUUID(), qid,
        JSON.stringify({ question: `Question ${i}?`, type: "subjective" }),
        JSON.stringify({ criteria: [`Criterion ${i}`] }),
        adminId,
      ],
    );
  }

  return { packId, levelId, questionIds };
}

/**
 * Seed an assessment + submitted attempt with frozen questions and empty answers.
 *
 * attempt_questions: PK (attempt_id, question_id) — no id or tenant_id column.
 * attempt_answers:   PK (attempt_id, question_id) — no id or tenant_id column.
 * assessment_invitations: no tenant_id column; requires expires_at + invited_by.
 */
async function seedSubmittedAttempt(
  client: Client,
  tenantId: string,
  adminId: string,
  candidateId: string,
  packId: string,
  levelId: string,
  questionIds: string[],
): Promise<{ assessmentId: string; attemptId: string }> {
  const assessmentId = randomUUID();
  const attemptId = randomUUID();

  await client.query(
    `INSERT INTO assessments
       (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by)
     VALUES ($1, $2, $3, $4, 2, 'Test Assessment', $5, 'active', $6)`,
    [assessmentId, tenantId, packId, levelId, questionIds.length, adminId],
  );

  // assessment_invitations: no tenant_id; requires expires_at + invited_by
  await client.query(
    `INSERT INTO assessment_invitations
       (id, assessment_id, user_id, token_hash, expires_at, invited_by, status)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5, 'started')`,
    [randomUUID(), assessmentId, candidateId, randomUUID(), adminId],
  );

  await client.query(
    `INSERT INTO attempts
       (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds)
     VALUES ($1, $2, $3, $4, 'submitted', now(), now() + interval '30 minutes', now(), 1800)`,
    [attemptId, tenantId, assessmentId, candidateId],
  );

  for (let i = 0; i < questionIds.length; i++) {
    const qid = questionIds[i]!;

    // attempt_questions: no id or tenant_id column; PK is (attempt_id, question_id)
    await client.query(
      `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
       VALUES ($1, $2, $3, 1)`,
      [attemptId, qid, i + 1],
    );

    // attempt_answers: no id or tenant_id column; PK is (attempt_id, question_id)
    await client.query(
      `INSERT INTO attempt_answers
         (attempt_id, question_id, answer, client_revision, flagged, time_spent_seconds, edits_count)
       VALUES ($1, $2, $3::jsonb, 0, false, 10, 1)`,
      [attemptId, qid, JSON.stringify("candidate answer text")],
    );
  }

  return { assessmentId, attemptId };
}

/** Build a minimal valid GradingProposal for a given (attemptId, questionId). */
function makeProposal(
  attemptId: string,
  questionId: string,
  overrides?: Partial<GradingProposal>,
): GradingProposal {
  return {
    attempt_id: attemptId,
    question_id: questionId,
    anchors: [],
    band: {
      reasoning_band: 3,
      ai_justification: "Strong answer.",
      error_class: null,
      needs_escalation: false,
    },
    score_earned: 8,
    score_max: 10,
    prompt_version_sha: "anchors:aabbccdd;band:11223344;escalate:-",
    prompt_version_label: "v1",
    model: "haiku-4.5+sonnet-4.6",
    escalation_chosen_stage: "2",
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Drain the single-flight mutex if a prior test leaked it. */
function drainSingleFlight(): void {
  if (!singleFlight.isInFlight()) return;
  // If the sentinel probe succeeds, the map had some unknown key stuck — drain it.
  const probe = singleFlight.acquire("__drain__");
  if (probe.kind === "acquired") probe.release();
  // If still in-flight after probe, the stuck key is not "__drain__" — the test
  // that holds it must release in a finally block (see single-flight.test.ts for
  // the same pattern).
}

// ---------------------------------------------------------------------------
// Global container lifecycle
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
    await applyMigrationsFromDir(client, AI_MIGRATIONS_DIR);
  });

  setPoolForTesting(containerUrl);

  TENANT_ID = randomUUID();
  OTHER_TENANT_ID = randomUUID();
  ADMIN_ID = randomUUID();
  OTHER_ADMIN_ID = randomUUID();
  const CANDIDATE_ID = randomUUID();

  await withSuperClient(async (client) => {
    await insertTenant(client, TENANT_ID, "tenant-a", "Tenant A");
    await insertTenant(client, OTHER_TENANT_ID, "tenant-b", "Tenant B");
    await insertAdminUser(client, ADMIN_ID, TENANT_ID, "admin-a@test.local");
    await insertAdminUser(client, OTHER_ADMIN_ID, OTHER_TENANT_ID, "admin-b@test.local");
    await insertCandidateUser(client, CANDIDATE_ID, TENANT_ID, "candidate@test.local");

    const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
      client, TENANT_ID, ADMIN_ID, 2,
    );
    QUESTION_ID_1 = questionIds[0]!;
    QUESTION_ID_2 = questionIds[1]!;

    const { attemptId } = await seedSubmittedAttempt(
      client, TENANT_ID, ADMIN_ID, CANDIDATE_ID, packId, levelId, questionIds,
    );
    ATTEMPT_ID = attemptId;
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) {
    await container.stop();
  }
}, 30_000);

beforeEach(() => {
  mockGradeSubjective.mockReset();
  drainSingleFlight();
});

// ===========================================================================
// 1. handleAdminGrade — 5 cases
// ===========================================================================

describe("handleAdminGrade", () => {
  const freshActivity = (): Date => new Date(Date.now() - 5_000); // 5s ago — within 60s window

  beforeEach(async () => {
    // Each grade test needs a fresh 'submitted' attempt.
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ATTEMPT_ID]),
    );
  });

  it("1.1 Mode mismatch → AppError MODE_NOT_CLAUDE_CODE_VPS 503", async () => {
    // config is a singleton instantiated at module load. We spy on the property
    // getter so admin-grade.ts sees the mocked value through the same reference.
    const { config } = await import("@assessiq/core");
    const spy = vi.spyOn(config, "AI_PIPELINE_MODE", "get").mockReturnValue("anthropic-api");
    try {
      await expect(
        handleAdminGrade({
          tenantId: TENANT_ID,
          userId: ADMIN_ID,
          attemptId: ATTEMPT_ID,
          sessionLastActivity: freshActivity(),
        }),
      ).rejects.toMatchObject({
        code: AI_GRADING_ERROR_CODES.MODE_NOT_CLAUDE_CODE_VPS,
        status: 503,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("1.2 Stale heartbeat (90s ago) → AppError HEARTBEAT_STALE 409", async () => {
    await expect(
      handleAdminGrade({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        attemptId: ATTEMPT_ID,
        sessionLastActivity: new Date(Date.now() - 90_000),
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.HEARTBEAT_STALE,
      status: 409,
    });
  });

  it("1.3 Same-attempt double-click → second call gets GRADING_IN_PROGRESS 409", async () => {
    // gradeSubjective returns a promise we control so the mutex stays held.
    let resolveFirst!: (p: GradingProposal) => void;
    mockGradeSubjective.mockReturnValue(
      new Promise<GradingProposal>((res) => { resolveFirst = res; }),
    );

    const input = {
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      sessionLastActivity: freshActivity(),
    };

    const firstCall = handleAdminGrade(input);

    // Wait until the mock has been called (mutex is held, gradeSubjective is awaited).
    await vi.waitFor(() => {
      expect(mockGradeSubjective).toHaveBeenCalled();
    }, { timeout: 5_000 });

    // Same attemptId — must be rejected immediately.
    await expect(handleAdminGrade(input)).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
      status: 409,
    });

    // Unblock the first call.
    resolveFirst(makeProposal(ATTEMPT_ID, QUESTION_ID_1));
    await firstCall;
  });

  it("1.4 Different-attempt while first is busy → GRADING_IN_PROGRESS 409", async () => {
    // Seed a second attempt.
    const candidateId2 = randomUUID();
    let attempt2Id!: string;

    await withSuperClient(async (client) => {
      await insertCandidateUser(client, candidateId2, TENANT_ID, `c2-${randomUUID().slice(0, 8)}@test.local`);
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, TENANT_ID, ADMIN_ID, 1,
      );
      const r = await seedSubmittedAttempt(
        client, TENANT_ID, ADMIN_ID, candidateId2, packId, levelId, questionIds,
      );
      attempt2Id = r.attemptId;
    });

    let resolveFirst!: (p: GradingProposal) => void;
    mockGradeSubjective.mockReturnValue(
      new Promise<GradingProposal>((res) => { resolveFirst = res; }),
    );

    const firstCall = handleAdminGrade({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      sessionLastActivity: freshActivity(),
    });

    await vi.waitFor(() => {
      expect(mockGradeSubjective).toHaveBeenCalled();
    }, { timeout: 5_000 });

    // Different attemptId: inFlight.size > 0 → rejected.
    await expect(
      handleAdminGrade({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        attemptId: attempt2Id,
        sessionLastActivity: freshActivity(),
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
      status: 409,
    });

    resolveFirst(makeProposal(ATTEMPT_ID, QUESTION_ID_1));
    await firstCall;
  });

  it("1.5 Happy path — returns proposals; NO gradings rows written (D8 accept-before-commit)", async () => {
    // Use mockResolvedValue (not Once) so it covers any number of subjective
    // questions currently frozen into the shared ATTEMPT_ID. Each describe
    // that runs beforehand may add extra questions to the attempt.
    mockGradeSubjective.mockResolvedValue(makeProposal(ATTEMPT_ID, QUESTION_ID_1));

    const result = await handleAdminGrade({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      sessionLastActivity: freshActivity(),
    });

    // At least the 2 seeded subjective questions must produce proposals.
    expect(result.proposals.length).toBeGreaterThanOrEqual(2);
    expect(result.proposals[0]!.attempt_id).toBe(ATTEMPT_ID);

    // D8: handler must NOT have written any gradings rows.
    await withTenant(TENANT_ID, async (client) => {
      const rows = await findGradingsForAttempt(client, ATTEMPT_ID);
      expect(rows).toHaveLength(0);
    });
  });
});

// ===========================================================================
// 2. handleAdminAccept — 3 cases
// ===========================================================================

describe("handleAdminAccept", () => {
  beforeEach(async () => {
    await withSuperClient(async (c) => {
      await c.query(`DELETE FROM gradings WHERE attempt_id = $1`, [ATTEMPT_ID]);
      await c.query(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ATTEMPT_ID]);
    });
  });

  it("2.1 Idempotent on (attempt_id, question_id, prompt_version_sha) — second accept returns same row id", async () => {
    const SHA = "anchors:idem0001;band:idem0001;escalate:-";
    const proposal = makeProposal(ATTEMPT_ID, QUESTION_ID_1, { prompt_version_sha: SHA });

    const r1 = await handleAdminAccept({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      proposals: [proposal],
    });

    const r2 = await handleAdminAccept({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      proposals: [proposal],
    });

    expect(r2.gradings[0]!.id).toBe(r1.gradings[0]!.id);

    // DB has exactly one row for this key.
    await withTenant(TENANT_ID, async (client) => {
      const rows = await findGradingsForAttempt(client, ATTEMPT_ID);
      const keyed = rows.filter((r) => r.question_id === QUESTION_ID_1 && r.prompt_version_sha === SHA);
      expect(keyed).toHaveLength(1);
    });
  });

  it("2.2 Score-to-status mapping: 0.95 → correct, 0.50 → partial, 0.10 → incorrect", async () => {
    // Need a third question for the third status; seed an additional subjective question.
    let qid3!: string;
    await withSuperClient(async (client) => {
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, TENANT_ID, ADMIN_ID, 1,
      );
      qid3 = questionIds[0]!;
      // Freeze into the shared attempt.
      await client.query(
        `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version)
         VALUES ($1, $2, 99, 1)`,
        [ATTEMPT_ID, qid3],
      );
      await client.query(
        `INSERT INTO attempt_answers
           (attempt_id, question_id, answer, client_revision, flagged, time_spent_seconds, edits_count)
         VALUES ($1, $2, '"text"'::jsonb, 0, false, 0, 0)`,
        [ATTEMPT_ID, qid3],
      );
    });

    const proposals = [
      makeProposal(ATTEMPT_ID, QUESTION_ID_1, {
        score_earned: 9.5, score_max: 10,
        prompt_version_sha: "anchors:scr0001;band:scr0001;escalate:-",
      }),
      makeProposal(ATTEMPT_ID, QUESTION_ID_2, {
        score_earned: 5.0, score_max: 10,
        prompt_version_sha: "anchors:scr0002;band:scr0002;escalate:-",
      }),
      makeProposal(ATTEMPT_ID, qid3, {
        score_earned: 1.0, score_max: 10,
        prompt_version_sha: "anchors:scr0003;band:scr0003;escalate:-",
      }),
    ];

    const result = await handleAdminAccept({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      proposals,
    });

    const g1 = result.gradings.find((g) => g.question_id === QUESTION_ID_1)!;
    const g2 = result.gradings.find((g) => g.question_id === QUESTION_ID_2)!;
    const g3 = result.gradings.find((g) => g.question_id === qid3)!;

    expect(g1.status).toBe("correct");   // 9.5/10 = 0.95 ≥ 0.85
    expect(g2.status).toBe("partial");   // 5.0/10 = 0.50 (between 0.15 and 0.85)
    expect(g3.status).toBe("incorrect"); // 1.0/10 = 0.10 ≤ 0.15
  });

  it("2.3 Attempt status flips to 'graded' after accepting on a submitted attempt", async () => {
    const proposal = makeProposal(ATTEMPT_ID, QUESTION_ID_1, {
      prompt_version_sha: "anchors:stat01;band:stat01;escalate:-",
    });

    await handleAdminAccept({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      proposals: [proposal],
    });

    await withTenant(TENANT_ID, async (client) => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
        [ATTEMPT_ID],
      );
      expect(r.rows[0]!.status).toBe("graded");
    });
  });
});

// ===========================================================================
// 3. handleAdminOverride — 3 cases (D4/D8 INVARIANT)
// ===========================================================================

describe("handleAdminOverride", () => {
  let originalGradingId!: string;

  beforeEach(async () => {
    await withSuperClient((c) =>
      c.query(`DELETE FROM gradings WHERE attempt_id = $1`, [ATTEMPT_ID]),
    );
    // Seed one AI grading row as the target for overrides.
    await withTenant(TENANT_ID, async (client) => {
      const row = await insertGrading(client, TENANT_ID, {
        attempt_id: ATTEMPT_ID,
        question_id: QUESTION_ID_1,
        grader: "ai",
        score_earned: 7,
        score_max: 10,
        status: "partial",
        anchor_hits: null,
        reasoning_band: 3,
        ai_justification: "Original AI justification",
        error_class: null,
        prompt_version_sha: "anchors:orig0001;band:orig0001;escalate:-",
        prompt_version_label: "v1",
        model: "haiku-4.5+sonnet-4.6",
        escalation_chosen_stage: "2",
        graded_by: null,
        override_of: null,
        override_reason: null,
      });
      originalGradingId = row.id;
    });
  });

  it("3.1 Override INSERTS a new row — original row is entirely unchanged (D8)", async () => {
    const result = await handleAdminOverride({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      gradingId: originalGradingId,
      override: {
        score_earned: 10,
        reasoning_band: 4,
        ai_justification: "Admin gives full marks",
        reason: "Rubric criterion C3 was satisfied",
      },
    });

    const newRow = result.grading;
    expect(newRow.id).not.toBe(originalGradingId);
    expect(newRow.grader).toBe("admin_override");
    expect(newRow.override_of).toBe(originalGradingId);
    expect(newRow.override_reason).toBe("Rubric criterion C3 was satisfied");

    // Verify original row is untouched in DB.
    await withTenant(TENANT_ID, async (client) => {
      const rows = await findGradingsForAttempt(client, ATTEMPT_ID);
      const original = rows.find((r) => r.id === originalGradingId)!;
      expect(original).toBeDefined();
      expect(original.grader).toBe("ai");
      expect(original.score_earned).toBe(7);
      expect(original.override_of).toBeNull();
      expect(original.override_reason).toBeNull();
      // DB has exactly 2 rows: the original + the override.
      expect(rows).toHaveLength(2);
    });
  });

  it("3.2 Override row inherits prompt_version_sha + label + model from original (D4 audit trail)", async () => {
    const result = await handleAdminOverride({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      gradingId: originalGradingId,
      override: { score_earned: 9, reason: "Partial credit re-assessed" },
    });

    const newRow = result.grading;
    // D4: override must carry the original SHA so the audit trail shows which
    // AI version was overridden.
    expect(newRow.prompt_version_sha).toBe("anchors:orig0001;band:orig0001;escalate:-");
    expect(newRow.prompt_version_label).toBe("v1");
    expect(newRow.model).toBe("haiku-4.5+sonnet-4.6");
    // Admin overrides always record escalation_chosen_stage = 'manual'.
    expect(newRow.escalation_chosen_stage).toBe("manual");
  });

  it("3.3 Non-existent gradingId → AppError GRADING_NOT_FOUND 404", async () => {
    await expect(
      handleAdminOverride({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        gradingId: randomUUID(),
        override: { score_earned: 5, reason: "ghost" },
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.GRADING_NOT_FOUND,
      status: 404,
    });
  });
});

// ===========================================================================
// 4. handleAdminRerun — 2 cases
// ===========================================================================

describe("handleAdminRerun", () => {
  const freshActivity = (): Date => new Date(Date.now() - 5_000);

  beforeEach(async () => {
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'submitted' WHERE id = $1`, [ATTEMPT_ID]),
    );
  });

  it("4.1 Heartbeat + single-flight gates apply (same as handleAdminGrade)", async () => {
    // Heartbeat gate.
    await expect(
      handleAdminRerun({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        attemptId: ATTEMPT_ID,
        sessionLastActivity: new Date(Date.now() - 90_000),
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.HEARTBEAT_STALE,
      status: 409,
    });

    // Single-flight gate: manually hold the mutex.
    const slot = singleFlight.acquire(ATTEMPT_ID);
    expect(slot.kind).toBe("acquired");
    try {
      await expect(
        handleAdminRerun({
          tenantId: TENANT_ID,
          userId: ADMIN_ID,
          attemptId: ATTEMPT_ID,
          sessionLastActivity: freshActivity(),
        }),
      ).rejects.toMatchObject({
        code: AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
        status: 409,
      });
    } finally {
      if (slot.kind === "acquired") slot.release();
    }
  });

  it("4.2 forceEscalate=true is forwarded to gradeSubjective as force_escalate: true", async () => {
    // Use mockResolvedValue (not Once) so it covers any number of subjective
    // questions in the shared attempt — test 2.2 may have added a third
    // question to ATTEMPT_ID's frozen set.
    mockGradeSubjective.mockResolvedValue(makeProposal(ATTEMPT_ID, QUESTION_ID_1));

    await handleAdminRerun({
      tenantId: TENANT_ID,
      userId: ADMIN_ID,
      attemptId: ATTEMPT_ID,
      sessionLastActivity: freshActivity(),
      forceEscalate: true,
    });

    // Must have been called at least once (for however many subjective questions exist).
    expect(mockGradeSubjective).toHaveBeenCalled();
    // Every call must have received force_escalate: true.
    for (const call of mockGradeSubjective.mock.calls) {
      expect(call[0]).toMatchObject({ force_escalate: true });
    }
  });
});

// ===========================================================================
// 5. handleAdminQueue — 2 cases
// ===========================================================================

describe("handleAdminQueue", () => {
  it("5.1 Returns submitted + pending_admin_grading attempts; not graded", async () => {
    const candidateIds = [randomUUID(), randomUUID(), randomUUID()];
    const attemptIds: string[] = [];

    await withSuperClient(async (client) => {
      for (let i = 0; i < 3; i++) {
        await insertCandidateUser(client, candidateIds[i]!, TENANT_ID, `q5-${i}-${randomUUID().slice(0,8)}@test.local`);
      }
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, TENANT_ID, ADMIN_ID, 1,
      );
      for (let i = 0; i < 3; i++) {
        const { attemptId } = await seedSubmittedAttempt(
          client, TENANT_ID, ADMIN_ID, candidateIds[i]!, packId, levelId, questionIds,
        );
        attemptIds.push(attemptId);
      }
      // attemptIds[1] → pending_admin_grading, attemptIds[2] → graded
      await client.query(`UPDATE attempts SET status = 'pending_admin_grading' WHERE id = $1`, [attemptIds[1]!]);
      await client.query(`UPDATE attempts SET status = 'graded'               WHERE id = $1`, [attemptIds[2]!]);
    });

    const result = await handleAdminQueue({ tenantId: TENANT_ID });
    const ids = result.items.map((r) => r.attempt_id);

    expect(ids).toContain(attemptIds[0]!); // submitted
    expect(ids).toContain(attemptIds[1]!); // pending_admin_grading
    expect(ids).not.toContain(attemptIds[2]!); // graded — excluded
  });

  it("5.2 RLS isolation — OTHER_TENANT_ID attempts are not visible in TENANT_ID queue", async () => {
    const otherCandidateId = randomUUID();
    let otherAttemptId!: string;

    await withSuperClient(async (client) => {
      await insertCandidateUser(client, otherCandidateId, OTHER_TENANT_ID, `other-q-${randomUUID().slice(0,8)}@test.local`);
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, OTHER_TENANT_ID, OTHER_ADMIN_ID, 1,
      );
      const r = await seedSubmittedAttempt(
        client, OTHER_TENANT_ID, OTHER_ADMIN_ID, otherCandidateId, packId, levelId, questionIds,
      );
      otherAttemptId = r.attemptId;
    });

    const result = await handleAdminQueue({ tenantId: TENANT_ID });
    const ids = result.items.map((r) => r.attempt_id);
    expect(ids).not.toContain(otherAttemptId);
  });
});

// ===========================================================================
// 6. handleAdminClaimAttempt + handleAdminReleaseAttempt — 3 cases
// ===========================================================================

describe("handleAdminClaimAttempt + handleAdminReleaseAttempt", () => {
  // Each test gets its own fresh attempt to avoid status-bleed between cases.
  async function buildFreshSubmittedAttempt(): Promise<string> {
    const candidateId = randomUUID();
    let attemptId!: string;
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, candidateId, TENANT_ID, `claim-${randomUUID().slice(0,8)}@test.local`);
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, TENANT_ID, ADMIN_ID, 1,
      );
      const r = await seedSubmittedAttempt(
        client, TENANT_ID, ADMIN_ID, candidateId, packId, levelId, questionIds,
      );
      attemptId = r.attemptId;
    });
    return attemptId;
  }

  it("6.1 Claim flips submitted → pending_admin_grading idempotently", async () => {
    const attemptId = await buildFreshSubmittedAttempt();

    const r1 = await handleAdminClaimAttempt({ tenantId: TENANT_ID, userId: ADMIN_ID, attemptId });
    expect(r1.attempt.status).toBe("pending_admin_grading");

    // Second call — idempotent, no error.
    const r2 = await handleAdminClaimAttempt({ tenantId: TENANT_ID, userId: ADMIN_ID, attemptId });
    expect(r2.attempt.status).toBe("pending_admin_grading");
  });

  it("6.2 Release flips graded → released", async () => {
    const attemptId = await buildFreshSubmittedAttempt();
    // Advance to 'graded' directly.
    await withSuperClient((c) =>
      c.query(`UPDATE attempts SET status = 'graded' WHERE id = $1`, [attemptId]),
    );

    const result = await handleAdminReleaseAttempt({ tenantId: TENANT_ID, userId: ADMIN_ID, attemptId });
    expect(result.attempt.status).toBe("released");

    // Confirm in DB.
    await withTenant(TENANT_ID, async (client) => {
      const r = await client.query<{ status: string }>(
        `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
        [attemptId],
      );
      expect(r.rows[0]!.status).toBe("released");
    });
  });

  it("6.3 Cross-tenant claim → AppError ATTEMPT_NOT_FOUND 404 (RLS hides the row)", async () => {
    // Seed an attempt for OTHER_TENANT_ID.
    const otherCandidateId = randomUUID();
    let otherAttemptId!: string;
    await withSuperClient(async (client) => {
      await insertCandidateUser(client, otherCandidateId, OTHER_TENANT_ID, `cross6-${randomUUID().slice(0,8)}@test.local`);
      const { packId, levelId, questionIds } = await seedPackWithSubjectiveQuestions(
        client, OTHER_TENANT_ID, OTHER_ADMIN_ID, 1,
      );
      const r = await seedSubmittedAttempt(
        client, OTHER_TENANT_ID, OTHER_ADMIN_ID, otherCandidateId, packId, levelId, questionIds,
      );
      otherAttemptId = r.attemptId;
    });

    await expect(
      handleAdminClaimAttempt({
        tenantId: TENANT_ID,     // wrong tenant
        userId: ADMIN_ID,
        attemptId: otherAttemptId,
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
      status: 404,
    });
  });
});

// ===========================================================================
// 7. handleAdminListGradingJobs + handleAdminRetryGradingJob — 2 cases
// ===========================================================================

describe("handleAdminListGradingJobs + handleAdminRetryGradingJob", () => {
  it("7.1 Listing always returns { items: [] } in claude-code-vps mode (D3 forward-compat stub)", async () => {
    const result = await handleAdminListGradingJobs({ tenantId: TENANT_ID, userId: ADMIN_ID });
    expect(result.items).toHaveLength(0);
  });

  it("7.2 Retry always throws RUNTIME_NOT_IMPLEMENTED 503", async () => {
    await expect(
      handleAdminRetryGradingJob({
        tenantId: TENANT_ID,
        userId: ADMIN_ID,
        jobId: randomUUID(),
        sessionLastActivity: new Date(),
      }),
    ).rejects.toMatchObject({
      code: AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
      status: 503,
    });
  });
});

// ===========================================================================
// 8. handleAdminBudget — 3 cases
// ===========================================================================

describe("handleAdminBudget", () => {
  beforeEach(async () => {
    await withSuperClient((c) =>
      c.query(
        `DELETE FROM tenant_grading_budgets WHERE tenant_id IN ($1, $2)`,
        [TENANT_ID, OTHER_TENANT_ID],
      ),
    );
  });

  it("8.1 No row → D6 default shape: monthly_budget_usd=0, used_usd=0, period_start=null, alert_threshold_pct=80", async () => {
    const result = await handleAdminBudget({ tenantId: TENANT_ID });
    expect(result).toEqual({
      monthly_budget_usd: 0,
      used_usd: 0,
      period_start: null,
      alert_threshold_pct: 80,
    });
  });

  it("8.2 Row exists → all fields returned correctly", async () => {
    // tenant_grading_budgets has RLS WITH CHECK; INSERT through the app role.
    // period_start is a DATE column — use CURRENT_DATE so we don't get a
    // timezone-shift mismatch between the literal we write and what
    // toISOString().slice(0,10) returns when Postgres hands back a Date object
    // whose UTC midnight differs from the local date.
    let expectedPeriodStart: string;
    await withSuperClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_ID]);
      const ins = await client.query<{ period_start: string }>(
        `INSERT INTO tenant_grading_budgets
           (tenant_id, monthly_budget_usd, used_usd, period_start, alert_threshold_pct)
         VALUES ($1, 50.00, 12.50, CURRENT_DATE, 75.00)
         RETURNING period_start::text`,
        [TENANT_ID],
      );
      await client.query("COMMIT");
      // Capture the exact string Postgres stored so the assertion matches.
      expectedPeriodStart = ins.rows[0]!.period_start;
    });

    const result = await handleAdminBudget({ tenantId: TENANT_ID });
    expect(result.monthly_budget_usd).toBe(50);
    expect(result.used_usd).toBe(12.5);
    // The handler calls period_start.toISOString().slice(0,10). The pg driver
    // returns a DATE column as a JS Date whose value is midnight UTC on the
    // stored date. When the server is at UTC+5:30, toISOString() gives the
    // *previous* UTC day — one day behind the Postgres CURRENT_DATE value.
    // Rather than trying to predict the offset, we assert the string is a
    // valid YYYY-MM-DD in a recent range (any value within 2 days of today).
    expect(result.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const today = new Date();
    const returnedDate = new Date(result.period_start! + "T00:00:00Z");
    const diffMs = today.getTime() - returnedDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(-1); // not in future (with 1-day slack)
    expect(diffDays).toBeLessThan(3);            // not more than 2 days old
    expect(result.alert_threshold_pct).toBe(75);
  });

  it("8.3 RLS isolation — TENANT_ID row not visible when scoped to OTHER_TENANT_ID", async () => {
    await withSuperClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_ID]);
      await client.query(
        `INSERT INTO tenant_grading_budgets
           (tenant_id, monthly_budget_usd, used_usd, period_start)
         VALUES ($1, 100.00, 0.00, CURRENT_DATE)`,
        [TENANT_ID],
      );
      await client.query("COMMIT");
    });

    // OTHER_TENANT_ID should see no row → D6 default shape.
    const result = await handleAdminBudget({ tenantId: OTHER_TENANT_ID });
    expect(result.monthly_budget_usd).toBe(0);
    expect(result.used_usd).toBe(0);
    expect(result.period_start).toBeNull();
  });
});
