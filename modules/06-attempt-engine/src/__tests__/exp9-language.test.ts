/** EXP-9 A1/A2: Hindi overlay (MCQ). Fake fixtures only (HI-*): no real Hindi wording. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McqContentSchema, QUESTION_TYPE_REGISTRY } from "@assessiq/question-types";
import { displayQuestions, answerToOriginal } from "../option-shuffle.js";
import type { FrozenQuestion } from "../types.js";

const h = vi.hoisted(() => ({ findForUpdate: vi.fn(), setLang: vi.fn(), audit: vi.fn(), withTenant: vi.fn() }));
vi.mock("@assessiq/tenancy", async (orig) => ({ ...(await orig<object>()), withTenant: h.withTenant }));
vi.mock("@assessiq/audit-log", async (orig) => ({ ...(await orig<object>()), auditInTx: h.audit }));
vi.mock("../repository.js", async (orig) => ({
  ...(await orig<object>()),
  findAttemptByIdForUpdate: h.findForUpdate,
  setAttemptLanguage: h.setLang,
}));
import { setAttemptLanguage } from "../service.js";

const base = {
  question: "Q", options: ["A1", "B1", "C1", "D1"], correct: 2, rationale: "R",
  i18n: { hi: { question: "HI-Q", options: ["HI-OPT-1", "HI-OPT-2", "HI-OPT-3", "HI-OPT-4"], rationale: "HI-RAT" } },
};
const fq = (content: unknown): FrozenQuestion =>
  ({ question_id: "q1", position: 1, question_version: 1, type: "mcq", topic: "t", points: 1, answer_guidance: "", content }) as unknown as FrozenQuestion;

describe("schema", () => {
  it("accepts a matching overlay and no overlay", () => {
    expect(McqContentSchema.safeParse(base).success).toBe(true);
    const { i18n: _i, ...plain } = base;
    expect(McqContentSchema.safeParse(plain).success).toBe(true);
  });
  it("rejects option count mismatch and empty strings", () => {
    const bad = { ...base, i18n: { hi: { question: "HI-Q", options: ["HI-OPT-1", "HI-OPT-2"] } } };
    expect(McqContentSchema.safeParse(bad).success).toBe(false);
    const empty = { ...base, i18n: { hi: { question: "HI-Q", options: ["a", "b", "c", ""] } } };
    expect(McqContentSchema.safeParse(empty).success).toBe(false);
  });
});

describe("shuffle", () => {
  const order = [2, 0, 3, 1];
  it("Hindi options follow the same permutation as English", () => {
    const c = displayQuestions([fq(base)], new Map([["q1", order]]))[0]!.content as typeof base;
    expect(c.options).toEqual(["C1", "A1", "D1", "B1"]);
    expect(c.i18n.hi.options).toEqual(["HI-OPT-3", "HI-OPT-1", "HI-OPT-4", "HI-OPT-2"]);
  });
  it("length mismatch drops the overlay (English fallback)", () => {
    const bad = { ...base, i18n: { hi: { question: "HI-Q", options: ["x", "y"] } } };
    const c = displayQuestions([fq(bad)], new Map([["q1", order]]))[0]!.content as Record<string, unknown>;
    expect(c["i18n"]).toBeUndefined();
  });
  it("saved answer maps display to original index and scores the same in hi and en", () => {
    // display position 0 = original 2 (the correct one), whichever language is shown
    const saved = answerToOriginal({ selected: 0 }, order);
    expect(saved).toEqual({ selected: 2 });
    expect(QUESTION_TYPE_REGISTRY.mcq.deterministicScore?.(base, saved)).toBe(1);
  });
});

describe("candidate view", () => {
  it("keeps Hindi question and options, never the Hindi rationale", () => {
    const v = JSON.stringify(QUESTION_TYPE_REGISTRY.mcq.candidateView(base));
    expect(v).toContain("HI-OPT-1");
    expect(v).not.toContain("HI-RAT");
    expect(v).not.toContain('"rationale"');
  });
});

describe("setAttemptLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withTenant.mockImplementation(async (_t: string, fn: (c: unknown) => unknown) => fn({}));
  });
  const att = (o: object) => ({ id: "a1", user_id: "u1", status: "in_progress", language: "en", ...o });

  it("writes and audits once when the value changes; no audit when unchanged", async () => {
    h.findForUpdate.mockResolvedValue(att({}));
    await setAttemptLanguage("t1", "u1", "a1", "hi");
    expect(h.setLang).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(((h.audit.mock.calls[0] as unknown[])[1] as { action: string }).action).toBe("attempt.language.set");
    h.findForUpdate.mockResolvedValue(att({ language: "hi" }));
    await setAttemptLanguage("t1", "u1", "a1", "hi");
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
  it("other tenant (row invisible under RLS) and other user are refused", async () => {
    h.findForUpdate.mockResolvedValue(null);
    await expect(setAttemptLanguage("t2", "u1", "a1", "hi")).rejects.toThrow(/not found/i);
    h.findForUpdate.mockResolvedValue(att({ user_id: "someone-else" }));
    await expect(setAttemptLanguage("t1", "u1", "a1", "hi")).rejects.toThrow();
    expect(h.setLang).not.toHaveBeenCalled();
  });
  it("refuses a submitted attempt", async () => {
    h.findForUpdate.mockResolvedValue(att({ status: "submitted" }));
    await expect(setAttemptLanguage("t1", "u1", "a1", "hi")).rejects.toThrow(/not writable/);
    expect(h.setLang).not.toHaveBeenCalled();
  });
});
