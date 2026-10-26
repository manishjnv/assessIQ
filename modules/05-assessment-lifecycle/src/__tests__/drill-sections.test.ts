import { describe, it, expect } from "vitest";
import { buildDrillSections, buildTopicSections } from "../service/drill.js";

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

describe("CT-0 buildTopicSections", () => {
  const names = new Map([[A, "Percentages"], [B, "Number series"]]);
  it("uneven counts, real topic names, and a name fallback", () => {
    const s = buildTopicSections([{ node_id: A, count: 12 }, { node_id: B, count: 3 }, { node_id: C, count: 1 }], names);
    expect(s.map((x) => [x.name, x.question_count])).toEqual([["Percentages", 12], ["Number series", 3], ["Topic 3", 1]]);
  });
  it("one topic works; the even split now also uses real names", () => {
    expect(buildTopicSections([{ node_id: A, count: 5 }], names)).toHaveLength(1);
    expect(buildDrillSections([A, B], 5, undefined, undefined, names).map((x) => x.name)).toEqual(["Percentages", "Number series"]);
  });
  it("rejects a zero count, a duplicate topic, a total above 100 and more than 10 topics", () => {
    expect(() => buildTopicSections([{ node_id: A, count: 0 }])).toThrow();
    expect(() => buildTopicSections([{ node_id: A, count: 1 }, { node_id: A, count: 1 }])).toThrow();
    expect(() => buildTopicSections([{ node_id: A, count: 60 }, { node_id: B, count: 41 }])).toThrow();
    expect(() => buildTopicSections(Array.from({ length: 11 }, (_, i) => ({ node_id: `${i}`, count: 1 })))).toThrow();
  });
});
