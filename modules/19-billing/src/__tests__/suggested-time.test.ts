import { describe, it, expect } from "vitest";
import { minutesForQuestion, averageMinutesPerQuestion } from "../suggested-time.js";

describe("minutesForQuestion", () => {
  it("objective types split by difficulty", () => {
    for (const t of ["mcq", "multi_select", "numeric", "ordering"]) {
      expect(minutesForQuestion(t, 1)).toBe(0.75);
      expect(minutesForQuestion(t, 2)).toBe(0.75);
      expect(minutesForQuestion(t, 3)).toBe(1.25);
      expect(minutesForQuestion(t, 4)).toBe(1.75);
      expect(minutesForQuestion(t, 5)).toBe(1.75);
      expect(minutesForQuestion(t, null)).toBe(1.25);
    }
  });
  it("flat types ignore difficulty", () => {
    const flat: Record<string, number> = { subjective: 5, kql: 6, log_analysis: 6, scenario: 10, structured_case: 10 };
    for (const [t, m] of Object.entries(flat)) {
      for (const d of [1, 3, 5, null]) expect(minutesForQuestion(t, d)).toBe(m);
    }
  });
  it("unknown type uses the medium mcq value", () => {
    expect(minutesForQuestion("nope", 1)).toBe(1.25);
    expect(minutesForQuestion("nope", null)).toBe(1.25);
  });
});

describe("averageMinutesPerQuestion", () => {
  it("is 0 for an empty set", () => expect(averageMinutesPerQuestion([])).toBe(0));
  it("averages a mixed set to 2 decimals", () => {
    expect(averageMinutesPerQuestion([
      { type: "mcq", difficulty_est: 1 },      // 0.75
      { type: "subjective", difficulty_est: null }, // 5
      { type: "scenario", difficulty_est: 3 }, // 10
    ])).toBe(5.25);
    expect(averageMinutesPerQuestion([
      { type: "mcq", difficulty_est: 1 }, { type: "mcq", difficulty_est: 3 }, { type: "mcq", difficulty_est: 5 },
    ])).toBe(1.25);
    expect(averageMinutesPerQuestion([
      { type: "mcq", difficulty_est: 1 }, { type: "mcq", difficulty_est: 1 }, { type: "kql", difficulty_est: 1 },
    ])).toBe(2.5);
  });
});
