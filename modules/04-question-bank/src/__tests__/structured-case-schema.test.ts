/** Content schema for the structured_case question type. Pure. */
import { describe, it, expect } from "vitest";
import { validateQuestionContent, rubricRequiredFor, QUESTION_TYPES } from "../types.js";

describe("structured_case content", () => {
  const ok = {
    title: "Suspicious logons",
    context: "Review the **auth log** below.",
    log_excerpt: "10:01 failed logon admin\n10:02 failed logon admin",
    steps: [
      { id: "s1", prompt: "Which lines are suspicious?", select: "many", options: ["a", "b", "c"], correct: [0, 1] },
      { id: "s2", prompt: "Next step?", select: "one", options: ["Block", "Ignore"], correct: [0] },
    ],
  };
  const valid = (patch: object) => validateQuestionContent("structured_case", { ...ok, ...patch }).ok;

  it("is a registered type and needs no rubric", () => {
    expect(QUESTION_TYPES).toContain("structured_case");
    expect(rubricRequiredFor("structured_case")).toBe(false);
  });

  it("accepts valid content with and without log, scoring and explanation", () => {
    expect(validateQuestionContent("structured_case", ok).ok).toBe(true);
    const { log_excerpt: _l, ...noLog } = ok;
    expect(validateQuestionContent("structured_case", noLog).ok).toBe(true);
    expect(valid({ scoring: "all_or_nothing", explanation: "why" })).toBe(true);
    expect(valid({ scoring: "partial" })).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    expect(valid({ steps: [ok.steps[0], { ...ok.steps[1], id: "s1" }] })).toBe(false);
  });

  it("rejects bad correct indexes", () => {
    const step = ok.steps[0]!;
    for (const correct of [[3], [0, 0], [-1], [0.5], []]) {
      expect(valid({ steps: [{ ...step, correct }] }), JSON.stringify(correct)).toBe(false);
    }
  });

  it("select 'one' needs exactly one correct index", () => {
    expect(valid({ steps: [{ ...ok.steps[1], correct: [0, 1] }] })).toBe(false);
  });

  it("rejects bad counts, blanks, scoring and unknown keys", () => {
    expect(valid({ steps: [] })).toBe(false);
    expect(valid({ steps: Array.from({ length: 13 }, (_, i) => ({ ...ok.steps[1], id: `s${i}` })) })).toBe(false);
    expect(valid({ steps: [{ ...ok.steps[1], options: ["only"], correct: [0] }] })).toBe(false);
    expect(valid({ steps: [{ ...ok.steps[1], options: Array.from({ length: 9 }, (_, i) => `o${i}`) }] })).toBe(false);
    expect(valid({ steps: [{ ...ok.steps[1], options: ["a", ""] }] })).toBe(false);
    expect(valid({ title: "" })).toBe(false);
    expect(valid({ context: "" })).toBe(false);
    expect(valid({ log_excerpt: "x".repeat(20001) })).toBe(false);
    expect(valid({ scoring: "half" })).toBe(false);
    expect(valid({ extra: 1 })).toBe(false);
    expect(valid({ steps: [{ ...ok.steps[1], extra: 1 }] })).toBe(false);
  });
});
