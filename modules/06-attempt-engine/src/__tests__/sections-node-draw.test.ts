/**
 * Z-123: a test section with node_id draws by taxonomy descendants (imported questions have no
 * category_id); a section with only category_ids draws as before. No database: repo is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

// EXP-18 review gate (covered by retake.test.ts against a real DB)
vi.mock("@assessiq/assessment-lifecycle", () => ({
  assertPoolVerifiedForInvites: vi.fn().mockResolvedValue(undefined),
}));

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
  hasConsentEvent: vi.fn().mockResolvedValue(true), // consent invariant satisfied
  countFrozenPool: vi.fn().mockResolvedValue(0),
  listFrozenPoolForPick: vi.fn(),
  listFrozenPoolForCriterion: vi.fn(),
  listActiveQuestionPoolForPick: vi.fn(),
  listActiveQuestionPoolForCriterion: vi.fn(),
  listPoolWithCategory: vi.fn(),
  listQuestionIdsUnderNode: vi.fn(),
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
  // Per-student option shuffle: no MCQ options known -> every row gets optionOrder null.
  listMcqOptionsForPicks: vi.fn().mockResolvedValue(new Map()),
  listOrderingKeysForPicks: vi.fn().mockResolvedValue(new Map()),
  // EXP-8: no passages in these pools -> draw is unchanged.
  listPassageInfo: vi.fn().mockResolvedValue(new Map()),
  insertEmptyAttemptAnswers: vi.fn().mockResolvedValue(undefined),
  markInvitationStarted: vi.fn().mockResolvedValue(undefined),
  insertAttemptEvent: vi.fn().mockResolvedValue(undefined),
  updateAttemptStatus: vi.fn(),
  markInvitationSubmitted: vi.fn(),
}));

const TENANT_A = "tenant-a-uuid-0000-0000-000000000001";
const NODE = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";

function assessment(sections: unknown[]) {
  return {
    id: "assessment-id", tenant_id: TENANT_A, pack_id: "p", level_id: "l", pack_version: 1, name: "T",
    description: null, status: "active", question_count: 4, randomize: false, opens_at: null, closes_at: null,
    settings: { sections }, created_by: "a", created_at: new Date(), updated_at: new Date(),
  };
}

async function run(sections: unknown[], pool: Array<{ id: string; version: number; category_id: string | null; pack_id?: string }>, under: string[]) {
  const { withTenant } = await import("@assessiq/tenancy");
  const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
  const repo = await import("../repository.js");
  (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment(sections));
  (repo.listPoolWithCategory as ReturnType<typeof vi.fn>).mockResolvedValue(pool.map((q) => ({ pack_id: "p", ...q })));
  (repo.listQuestionIdsUnderNode as ReturnType<typeof vi.fn>).mockResolvedValue(new Set(under));
  (withTenant as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
  const { startAttempt } = await import("../service.js");
  await startAttempt(TENANT_A, { userId: "user-id", assessmentId: "assessment-id", embedOrigin: false });
  const rows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Array<{ questionId: string }>;
  return { ids: rows.map((r) => r.questionId), repo };
}

describe("Z-123 section draw by node", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a node_id section draws only questions under the node, including ones with no category_id", async () => {
    const pool = [
      { id: "imp1", version: 1, category_id: null }, // imported: taxonomy only
      { id: "eng1", version: 1, category_id: null }, // other subject
      { id: "cat1", version: 1, category_id: CAT }, // category question, not under the node
      { id: "imp2", version: 1, category_id: null },
    ];
    const { ids } = await run([{ name: "Quant", node_id: NODE, question_count: 2, minutes: 10 }], pool, ["imp1", "imp2"]);
    expect(ids.sort()).toEqual(["imp1", "imp2"]);
  });

  it("node_id wins over category_ids", async () => {
    const pool = [
      { id: "imp1", version: 1, category_id: null },
      { id: "cat1", version: 1, category_id: CAT },
    ];
    const { ids } = await run([{ name: "Q", node_id: NODE, category_ids: [CAT], question_count: 1, minutes: 10 }], pool, ["imp1"]);
    expect(ids).toEqual(["imp1"]);
  });

  it("a section without node_id still draws by category_ids and never queries the taxonomy", async () => {
    const pool = [
      { id: "cat1", version: 1, category_id: CAT },
      { id: "imp1", version: 1, category_id: null },
    ];
    const { ids, repo } = await run([{ name: "C", category_ids: [CAT], question_count: 1, minutes: 10 }], pool, ["imp1"]);
    expect(ids).toEqual(["cat1"]);
    expect(repo.listQuestionIdsUnderNode).not.toHaveBeenCalled();
  });

  it("a section with only question_count still draws from the whole pool", async () => {
    const pool = [{ id: "a", version: 1, category_id: null }, { id: "b", version: 1, category_id: CAT }];
    const { ids } = await run([{ name: "All", question_count: 2, minutes: 10 }], pool, []);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("fails with POOL_TOO_SMALL when the node holds too few questions", async () => {
    await expect(
      run([{ name: "Quant", node_id: NODE, question_count: 2, minutes: 10 }], [{ id: "x", version: 1, category_id: null }], ["x"]),
    ).rejects.toMatchObject({ details: { section: "Quant" } });
  });
});

const P2 = "11111111-1111-4111-8111-111111111111";

describe("EXP-23 section pack", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a two-pack assessment: each section draws only from its own pack; a section without pack_id uses the assessment pack", async () => {
    const pool = [
      { id: "a1", version: 1, category_id: null }, // assessment pack "p"
      { id: "a2", version: 1, category_id: null },
      { id: "b1", version: 1, category_id: null, pack_id: P2 },
      { id: "b2", version: 1, category_id: null, pack_id: P2 },
    ];
    const { ids } = await run(
      [
        { name: "Own", question_count: 2, minutes: 10 },
        { name: "Other", pack_id: P2, question_count: 2, minutes: 10 },
      ],
      pool,
      [],
    );
    expect(ids.slice(0, 2).sort()).toEqual(["a1", "a2"]);
    expect(ids.slice(2).sort()).toEqual(["b1", "b2"]);
  });

  it("a section pack with too few questions fails POOL_TOO_SMALL (other packs do not fill it)", async () => {
    const pool = [{ id: "a1", version: 1, category_id: null }, { id: "a2", version: 1, category_id: null }];
    await expect(run([{ name: "Other", pack_id: P2, question_count: 1, minutes: 10 }], pool, [])).rejects.toMatchObject({ details: { section: "Other" } });
  });
});
