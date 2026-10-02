/** Pure unit tests for the structured_case scorer (no DB, no AI). */
import { describe, it, expect } from "vitest";
import { structuredCaseFraction, deterministicFraction, DETERMINISTIC_TYPES } from "../mcq.js";

const steps = [
  { id: "s1", prompt: "p", select: "many", options: ["a", "b", "c", "d"], correct: [0, 1] },
  { id: "s2", prompt: "p", select: "one", options: ["x", "y"], correct: [1] },
];
const partial = { title: "t", context: "c", steps }; // default scoring is partial
const aon = { ...partial, scoring: "all_or_nothing" };
const allRight = { steps: { s1: [1, 0], s2: [1] } };

describe("structuredCaseFraction", () => {
  it("is a deterministic type", () => {
    expect(DETERMINISTIC_TYPES).toContain("structured_case");
    expect(deterministicFraction("structured_case", partial, allRight)).toBe(1);
  });

  it("all correct scores 1 in both modes", () => {
    expect(structuredCaseFraction(partial, allRight)).toBe(1);
    expect(structuredCaseFraction(aon, allRight)).toBe(1);
  });

  it("one wrong 'one' step: partial is the mean, all_or_nothing is 0", () => {
    const a = { steps: { s1: [0, 1], s2: [0] } };
    expect(structuredCaseFraction(partial, a)).toBe(0.5);
    expect(structuredCaseFraction(aon, a)).toBe(0);
  });

  it("'many' step gives partial credit inside the step only in partial mode", () => {
    const a = { steps: { s1: [0], s2: [1] } }; // s1: (1-0)/2 = 0.5, s2: 1
    expect(structuredCaseFraction(partial, a)).toBe(0.75);
    expect(structuredCaseFraction(aon, a)).toBe(0);
    // an extra wrong pick is penalised: s1 right=2 wrong=1 -> 0.5
    expect(structuredCaseFraction(partial, { steps: { s1: [0, 1, 2], s2: [1] } })).toBe(0.75);
  });

  it("a missing step scores 0 for that step", () => {
    expect(structuredCaseFraction(partial, { steps: { s2: [1] } })).toBe(0.5);
    expect(structuredCaseFraction(aon, { steps: { s2: [1] } })).toBe(0);
  });

  it("'one' step needs exactly one pick", () => {
    expect(structuredCaseFraction(partial, { steps: { s1: [0, 1], s2: [1, 0] } })).toBe(0.5);
    expect(structuredCaseFraction(partial, { steps: { s1: [0, 1], s2: [] } })).toBe(0.5);
  });

  it("malformed answers score 0 or 0 for the bad step", () => {
    for (const a of [null, undefined, "x", 3, [], {}, { steps: null }, { steps: [] }, { steps: "x" }]) {
      expect(structuredCaseFraction(partial, a), JSON.stringify(a)).toBe(0);
    }
    expect(structuredCaseFraction(partial, { steps: { s1: "a", s2: "b" } })).toBe(0);
    expect(structuredCaseFraction(partial, { steps: { s1: [9], s2: [9] } })).toBe(0);
    expect(structuredCaseFraction(partial, { steps: { s1: [0, 0], s2: [1] } })).toBe(0.5); // duplicate pick -> that step 0
  });

  it("an unknown step id makes the whole answer malformed (0)", () => {
    expect(structuredCaseFraction(partial, { steps: { ...allRight.steps, ghost: [0] } })).toBe(0);
  });

  it("malformed content scores 0", () => {
    expect(structuredCaseFraction(null, allRight)).toBe(0);
    expect(structuredCaseFraction({ steps: [] }, allRight)).toBe(0);
    expect(structuredCaseFraction({ title: "t" }, allRight)).toBe(0);
  });
});
