import { describe, it, expect } from "vitest";
import { isMcqAnswerCorrect } from "../mcq.js";

const content = { question: "q", options: ["a", "b", "c", "d"], correct: 2, rationale: "r" };

describe("isMcqAnswerCorrect", () => {
  it("correct selected index", () => expect(isMcqAnswerCorrect(content, { selected: 2 })).toBe(true));
  it("bare integer answer", () => expect(isMcqAnswerCorrect(content, 2)).toBe(true));
  it("wrong index", () => expect(isMcqAnswerCorrect(content, { selected: 1 })).toBe(false));
  it("unanswered (null / undefined)", () => {
    expect(isMcqAnswerCorrect(content, null)).toBe(false);
    expect(isMcqAnswerCorrect(content, undefined)).toBe(false);
  });
  it("malformed payloads are incorrect and never throw", () => {
    const bad = ["2", [2], [], {}, { selected: "2" }, { selected: 2.5 }, { selected: -1 }, { selected: 99 }, true, NaN];
    for (const b of bad) expect(isMcqAnswerCorrect(content, b)).toBe(false);
  });
  it("malformed answer key is incorrect, never throws", () => {
    const bad = [null, "x", [], {}, { correct: "2", options: ["a", "b"] }, { correct: 5, options: ["a", "b"] }, { correct: -1 }];
    for (const b of bad) expect(isMcqAnswerCorrect(b, { selected: 2 })).toBe(false);
  });
});
