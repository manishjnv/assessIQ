/** Content schema for the ordering question type. Pure. */
import { describe, it, expect } from "vitest";
import { validateQuestionContent, rubricRequiredFor, QUESTION_TYPES } from "../types.js";

describe("ordering content", () => {
  const ok = { question: "Order the steps", items: ["a", "b", "c"], correct_order: [0, 1, 2] };

  it("is a registered type and needs no rubric", () => {
    expect(QUESTION_TYPES).toContain("ordering");
    expect(rubricRequiredFor("ordering")).toBe(false);
  });

  it("accepts valid content, incl. scoring and explanation", () => {
    expect(validateQuestionContent("ordering", ok).ok).toBe(true);
    expect(validateQuestionContent("ordering", { ...ok, correct_order: [2, 0, 1], scoring: "partial", explanation: "why" }).ok).toBe(true);
    expect(validateQuestionContent("ordering", { ...ok, scoring: "all_or_nothing" }).ok).toBe(true);
  });

  it("rejects a correct_order that is not a permutation of 0..n-1", () => {
    for (const co of [[0, 1], [0, 1, 2, 3], [0, 1, 1], [0, 1, 3], [-1, 0, 1], [0, 1, 1.5], []]) {
      expect(validateQuestionContent("ordering", { ...ok, correct_order: co }).ok, JSON.stringify(co)).toBe(false);
    }
  });

  it("rejects bad item counts, blank items, bad scoring and unknown keys", () => {
    expect(validateQuestionContent("ordering", { ...ok, items: ["a"], correct_order: [0] }).ok).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `i${i}`);
    expect(validateQuestionContent("ordering", { ...ok, items: eleven, correct_order: eleven.map((_, i) => i) }).ok).toBe(false);
    expect(validateQuestionContent("ordering", { ...ok, items: ["a", "", "c"] }).ok).toBe(false);
    expect(validateQuestionContent("ordering", { ...ok, scoring: "half" }).ok).toBe(false);
    expect(validateQuestionContent("ordering", { ...ok, extra: 1 }).ok).toBe(false);
    expect(validateQuestionContent("ordering", { items: ok.items, correct_order: ok.correct_order }).ok).toBe(false);
  });
});
