/**
 * Unit tests: Phase 2 Slice A — C3 blueprint-aware draw at startAttempt.
 *
 * Verifies:
 *  (a) Per-criterion draw returns exactly Σcount when pool is sufficient.
 *  (b) Degrades gracefully (draws available subset, logs warn) when a criterion
 *      pool is short at draw time (post-publish shrinkage).
 *  (c) No-blueprint regression: the legacy full-pool path is IDENTICAL to
 *      pre-slice behaviour — any modification here is a regression.
 *
 * Does NOT need a database — withTenant and repo functions are mocked.
 * Pattern mirrors find-or-create-pack-for-domain.test.ts / generate-cross-tenant-guard.test.ts.
 *
 * LOAD-BEARING: the no-blueprint regression path (c) is the primary
 * regression-safety gate. Opus adversarially reviews this before deploy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "@assessiq/core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(),
}));

vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return {
    ...actual,
    uuidv7: vi.fn().mockReturnValue("attempt-uuid-0000-0000-0000-000000000001"),
  };
});

// Mock 05-assessment-lifecycle repository (alRepo)
vi.mock("../../../05-assessment-lifecycle/src/repository.js", () => ({
  findAssessmentById: vi.fn(),
}));

// Mock 04-question-bank repository (qbRepo)
vi.mock("../../../04-question-bank/src/repository.js", () => ({
  findLevelById: vi.fn().mockResolvedValue({
    id: "level-id",
    pack_id: "pack-id",
    duration_minutes: 60,
  }),
}));

// Mock 06 repository
vi.mock("../repository.js", () => ({
  findAttemptByAssessmentAndUser: vi.fn().mockResolvedValue(null), // no existing attempt
  // countFrozenPool → 0 keeps useFrozen=false so these tests exercise the LIVE
  // draw (listActiveQuestionPoolFor*), which is what they assert against. The
  // frozen list fns are stubbed for completeness; useFrozen=false never calls them.
  countFrozenPool: vi.fn().mockResolvedValue(0),
  listFrozenPoolForPick: vi.fn(),
  listFrozenPoolForCriterion: vi.fn(),
  listActiveQuestionPoolForPick: vi.fn(),
  listActiveQuestionPoolForCriterion: vi.fn(),
  findInvitationForCandidate: vi.fn().mockResolvedValue({
    id: "invitation-id",
    status: "pending",
    expires_at: new Date(Date.now() + 86_400_000), // 24h from now
  }),
  insertAttempt: vi.fn().mockResolvedValue({
    id: "attempt-uuid-0000-0000-0000-000000000001",
    tenant_id: "tenant-a",
    assessment_id: "assessment-id",
    user_id: "user-id",
    status: "in_progress",
    started_at: new Date(),
    ends_at: new Date(Date.now() + 3_600_000),
    submitted_at: null,
    duration_seconds: 3600,
    created_at: new Date(),
    embed_origin: false,
  }),
  insertAttemptQuestions: vi.fn().mockResolvedValue(undefined),
  insertEmptyAttemptAnswers: vi.fn().mockResolvedValue(undefined),
  markInvitationStarted: vi.fn().mockResolvedValue(undefined),
  insertAttemptEvent: vi.fn().mockResolvedValue(undefined),
  updateAttemptStatus: vi.fn(),
  markInvitationSubmitted: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-a-uuid-0000-0000-000000000001";
const DOMAIN_ID = "domain-00000000-bbbb-4ccc-dddd-eeeeeeeeeeee";
const CAT_ID_1 = "cat-0000000a-0000-4000-8000-aaaaaaaaaaaa";
const CAT_ID_2 = "cat-0000000b-0000-4000-8000-bbbbbbbbbbbb";
const PACK_ID = "pack-00000000-0000-0000-0000-000000000001";
const LEVEL_ID = "level-L1-0000-0000-0000-000000000002";

function makeBlueprint(counts: { count1: number; count2: number }) {
  return {
    domain_id: DOMAIN_ID,
    level: "L1",
    criteria: [
      { category_id: CAT_ID_1, type: "mcq", count: counts.count1 },
      { category_id: CAT_ID_2, type: "scenario", count: counts.count2 },
    ],
  };
}

function makeAssessment(blueprint?: object, questionCount = 5) {
  return {
    id: "assessment-id",
    tenant_id: TENANT_A,
    pack_id: PACK_ID,
    level_id: LEVEL_ID,
    pack_version: 1,
    name: "Test Assessment",
    description: null,
    status: "active",
    question_count: questionCount,
    randomize: false,   // disable shuffle for deterministic test assertions
    opens_at: null,
    closes_at: null,
    settings: blueprint !== undefined ? { blueprint } : {},
    created_by: "admin-user-id",
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeQuestionPool(prefix: string, count: number): Array<{ id: string; version: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-q-${i + 1}`,
    version: 1,
  }));
}

// ---------------------------------------------------------------------------
// C3(a): per-criterion draw returns exactly Σcount when pool sufficient
// ---------------------------------------------------------------------------

describe("C3(a) — blueprint draw returns exactly Σcount when pool sufficient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws 3 + 2 = 5 questions from two criteria", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
    const repo = await import("../repository.js");

    const blueprint = makeBlueprint({ count1: 3, count2: 2 });
    const assessment = makeAssessment(blueprint, 5);

    (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment);

    // criterion 0: 5 available, need 3
    // criterion 1: 4 available, need 2
    (repo.listActiveQuestionPoolForCriterion as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeQuestionPool("cat1", 5))
      .mockResolvedValueOnce(makeQuestionPool("cat2", 4));

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
    );

    const { startAttempt } = await import("../service.js");

    await startAttempt(TENANT_A, {
      userId: "user-id",
      assessmentId: "assessment-id",
      embedOrigin: false,
    });

    // Verify insertAttemptQuestions was called with 5 questions (3 + 2)
    // Signature: insertAttemptQuestions(client, attemptId, rows) → rows is at index 2
    expect(repo.insertAttemptQuestions).toHaveBeenCalledOnce();
    const aqRows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Array<{ questionId: string; position: number; questionVersion: number }> | undefined;
    expect(aqRows).toBeDefined();
    expect(aqRows!).toHaveLength(5);

    // First 3 are from cat1 pool (no shuffle since randomize=false)
    expect(aqRows![0]?.questionId).toContain("cat1");
    expect(aqRows![1]?.questionId).toContain("cat1");
    expect(aqRows![2]?.questionId).toContain("cat1");
    // Last 2 from cat2
    expect(aqRows![3]?.questionId).toContain("cat2");
    expect(aqRows![4]?.questionId).toContain("cat2");
  });
});

// ---------------------------------------------------------------------------
// C3(b): degrades gracefully when criterion pool is short at draw time
// ---------------------------------------------------------------------------

describe("C3(b) — blueprint draw degrades gracefully when criterion pool is short", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("draws all available when criterion pool smaller than count (does not throw)", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
    const repo = await import("../repository.js");

    // criterion 0 needs 3, criterion 1 needs 2 — but criterion 1 only has 1
    const blueprint = makeBlueprint({ count1: 3, count2: 2 });
    const assessment = makeAssessment(blueprint, 5);

    (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment);

    (repo.listActiveQuestionPoolForCriterion as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeQuestionPool("cat1", 5))  // 5 available, need 3 → take 3
      .mockResolvedValueOnce(makeQuestionPool("cat2", 1)); // 1 available, need 2 → take 1 (degrade)

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
    );

    const { startAttempt } = await import("../service.js");

    // Must NOT throw — graceful degradation
    await expect(
      startAttempt(TENANT_A, {
        userId: "user-id",
        assessmentId: "assessment-id",
        embedOrigin: false,
      }),
    ).resolves.toBeDefined();

    // Total questions = 3 (from cat1) + 1 (degraded from cat2) = 4
    // Signature: insertAttemptQuestions(client, attemptId, rows) → rows is at index 2
    const aqRows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as unknown[] | undefined;
    expect(aqRows).toBeDefined();
    expect(aqRows!).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// C3(c): no-blueprint regression — full-pool path IDENTICAL to pre-slice
// ---------------------------------------------------------------------------

describe("C3(c) — no-blueprint regression: legacy full-pool path unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses listActiveQuestionPoolForPick (not criterion) for no-blueprint assessment", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
    const repo = await import("../repository.js");

    // Assessment with NO blueprint
    const assessment = makeAssessment(undefined, 3);

    (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment);

    // listActiveQuestionPoolForPick returns 5 questions
    (repo.listActiveQuestionPoolForPick as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeQuestionPool("full", 5));

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
    );

    const { startAttempt } = await import("../service.js");

    await startAttempt(TENANT_A, {
      userId: "user-id",
      assessmentId: "assessment-id",
      embedOrigin: false,
    });

    // MUST use listActiveQuestionPoolForPick (legacy path)
    expect(repo.listActiveQuestionPoolForPick).toHaveBeenCalledOnce();
    // MUST NOT use the blueprint criterion path
    expect(repo.listActiveQuestionPoolForCriterion).not.toHaveBeenCalled();

    // Takes exactly question_count=3 from the pool
    // Signature: insertAttemptQuestions(client, attemptId, rows) → rows is at index 2
    const aqRows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as unknown[] | undefined;
    expect(aqRows).toBeDefined();
    expect(aqRows!).toHaveLength(3);
  });

  it("throws POOL_TOO_SMALL (legacy code) when no-blueprint pool is short", async () => {
    const { withTenant } = await import("@assessiq/tenancy");
    const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
    const repo = await import("../repository.js");

    // Assessment with NO blueprint, needs 10 questions
    const assessment = makeAssessment(undefined, 10);

    (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment);

    // Pool only has 5 — POOL_TOO_SMALL should be thrown (not crash gracefully)
    (repo.listActiveQuestionPoolForPick as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeQuestionPool("full", 5));

    (withTenant as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
    );

    const { startAttempt } = await import("../service.js");

    await expect(
      startAttempt(TENANT_A, {
        userId: "user-id",
        assessmentId: "assessment-id",
        embedOrigin: false,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ValidationError);
      const details = (err as ValidationError).details as Record<string, unknown>;
      // Legacy error code (AE module 06 uses "AE_POOL_TOO_SMALL") — must NOT be POOL_TOO_SMALL_CRITERION
      expect(details["code"]).toBe("AE_POOL_TOO_SMALL");
      expect(details["available"]).toBe(5);
      expect(details["required"]).toBe(10);
      return true;
    });

    // listActiveQuestionPoolForPick was used (legacy path), not criterion path
    expect(repo.listActiveQuestionPoolForPick).toHaveBeenCalledOnce();
    expect(repo.listActiveQuestionPoolForCriterion).not.toHaveBeenCalled();
  });
});
