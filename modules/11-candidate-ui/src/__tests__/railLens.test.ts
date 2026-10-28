import { describe, expect, it } from "vitest";
import { lensOffset, railDistanceStyle } from "../components/railLens.js";

describe("lensOffset", () => {
  it("centres a cell: first cell in a 600 px view with 42 px cells", () => {
    // cell centre at 21 -> move down 279 so it sits at 300
    expect(lensOffset(600, 0, 42)).toBe(279);
  });
  it("centres a later cell: 5th cell (offset 216 = 4 * (42 + 12))", () => {
    const off = lensOffset(600, 216, 42);
    expect(off).toBe(63);
    expect(216 + 21 + off).toBe(300); // cell centre lands on the view centre
  });
  it("works for a 68 px horizontal strip width", () => {
    expect(lensOffset(300, 108, 42)).toBe(21);
  });
  it("moves up (negative) when the cell is past the centre", () => {
    expect(lensOffset(200, 500, 42)).toBe(-421);
  });
});

describe("railDistanceStyle", () => {
  it("gives the handoff table values", () => {
    expect(railDistanceStyle(0)).toEqual({ scale: 1.16, opacity: 1 });
    expect(railDistanceStyle(1)).toEqual({ scale: 0.94, opacity: 0.92 });
    expect(railDistanceStyle(2)).toEqual({ scale: 0.88, opacity: 0.62 });
    expect(railDistanceStyle(3)).toEqual({ scale: 0.82, opacity: 0.38 });
  });
  it("clamps 4 and further, and ignores the sign", () => {
    expect(railDistanceStyle(4)).toEqual({ scale: 0.78, opacity: 0.2 });
    expect(railDistanceStyle(-9)).toEqual({ scale: 0.78, opacity: 0.2 });
    expect(railDistanceStyle(-1)).toEqual({ scale: 0.94, opacity: 0.92 });
  });
});
