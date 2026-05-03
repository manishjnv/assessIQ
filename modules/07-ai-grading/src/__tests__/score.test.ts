/**
 * Unit tests for ../score.ts — pure math, no mocks, no I/O.
 *
 * Covers:
 *   - sumAnchorScore: all-hit, partial-hit, all-miss, out-of-rubric anchors.
 *   - computeReasoningScore: band 0/2/3/4, decimal arithmetic.
 *   - computeFinalScore: end-to-end worked example from docs/05-ai-pipeline.md § 341-345.
 */

import { describe, it, expect } from "vitest";
import {
  sumAnchorScore,
  computeReasoningScore,
  computeFinalScore,
  type RubricForScoring,
} from "../score.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREE_ANCHOR_RUBRIC: RubricForScoring = {
  anchors: [
    { id: "a1", weight: 12 },
    { id: "a2", weight: 12 },
    { id: "a3", weight: 12 },
  ],
  anchor_weight_total: 36,
  reasoning_weight_total: 24,
};

const TWO_ANCHOR_RUBRIC: RubricForScoring = {
  anchors: [
    { id: "b1", weight: 10 },
    { id: "b2", weight: 15 },
  ],
  anchor_weight_total: 25,
  reasoning_weight_total: 24,
};

// ---------------------------------------------------------------------------
// sumAnchorScore
// ---------------------------------------------------------------------------

describe("sumAnchorScore", () => {
  it("all hits sum to anchor_weight_total", () => {
    const findings = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: true },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, findings)).toBe(36);
  });

  it("partial hits sum proportionally", () => {
    const findings = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: true },
    ];
    // a1(12) + a3(12) = 24
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, findings)).toBe(24);
  });

  it("all misses contribute 0", () => {
    const findings = [
      { anchor_id: "a1", hit: false },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: false },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, findings)).toBe(0);
  });

  it("finding whose anchor_id is not in rubric is ignored — no points awarded", () => {
    const findings = [
      { anchor_id: "hallucinated_anchor", hit: true },
      { anchor_id: "a1", hit: true },
    ];
    // Only a1(12) counts — hallucinated_anchor is ignored
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, findings)).toBe(12);
  });

  it("anchor in rubric but absent from findings counts as miss", () => {
    // Only a1 finding present — a2 and a3 absent from findings → 0 for them
    const findings = [{ anchor_id: "a1", hit: true }];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, findings)).toBe(12);
  });

  it("empty findings returns 0", () => {
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC, [])).toBe(0);
  });

  it("mixed weight anchors with partial hits", () => {
    const findings = [
      { anchor_id: "b1", hit: true },
      { anchor_id: "b2", hit: false },
    ];
    expect(sumAnchorScore(TWO_ANCHOR_RUBRIC, findings)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// computeReasoningScore
// ---------------------------------------------------------------------------

describe("computeReasoningScore", () => {
  it("band 0 → 0", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 0)).toBe(0);
  });

  it("band 4 → reasoning_weight_total (24)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 4)).toBe(24);
  });

  it("band 2 → half of reasoning_weight_total (12)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 2)).toBe(12);
  });

  it("band 3 with reasoning_weight_total=24 → 18.0", () => {
    // (3 / 4) * 24 = 18.0
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 3)).toBe(18);
  });

  it("decimal weight: reasoning_weight_total=30, band=1 → 7.5", () => {
    const rubric: RubricForScoring = {
      anchors: [],
      anchor_weight_total: 0,
      reasoning_weight_total: 30,
    };
    // (1 / 4) * 30 = 7.5
    expect(computeReasoningScore(rubric, 1)).toBeCloseTo(7.5, 10);
  });

  it("decimal weight: reasoning_weight_total=10, band=3 → 7.5", () => {
    const rubric: RubricForScoring = {
      anchors: [],
      anchor_weight_total: 0,
      reasoning_weight_total: 10,
    };
    // (3 / 4) * 10 = 7.5
    expect(computeReasoningScore(rubric, 3)).toBeCloseTo(7.5, 10);
  });
});

// ---------------------------------------------------------------------------
// computeFinalScore — worked example from docs/05-ai-pipeline.md § 341-345
//
// Rubric: anchor_weight_total=36, reasoning_weight_total=24
// 2 of 3 anchors hit at equal weights [12, 12, 12]
// band=3
// Expected: earned=42, max=60
// ---------------------------------------------------------------------------

describe("computeFinalScore", () => {
  it("worked example from docs: 2/3 anchors hit, band=3 → earned=42, max=60", () => {
    const findings = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: false },
    ];
    // anchor_score = 12 + 12 = 24
    // reasoning_score = (3/4) * 24 = 18
    // earned = 24 + 18 = 42
    // max = 36 + 24 = 60
    const { earned, max } = computeFinalScore(THREE_ANCHOR_RUBRIC, findings, 3);
    expect(earned).toBe(42);
    expect(max).toBe(60);
  });

  it("all anchors hit, band=4 → earned === max", () => {
    const findings = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: true },
    ];
    const { earned, max } = computeFinalScore(THREE_ANCHOR_RUBRIC, findings, 4);
    expect(earned).toBe(60);
    expect(max).toBe(60);
    expect(earned).toBe(max);
  });

  it("no anchors hit, band=0 → earned=0", () => {
    const findings = [
      { anchor_id: "a1", hit: false },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: false },
    ];
    const { earned, max } = computeFinalScore(THREE_ANCHOR_RUBRIC, findings, 0);
    expect(earned).toBe(0);
    expect(max).toBe(60);
  });

  it("max is always anchor_weight_total + reasoning_weight_total regardless of hits/band", () => {
    const { max } = computeFinalScore(THREE_ANCHOR_RUBRIC, [], 0);
    expect(max).toBe(THREE_ANCHOR_RUBRIC.anchor_weight_total + THREE_ANCHOR_RUBRIC.reasoning_weight_total);
  });
});
