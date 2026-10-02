/**
 * numeric / multi_select: candidate view strips the answer key, and the per-student
 * option shuffle maps multi_select answers display <-> original. Pure, no DB.
 */
import { describe, it, expect } from "vitest";
import { sanitizeContentForCandidate } from "../repository.js";
import { answerToOriginal, answerToDisplayed, buildOptionOrder, displayQuestions } from "../option-shuffle.js";
import { answerGuidanceFor } from "../answer-guidance.js";
import type { FrozenQuestion } from "../types.js";

describe("candidate view strips the answer key", () => {
  it("numeric: only question + unit; never answer / tolerance / rationale", () => {
    const out = sanitizeContentForCandidate("numeric", {
      question: "Speed?",
      answer: 42,
      tolerance: 0.5,
      unit: "km/h",
      rationale: "because",
    });
    expect(out).toEqual({ question: "Speed?", unit: "km/h" });
  });

  it("multi_select: only question + options; never correct / scoring / rationale", () => {
    const out = sanitizeContentForCandidate("multi_select", {
      question: "Pick primes",
      options: ["2", "3", "4"],
      correct: [0, 1],
      scoring: "partial",
      rationale: "x",
    });
    expect(out).toEqual({ question: "Pick primes", options: ["2", "3", "4"] });
    expect(JSON.stringify(out)).not.toContain("correct");
  });
});

describe("multi_select option shuffle", () => {
  const order = [2, 0, 3, 1]; // order[displayPos] = originalIdx

  it("display -> original and back is the identity", () => {
    const sent = { selected: [0, 3] }; // displayed positions 0 and 3
    const stored = answerToOriginal(sent, order) as { selected: number[] };
    expect(stored.selected).toEqual([2, 1]); // order[0]=2, order[3]=1
    expect(answerToDisplayed(stored, order)).toEqual({ selected: [0, 3] });
  });

  it("bare array is accepted and stored canonically", () => {
    expect(answerToOriginal([1], order)).toEqual({ selected: [0] });
  });

  it("one invalid element leaves the whole answer untouched (fail-safe)", () => {
    expect(answerToOriginal({ selected: [0, 9] }, order)).toEqual({ selected: [0, 9] });
    expect(answerToOriginal({ selected: [0, 1.5] }, order)).toEqual({ selected: [0, 1.5] });
  });

  it("empty selection stays empty", () => {
    expect(answerToOriginal({ selected: [] }, order)).toEqual({ selected: [] });
  });

  it("buildOptionOrder shuffles up to 10 options; displayQuestions reorders multi_select options", () => {
    const options = Array.from({ length: 10 }, (_, i) => `opt ${i + 1}`);
    const o = buildOptionOrder(options, () => 0.3, 10);
    expect(o).not.toBeNull();
    expect([...(o as number[])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const q = {
      question_id: "q1",
      type: "multi_select",
      content: { question: "x", options },
    } as unknown as FrozenQuestion;
    const shown = displayQuestions([q], new Map([["q1", o as number[]]]))[0]!;
    expect((shown.content as { options: string[] }).options).toEqual((o as number[]).map((i) => options[i]));
  });
});

describe("answer guidance defaults", () => {
  it("has a hint for each new type", () => {
    expect(answerGuidanceFor("multi_select", null)).toBe("Select all that apply.");
    expect(answerGuidanceFor("numeric", null)).toBe("Enter a number.");
  });
});
