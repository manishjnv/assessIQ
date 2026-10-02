/**
 * Pure unit tests for the numeric / multi_select deterministic scorers (no DB, no AI).
 */
import { describe, it, expect } from "vitest";
import {
  isNumericAnswerCorrect,
  multiSelectFraction,
  deterministicFraction,
  parseNumericAnswer,
} from "../mcq.js";

describe("numeric", () => {
  const exact = { question: "q", answer: 12.5 };
  const tol = { question: "q", answer: 100, tolerance: 0.5 };

  it("exact match (tolerance defaults to 0)", () => {
    expect(isNumericAnswerCorrect(exact, 12.5)).toBe(true);
    expect(isNumericAnswerCorrect(exact, 12.51)).toBe(false);
  });

  it("tolerance edges are inclusive, outside is wrong", () => {
    expect(isNumericAnswerCorrect(tol, 99.5)).toBe(true);
    expect(isNumericAnswerCorrect(tol, 100.5)).toBe(true);
    expect(isNumericAnswerCorrect(tol, 99.49)).toBe(false);
    expect(isNumericAnswerCorrect(tol, 100.51)).toBe(false);
  });

  it("float noise at the edge does not flip the result", () => {
    expect(isNumericAnswerCorrect({ answer: 0.3, tolerance: 0.1 }, 0.4)).toBe(true); // 0.4-0.3 = 0.10000000000000003
  });

  it("zero and negative answers", () => {
    expect(isNumericAnswerCorrect({ answer: 0 }, 0)).toBe(true);
    expect(isNumericAnswerCorrect({ answer: -3 }, -3)).toBe(true);
    expect(isNumericAnswerCorrect({ answer: -3 }, 3)).toBe(false);
  });

  it("accepts stored number, {value}, and numeric strings with commas", () => {
    expect(isNumericAnswerCorrect({ answer: 1250 }, "1,250")).toBe(true);
    expect(isNumericAnswerCorrect({ answer: 1250 }, { value: 1250 })).toBe(true);
    expect(isNumericAnswerCorrect(exact, " 12.5 ")).toBe(true);
  });

  it("malformed / unanswered / non-finite is wrong, never throws", () => {
    for (const bad of [null, undefined, "", "abc", "12abc", NaN, Infinity, [], [12.5], {}, true]) {
      expect(isNumericAnswerCorrect(exact, bad)).toBe(false);
    }
    expect(isNumericAnswerCorrect(null, 1)).toBe(false);
    expect(isNumericAnswerCorrect({ answer: "x" }, 1)).toBe(false);
    expect(parseNumericAnswer("1e3")).toBe(1000);
  });
});

describe("multi_select", () => {
  const base = { question: "q", options: ["a", "b", "c", "d", "e"], correct: [0, 2] };
  const partial = { ...base, scoring: "partial" as const };

  it("all_or_nothing: exact set only (order and answer shape do not matter)", () => {
    expect(multiSelectFraction(base, { selected: [0, 2] })).toBe(1);
    expect(multiSelectFraction(base, { selected: [2, 0] })).toBe(1);
    expect(multiSelectFraction(base, [0, 2])).toBe(1);
    expect(multiSelectFraction(base, { selected: [0] })).toBe(0); // missing one
    expect(multiSelectFraction(base, { selected: [0, 2, 3] })).toBe(0); // extra wrong
    expect(multiSelectFraction(base, { selected: [] })).toBe(0);
  });

  it("partial: (right - wrong) / |correct|, floored at 0", () => {
    expect(multiSelectFraction(partial, { selected: [0, 2] })).toBe(1);
    expect(multiSelectFraction(partial, { selected: [0] })).toBe(0.5);
    expect(multiSelectFraction(partial, { selected: [0, 2, 3] })).toBe(0.5); // 2 right - 1 wrong
    expect(multiSelectFraction(partial, { selected: [0, 3] })).toBe(0); // 1 - 1
    expect(multiSelectFraction(partial, { selected: [3, 4] })).toBe(0); // -2 floors at 0
    expect(multiSelectFraction(partial, { selected: [] })).toBe(0);
  });

  it("malformed answers score 0", () => {
    for (const bad of [null, undefined, 0, "0", { selected: 0 }, { selected: [0, 0] }, { selected: [9] }, { selected: [-1] }, { selected: [0.5] }, { selected: ["0"] }]) {
      expect(multiSelectFraction(partial, bad)).toBe(0);
      expect(multiSelectFraction(base, bad)).toBe(0);
    }
  });

  it("malformed key scores 0", () => {
    expect(multiSelectFraction({ options: ["a", "b"], correct: [] }, [0])).toBe(0);
    expect(multiSelectFraction({ options: ["a", "b"], correct: [5] }, [5])).toBe(0);
    expect(multiSelectFraction(null, [0])).toBe(0);
  });
});

describe("deterministicFraction dispatch", () => {
  it("routes by type", () => {
    expect(deterministicFraction("mcq", { options: ["a", "b"], correct: 1 }, { selected: 1 })).toBe(1);
    expect(deterministicFraction("numeric", { answer: 2 }, 2)).toBe(1);
    expect(deterministicFraction("multi_select", { options: ["a", "b"], correct: [1], scoring: "partial" }, [1])).toBe(1);
  });
});
