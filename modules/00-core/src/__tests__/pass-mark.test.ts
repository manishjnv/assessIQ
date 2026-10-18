import { describe, expect, it } from "vitest";
import { DISTINCTION_PCT, attemptsAllowed, isPass, meetsPct } from "../pass-mark.js";

describe("pass mark (integer math)", () => {
  it.each([
    [59, 60, false], [60, 60, true], [69, 70, false], [70, 70, true],
    [89, 90, false], [90, 90, true],
  ])("score %i%% vs mark %i%% -> %s", (score, mark, expected) => {
    expect(isPass(score, 100, mark)).toBe(expected);
  });

  it("never rounds up at the boundary", () => {
    expect(isPass(59.99, 100, 60)).toBe(false);
    expect(isPass("599.9", "1000", 60)).toBe(false);
    expect(isPass(5.99, 10, 60)).toBe(false);
    expect(isPass(6, 10, 60)).toBe(true);
    expect(isPass(0.7, 1, 70)).toBe(true); // 0.7 * 100 float trap
    expect(meetsPct(89.99, 100, DISTINCTION_PCT)).toBe(false);
    expect(meetsPct(90, 100, DISTINCTION_PCT)).toBe(true);
  });

  it("fails on a zero or invalid maximum", () => {
    expect(isPass(0, 0, 1)).toBe(false);
    expect(isPass(5, Number.NaN, 1)).toBe(false);
  });
});

describe("attemptsAllowed (Z-39)", () => {
  it.each([
    [null, 0, 1], [undefined, 0, 1], [1, 0, 1], [0, 0, 1], [2, 0, 2], [3, 1, 4], [null, 1, 2], [2, -5, 2],
  ])("max %s + extra %i -> %i", (max, extra, expected) => {
    expect(attemptsAllowed(max, extra)).toBe(expected);
  });
});
