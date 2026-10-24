import { describe, it, expect } from "vitest";
import { buildDrillSections } from "../service/drill.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("EXP-11 buildDrillSections", () => {
  it("splits the total over the topics, remainder to the first, and carries the difficulty range", () => {
    const s = buildDrillSections([A, B, C], 10, 2, 4);
    expect(s.map((x) => x.question_count)).toEqual([4, 3, 3]);
    expect(s.every((x) => x.difficulty_min === 2 && x.difficulty_max === 4)).toBe(true);
    expect(s.map((x) => x.node_id)).toEqual([A, B, C]);
  });
  it("drops duplicate topics and rejects a total below the topic count", () => {
    expect(buildDrillSections([A, A], 5)).toHaveLength(1);
    expect(() => buildDrillSections([A, B, C], 2)).toThrow();
    expect(() => buildDrillSections([], 5)).toThrow();
  });
});
