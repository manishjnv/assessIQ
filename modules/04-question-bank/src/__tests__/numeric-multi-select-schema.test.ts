/** Content schemas for the numeric / multi_select question types. Pure. */
import { describe, it, expect } from "vitest";
import { validateQuestionContent, rubricRequiredFor } from "../types.js";

describe("numeric content", () => {
  it("accepts the minimal and the full shape", () => {
    expect(validateQuestionContent("numeric", { question: "q", answer: 3 }).ok).toBe(true);
    expect(validateQuestionContent("numeric", { question: "q", answer: -1.5, tolerance: 0.1, unit: "m" }).ok).toBe(true);
  });
  it("rejects negative tolerance, non-numeric answer, unknown keys", () => {
    expect(validateQuestionContent("numeric", { question: "q", answer: 3, tolerance: -1 }).ok).toBe(false);
    expect(validateQuestionContent("numeric", { question: "q", answer: "3" }).ok).toBe(false);
    expect(validateQuestionContent("numeric", { question: "q", answer: 3, extra: 1 }).ok).toBe(false);
  });
  it("needs no rubric", () => {
    expect(rubricRequiredFor("numeric")).toBe(false);
    expect(rubricRequiredFor("multi_select")).toBe(false);
  });
});

describe("multi_select content", () => {
  const ok = { question: "q", options: ["a", "b", "c"], correct: [0, 2] };
  it("accepts valid, incl. scoring", () => {
    expect(validateQuestionContent("multi_select", ok).ok).toBe(true);
    expect(validateQuestionContent("multi_select", { ...ok, scoring: "partial" }).ok).toBe(true);
  });
  it("rejects empty / duplicate / out-of-range correct, bad option counts, bad scoring", () => {
    expect(validateQuestionContent("multi_select", { ...ok, correct: [] }).ok).toBe(false);
    expect(validateQuestionContent("multi_select", { ...ok, correct: [1, 1] }).ok).toBe(false);
    expect(validateQuestionContent("multi_select", { ...ok, correct: [3] }).ok).toBe(false);
    expect(validateQuestionContent("multi_select", { ...ok, options: ["a"] , correct: [0] }).ok).toBe(false);
    expect(validateQuestionContent("multi_select", { ...ok, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }).ok).toBe(false);
    expect(validateQuestionContent("multi_select", { ...ok, scoring: "half" }).ok).toBe(false);
  });
});
