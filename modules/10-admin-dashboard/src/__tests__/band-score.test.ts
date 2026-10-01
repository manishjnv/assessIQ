import { describe, expect, it } from "vitest";
import { bandToScore } from "../lib/band-score.js";

describe("bandToScore", () => {
  it("scales the band to the grading's own maximum", () => {
    expect(bandToScore(4, 100)).toBe(100);
    expect(bandToScore(3, 100)).toBe(75);
    expect(bandToScore(4, 10)).toBe(10); // AI-failure placeholder: score_max = points
    expect(bandToScore(2, 10)).toBe(5);
    expect(bandToScore(1, 7)).toBe(1.75);
    expect(bandToScore(0, 7)).toBe(0);
  });

  it("never exceeds the maximum the API accepts", () => {
    for (const max of [1, 3, 5, 7, 10, 60, 100]) {
      for (const band of [0, 1, 2, 3, 4]) {
        const s = bandToScore(band, max);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(max);
      }
    }
  });
});
