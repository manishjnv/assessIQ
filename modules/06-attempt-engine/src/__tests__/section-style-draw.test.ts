/**
 * EXAM-STYLE: a styled section takes items of its own style or no style, never another style; an unstyled
 * section takes only items with no style. Same rule for the live pool and the frozen pool (both feed
 * listPoolWithCategory with style_node_ids). No database: repo is mocked, so the SQL is not exercised here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@assessiq/tenancy", () => ({ withTenant: vi.fn() }));

vi.mock("@assessiq/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assessiq/core")>();
  return { ...actual, uuidv7: vi.fn().mockReturnValue("attempt-uuid-0000-0000-0000-000000000001") };
});

vi.mock("@assessiq/assessment-lifecycle", () => ({ assertPoolVerifiedForInvites: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../05-assessment-lifecycle/src/repository.js", () => ({ findAssessmentById: vi.fn() }));
vi.mock("../../../04-question-bank/src/repository.js", () => ({
  findLevelById: vi.fn().mockResolvedValue({ id: "level-id", pack_id: "pack-id", duration_minutes: 60 }),
}));

vi.mock("../repository.js", () => ({
  findAttemptByAssessmentAndUser: vi.fn().mockResolvedValue(null),
  hasConsentEvent: vi.fn().mockResolvedValue(true),
  countFrozenPool: vi.fn().mockResolvedValue(0),
  listFrozenPoolForPick: vi.fn(),
  listFrozenPoolForCriterion: vi.fn(),
  listActiveQuestionPoolForPick: vi.fn(),
  listActiveQuestionPoolForCriterion: vi.fn(),
  listPoolWithCategory: vi.fn(),
  listQuestionIdsUnderNode: vi.fn(),
  findInvitationForCandidate: vi.fn().mockResolvedValue({ id: "invitation-id", status: "pending", expires_at: new Date(Date.now() + 86_400_000) }),
  insertAttempt: vi.fn().mockResolvedValue({
    id: "attempt-uuid-0000-0000-0000-000000000001", tenant_id: "tenant-a", assessment_id: "assessment-id", user_id: "user-id",
    status: "in_progress", started_at: new Date(), ends_at: new Date(Date.now() + 3_600_000), submitted_at: null,
    duration_seconds: 3600, created_at: new Date(), embed_origin: false,
  }),
  insertAttemptQuestions: vi.fn().mockResolvedValue(undefined),
  listMcqOptionsForPicks: vi.fn().mockResolvedValue(new Map()),
  listOrderingKeysForPicks: vi.fn().mockResolvedValue(new Map()),
  listPassageInfo: vi.fn().mockResolvedValue(new Map()),
  insertEmptyAttemptAnswers: vi.fn().mockResolvedValue(undefined),
  markInvitationStarted: vi.fn().mockResolvedValue(undefined),
  insertAttemptEvent: vi.fn().mockResolvedValue(undefined),
  updateAttemptStatus: vi.fn(),
  markInvitationSubmitted: vi.fn(),
}));

const TENANT_A = "tenant-a-uuid-0000-0000-000000000001";
const SSC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BANK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function assessment(sections: unknown[]) {
  return {
    id: "assessment-id", tenant_id: TENANT_A, pack_id: "p", level_id: "l", pack_version: 1, name: "T",
    description: null, status: "active", question_count: 4, randomize: false, opens_at: null, closes_at: null,
    settings: { sections }, created_by: "a", created_at: new Date(), updated_at: new Date(),
  };
}

const POOL = [
  { id: "neutral1", version: 1, category_id: null, style_node_ids: [] as string[] },
  { id: "neutral2", version: 1, category_id: null, style_node_ids: [] as string[] },
  { id: "ssc1", version: 1, category_id: null, style_node_ids: [SSC] },
  { id: "bank1", version: 1, category_id: null, style_node_ids: [BANK] },
];

async function run(sections: unknown[], frozen: boolean) {
  const { withTenant } = await import("@assessiq/tenancy");
  const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
  const repo = await import("../repository.js");
  (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment(sections));
  (repo.countFrozenPool as ReturnType<typeof vi.fn>).mockResolvedValue(frozen ? 4 : 0);
  (repo.listPoolWithCategory as ReturnType<typeof vi.fn>).mockResolvedValue(POOL.map((q) => ({ pack_id: "p", type: "mcq", difficulty_est: null, ...q })));
  (withTenant as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
  const { startAttempt } = await import("../service.js");
  await startAttempt(TENANT_A, { userId: "user-id", assessmentId: "assessment-id", embedOrigin: false });
  expect((repo.listPoolWithCategory as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ useFrozen: frozen });
  const rows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Array<{ questionId: string }>;
  return rows.map((r) => r.questionId).sort();
}

describe.each([["live pool", false], ["frozen pool", true]])("EXAM-STYLE section draw, %s", (_n, frozen) => {
  beforeEach(() => vi.clearAllMocks());

  it("a styled section gets neutral and its own style, never another style", async () => {
    const ids = await run([{ name: "S", style_node_id: SSC, question_count: 3, minutes: 10 }], frozen);
    expect(ids).toEqual(["neutral1", "neutral2", "ssc1"]);
  });

  it("a styled section that would need another style's item fails POOL_TOO_SMALL", async () => {
    await expect(run([{ name: "S", style_node_id: SSC, question_count: 4, minutes: 10 }], frozen)).rejects.toMatchObject({ details: { section: "S", available: 3, required: 4 } });
  });

  it("an unstyled section gets neutral only", async () => {
    const ids = await run([{ name: "U", question_count: 2, minutes: 10 }], frozen);
    expect(ids).toEqual(["neutral1", "neutral2"]);
    await expect(run([{ name: "U", question_count: 3, minutes: 10 }], frozen)).rejects.toMatchObject({ details: { available: 2, required: 3 } });
  });
});
