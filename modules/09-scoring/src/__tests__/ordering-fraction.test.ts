/** Pure unit tests for the ordering scorer (no DB, no AI). */
import { describe, it, expect } from "vitest";
import { orderingFraction, deterministicFraction, DETERMINISTIC_TYPES } from "../mcq.js";

const key = [2, 0, 3, 1];
const aon = { question: "q", items: ["a", "b", "c", "d"], correct_order: key };
const partial = { ...aon, scoring: "partial" };

describe("orderingFraction", () => {
  it("is a deterministic type", () => {
    expect(DETERMINISTIC_TYPES).toContain("ordering");
    expect(deterministicFraction("ordering", aon, { order: key })).toBe(1);
  });

  it("exact order scores 1 in both modes", () => {
    expect(orderingFraction(aon, { order: key })).toBe(1);
    expect(orderingFraction(partial, { order: key })).toBe(1);
  });

  it("all_or_nothing: any difference scores 0 (default mode)", () => {
    expect(orderingFraction(aon, { order: [2, 0, 1, 3] })).toBe(0);
    expect(orderingFraction({ ...aon, scoring: "all_or_nothing" }, { order: [0, 1, 2, 3] })).toBe(0);
  });

  it("partial: share of positions that match", () => {
    expect(orderingFraction(partial, { order: [2, 0, 1, 3] })).toBe(0.5); // positions 0,1 right
    expect(orderingFraction(partial, { order: [2, 3, 1, 0] })).toBe(0.25); // position 0 right
    expect(orderingFraction(partial, { order: [0, 1, 2, 3] })).toBe(0); // 0 positions right
  });

  it("malformed answers score 0: wrong length, duplicate, out of range, non-integer, non-array, missing", () => {
    for (const mode of [aon, partial]) {
      for (const bad of [
        { order: [2, 0, 3] },
        { order: [2, 0, 3, 1, 1] },
        { order: [2, 2, 3, 1] },
        { order: [2, 0, 3, 4] },
        { order: [2, 0, 3, -1] },
        { order: [2, 0, 3, 1.5] },
        { order: ["2", "0", "3", "1"] },
        { order: "2031" },
        { order: null },
        { order: [] },
        {},
        [2, 0, 3, 1],
        null,
        undefined,
        "",
        7,
      ]) {
        expect(orderingFraction(mode, bad)).toBe(0);
      }
    }
  });

  it("malformed content scores 0 and never throws", () => {
    for (const bad of [null, undefined, "x", {}, { correct_order: [0, 0] }, { correct_order: [1, 2] }, { correct_order: [0] }, { correct_order: "01" }]) {
      expect(orderingFraction(bad, { order: [0, 1] })).toBe(0);
    }
  });
});
