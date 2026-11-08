/**
 * EXP-24: at most one item per template in one test (all sections). Live and frozen pools both feed
 * listPoolWithCategory with template_key, so the draw rule is the same code; repo is mocked (SQL: template-key-sql.test.ts).
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

function assessment(sections: unknown[]) {
  return {
    id: "assessment-id", tenant_id: TENANT_A, pack_id: "p", level_id: "l", pack_version: 1, name: "T",
    description: null, status: "active", question_count: 4, randomize: false, opens_at: null, closes_at: null,
    settings: { sections }, created_by: "a", created_at: new Date(), updated_at: new Date(),
  };
}

const q = (id: string, template_key: string | null) => ({ id, version: 1, category_id: null, pack_id: "p", type: "mcq", difficulty_est: null, style_node_ids: [] as string[], template_key });

async function run(pool: ReturnType<typeof q>[], sections: unknown[], frozen: boolean) {
  const { withTenant } = await import("@assessiq/tenancy");
  const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
  const repo = await import("../repository.js");
  (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment(sections));
  (repo.countFrozenPool as ReturnType<typeof vi.fn>).mockResolvedValue(frozen ? pool.length : 0);
  (repo.listPoolWithCategory as ReturnType<typeof vi.fn>).mockResolvedValue(pool);
  (withTenant as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
  const { startAttempt } = await import("../service.js");
  await startAttempt(TENANT_A, { userId: "user-id", assessmentId: "assessment-id", embedOrigin: false });
  const rows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Array<{ questionId: string }>;
  return rows.map((r) => r.questionId);
}

describe.each([["live pool", false], ["frozen pool", true]])("EXP-24 one item per template, %s", (_n, frozen) => {
  beforeEach(() => vi.clearAllMocks());

  it("two items of one template never land in one test (across sections)", async () => {
    const pool = [q("a1", "t.add"), q("a2", "t.add"), q("b1", "t.sub"), q("c1", "t.mul")];
    const ids = await run(pool, [{ name: "S1", question_count: 2, minutes: 5 }, { name: "S2", question_count: 1, minutes: 5 }], frozen);
    expect(ids).toEqual(["a1", "b1", "c1"]);
  });

  it("keyless items are not limited", async () => {
    const pool = [q("h1", null), q("h2", null), q("h3", null), q("a1", "t.add")];
    expect((await run(pool, [{ name: "S", question_count: 4, minutes: 5 }], frozen)).sort()).toEqual(["a1", "h1", "h2", "h3"]);
  });

  it("v1 and v2 of one template share a key and count as one", async () => {
    // the key is the part before '@', so both rows carry 't.add'
    const pool = [q("a1", "t.add"), q("a2", "t.add"), q("b1", "t.sub")];
    await expect(run(pool, [{ name: "S", question_count: 3, minutes: 5 }], frozen)).rejects.toMatchObject({ details: { available: 2, required: 3 } });
  });

  it("only one template for 5 slots fails with the too-small error, no silent repeat", async () => {
    const pool = ["a1", "a2", "a3", "a4", "a5"].map((id) => q(id, "t.add"));
    await expect(run(pool, [{ name: "S", question_count: 5, minutes: 5 }], frozen)).rejects.toMatchObject({ details: { code: "AE_POOL_TOO_SMALL", section: "S", available: 1, required: 5 } });
  });

  it("is deterministic: same pool, same pick", async () => {
    const pool = [q("a1", "t.add"), q("a2", "t.add"), q("b1", "t.sub"), q("b2", "t.sub")];
    const s = [{ name: "S", question_count: 2, minutes: 5 }];
    const first = await run(pool, s, frozen);
    vi.clearAllMocks();
    expect(await run(pool, s, frozen)).toEqual(first);
  });
});
