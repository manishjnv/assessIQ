/**
 * Draw evenness simulation: runs the real startAttempt draw many times over a synthetic pool shaped like the
 * bank (3 subjects, difficulty 1/3/5, 20 template keys of mixed size, keyless items). Checks that:
 *   (1) every item a section can reach is drawn at least once,
 *   (2) no item is used far more often than the average,
 *   (3) no test holds two items of one template key (EXP-24),
 *   (4) randomize=false draws the same items every time (the fault that randomize prevents).
 * Repo is mocked exactly as in template-cap-draw.test.ts. Math.random is real, so the thresholds keep wide margins.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

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
const SUBJECTS = [
  { id: "subject-a", count: 400 },
  { id: "subject-b", count: 300 },
  { id: "subject-c", count: 300 },
];
const DIFFICULTIES = [1, 3, 5];
const TEMPLATE_KEYS = 20;
const PER_TEST = 30;
const ATTEMPTS = 1500;
const FIXED_ATTEMPTS = 200;

const q = (id: string, template_key: string | null, difficulty_est: number, category_id: string) => ({
  id, version: 1, category_id, pack_id: "p", type: "mcq", difficulty_est, style_node_ids: [] as string[], template_key,
});

// 1000 items. Template keys 0..19 have size 1, 2 or 3 (39 keyed items, spread every 25th item).
// The other 961 items are keyless (null), as most of the real bank is.
function buildPool() {
  const keySlots: string[] = [];
  for (let k = 0; k < TEMPLATE_KEYS; k++) {
    for (let c = 0; c < 1 + (k % 3); c++) keySlots.push(`t.k${k}`);
  }
  const pool: ReturnType<typeof q>[] = [];
  let idx = 0;
  let slot = 0;
  for (const s of SUBJECTS) {
    for (let i = 0; i < s.count; i++, idx++) {
      const key = idx % 25 === 0 && slot < keySlots.length ? (keySlots[slot++] ?? null) : null;
      pool.push(q(`${s.id}-${i}`, key, DIFFICULTIES[idx % 3] ?? 1, s.id));
    }
  }
  return pool;
}

// Two sections, no node/category/type/difficulty filter, so both sections reach the whole pool.
const SECTIONS = [
  { name: "S1", question_count: 15, minutes: 5 },
  { name: "S2", question_count: 15, minutes: 5 },
];

function assessment(randomize: boolean) {
  return {
    id: "assessment-id", tenant_id: TENANT_A, pack_id: "p", level_id: "l", pack_version: 1, name: "T",
    description: null, status: "active", question_count: PER_TEST, randomize, opens_at: null, closes_at: null,
    settings: { sections: SECTIONS }, created_by: "a", created_at: new Date(), updated_at: new Date(),
  };
}

/** Runs the real startAttempt draw `attempts` times over `pool`. Returns the drawn question ids per test. */
async function drawMany(pool: ReturnType<typeof q>[], randomize: boolean, attempts: number): Promise<string[][]> {
  const { withTenant } = await import("@assessiq/tenancy");
  const alRepo = await import("../../../05-assessment-lifecycle/src/repository.js");
  const repo = await import("../repository.js");
  (alRepo.findAssessmentById as ReturnType<typeof vi.fn>).mockResolvedValue(assessment(randomize));
  (repo.countFrozenPool as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  (repo.listPoolWithCategory as ReturnType<typeof vi.fn>).mockResolvedValue(pool);
  (withTenant as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({}));
  const { startAttempt } = await import("../service.js");
  const draws: string[][] = [];
  for (let i = 0; i < attempts; i++) {
    (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mockClear();
    await startAttempt(TENANT_A, { userId: "user-id", assessmentId: "assessment-id", embedOrigin: false });
    const rows = (repo.insertAttemptQuestions as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as Array<{ questionId: string }>;
    draws.push(rows.map((r) => r.questionId));
  }
  return draws;
}

const POOL = buildPool();
const KEY_OF = new Map(POOL.map((p) => [p.id, p.template_key] as const));

describe("draw evenness, randomize=true (1,500 simulated tests)", () => {
  let draws: string[][] = [];
  const counts = new Map<string, number>();

  beforeAll(async () => {
    draws = await drawMany(POOL, true, ATTEMPTS);
    for (const d of draws) for (const id of d) counts.set(id, (counts.get(id) ?? 0) + 1);
  }, 20_000);

  it("draws every reachable item at least once (0 unused in scope)", () => {
    const unused = POOL.filter((p) => (counts.get(p.id) ?? 0) === 0).length;
    expect(draws.every((d) => d.length === PER_TEST)).toBe(true);
    expect(unused).toBe(0);
  });

  it("no item is over-used: max uses / mean uses < 2.5", () => {
    const total = draws.reduce((sum, d) => sum + d.length, 0);
    const mean = total / POOL.length;
    const max = Math.max(...counts.values());
    expect(max / mean).toBeLessThan(2.5);
  });

  it("no test contains two items of one template key (EXP-24)", () => {
    const badTests = draws.filter((d) => {
      const keys = d.map((id) => KEY_OF.get(id)).filter((k): k is string => k !== null && k !== undefined);
      return new Set(keys).size !== keys.length;
    });
    expect(badTests.length).toBe(0);
  });
});

describe("draw with randomize=false (the fault that randomize prevents)", () => {
  it("draws the SAME items in the SAME order every time", async () => {
    const draws = await drawMany(POOL, false, FIXED_ATTEMPTS);
    const first = draws[0] ?? [];
    expect(first.length).toBe(PER_TEST);
    expect(draws.every((d) => d.join("|") === first.join("|"))).toBe(true);
    // Only the first items in pool order ever reach a candidate; the rest of the bank is never drawn.
    expect(new Set(draws.flat()).size).toBe(PER_TEST);
  }, 20_000);
});
