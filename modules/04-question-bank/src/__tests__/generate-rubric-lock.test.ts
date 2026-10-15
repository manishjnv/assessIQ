/**
 * RW-63: rubric / answer-guidance drafts take the global single-flight lease.
 * RW-88: the difficulty object handed to handleAdminGenerate carries `warn`.
 * Lock held -> 409 AIG_GRADING_IN_PROGRESS and the runtime is never called.
 * Lock free -> runtime called once (with the lease signal) and the lock released.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@assessiq/tenancy", () => ({
  withTenant: vi.fn(async (_t: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [{ label: "L1", topic: "t" }] }) }),
  ),
}));

vi.mock("../repository.js", async () => {
  const actual = await vi.importActual<typeof import("../repository.js")>("../repository.js");
  return {
    ...actual,
    findQuestionById: vi.fn(async () => ({
      id: "q1",
      type: "subjective",
      topic: "Topic",
      content: { question: "Explain lateral movement." },
      rubric: null,
      level_id: "lv1",
    })),
    findLevelById: vi.fn(async () => ({ id: "lv1", position: 1, rubric_defaults: null })),
  };
});

vi.mock("@assessiq/ai-grading", () => ({
  AI_GRADING_ERROR_CODES: { GRADING_IN_PROGRESS: "AIG_GRADING_IN_PROGRESS" },
  singleFlight: { acquire: vi.fn() },
  generateRubricDraft: vi.fn(),
  generateAnswerGuidanceDraft: vi.fn(),
  handleAdminGenerate: vi.fn(),
}));

import * as ai from "@assessiq/ai-grading";
import { generateRubricForQuestion, generateAnswerGuidanceForQuestion, generateQuestions } from "../service.js";
import { warnStructuralDifficulty } from "../difficulty-spec.js";

const acquire = vi.mocked(ai.singleFlight.acquire);
const rubric = vi.mocked(ai.generateRubricDraft);
const guidance = vi.mocked(ai.generateAnswerGuidanceDraft);

const rubricOut = { rubric: { x: 1 }, skillSha: "s", promptSha: "p", levelDefaultsHash: "h", model: "m" };
const guidanceOut = { answerGuidance: "g", skillSha: "s", promptSha: "p", model: "m" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RW-63 rubric / guidance drafts take the single-flight lock", () => {
  it.each([
    ["rubric", () => generateRubricForQuestion("t", "q1"), rubric],
    ["guidance", () => generateAnswerGuidanceForQuestion("t", "q1"), guidance],
  ] as const)("%s: lock held -> 409 and no runtime call", async (_n, call, runtime) => {
    acquire.mockResolvedValue({ kind: "rejected", reason: "other_attempt_in_flight" });
    await expect(call()).rejects.toMatchObject({ code: "AIG_GRADING_IN_PROGRESS", status: 409 });
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each([
    ["rubric", () => generateRubricForQuestion("t", "q1"), rubric, rubricOut],
    ["guidance", () => generateAnswerGuidanceForQuestion("t", "q1"), guidance, guidanceOut],
  ] as const)("%s: lock free -> runtime called once with the signal, lock released", async (_n, call, runtime, out) => {
    const release = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    acquire.mockResolvedValue({ kind: "acquired", release, signal });
    (runtime as ReturnType<typeof vi.fn>).mockResolvedValue(out);
    await call();
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime).mock.calls[0]![0]).toMatchObject({ signal });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the runtime throws", async () => {
    const release = vi.fn(async () => undefined);
    acquire.mockResolvedValue({ kind: "acquired", release, signal: new AbortController().signal });
    rubric.mockRejectedValue(new Error("boom"));
    await expect(generateRubricForQuestion("t", "q1")).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("RW-88 generateQuestions injects difficulty.warn", () => {
  it("warn is bound to the resolved level and equals warnStructuralDifficulty", async () => {
    vi.mocked(ai.handleAdminGenerate).mockResolvedValue({} as never);
    await generateQuestions("t", "u", "p", "lv", 1);
    const input = vi.mocked(ai.handleAdminGenerate).mock.calls[0]![0];
    const content = { question: "Q?", options: ["a"], correct_index: 0 };
    expect(input.difficulty?.warn).toBeTypeOf("function");
    expect(input.difficulty!.warn!("mcq", content)).toEqual(warnStructuralDifficulty("mcq", "L1", content));
  });
});
