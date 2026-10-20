import { describe, it, expect } from "vitest";
import { takeUnits, type PassageInfo } from "../passages.js";

const q = (id: string) => ({ id });
const fact = (passageId: string, position: number) => ({ passageId, position, createdAt: position });

describe("takeUnits exact-fit fallback", () => {
  it("fills n when first-fit would strand a gap (4 singles first, then passages of 2 and 3, n = 5)", () => {
    const info: PassageInfo = new Map([
      ["a1", fact("A", 1)], ["a2", fact("A", 2)],
      ["b1", fact("B", 1)], ["b2", fact("B", 2)], ["b3", fact("B", 3)],
    ]);
    const picks = ["s1", "s2", "s3", "s4", "a1", "a2", "b1", "b2", "b3"].map(q);
    const out = takeUnits(picks, 5, info).map((x) => x.id);
    expect(out).toHaveLength(5);
    expect(out).toEqual(expect.arrayContaining(["a1", "a2"].every((i) => out.includes(i)) ? ["a1", "a2"] : ["b1", "b2", "b3"]));
    // a passage is never split
    expect(out.includes("a1")).toBe(out.includes("a2"));
    expect(out.filter((i) => i.startsWith("b")).length % 3).toBe(0);
  });

  it("returns the shorter greedy result when no exact fit exists", () => {
    const info: PassageInfo = new Map([["a1", fact("A", 1)], ["a2", fact("A", 2)], ["a3", fact("A", 3)]]);
    expect(takeUnits(["s1", "a1", "a2", "a3"].map(q), 2, info).map((x) => x.id)).toEqual(["s1"]);
  });
});
