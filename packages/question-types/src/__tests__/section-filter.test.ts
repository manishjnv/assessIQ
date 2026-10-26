import { describe, it, expect } from "vitest";
import { passesSectionTypeAndDifficulty as pass } from "../section-filter.js";

describe("CT-0 passesSectionTypeAndDifficulty", () => {
  it("no filter passes everything, including a question with no difficulty", () => {
    expect(pass({}, { type: "mcq", difficulty_est: null })).toBe(true);
  });
  it("allowed_types keeps only the listed types", () => {
    expect(pass({ allowed_types: ["mcq"] }, { type: "mcq", difficulty_est: 1 })).toBe(true);
    expect(pass({ allowed_types: ["mcq"] }, { type: "subjective", difficulty_est: 1 })).toBe(false);
  });
  it("a difficulty range is inclusive and rejects an unrated question", () => {
    const s = { difficulty_min: 2, difficulty_max: 4 };
    expect([1, 2, 4, 5].map((d) => pass(s, { type: "mcq", difficulty_est: d }))).toEqual([false, true, true, false]);
    expect(pass(s, { type: "mcq", difficulty_est: null })).toBe(false);
  });
});
