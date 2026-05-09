// AssessIQ — modules/07-ai-grading/src/__tests__/auto-weight.test.ts
//
// Unit tests for auto-weight.ts — allocateByWeight and applyOverride.

import { describe, it, expect } from "vitest";
import { allocateByWeight, applyOverride, TYPE_WEIGHTS } from "../auto-weight.js";
import type { QuestionType } from "../types.js";

const LEVELS = ["L1", "L2", "L3"] as const;
const TYPES: QuestionType[] = ["mcq", "log_analysis", "scenario", "kql", "subjective"];

// Helper — sum all values in a record
function sumValues(r: Record<QuestionType, number>): number {
  return TYPES.reduce((s, t) => s + r[t], 0);
}

// Helper — which type has the highest weight in TYPE_WEIGHTS for a level
function dominantType(level: "L1" | "L2" | "L3"): QuestionType {
  const weights = TYPE_WEIGHTS[level];
  return TYPES.reduce((best, t) => (weights[t] > weights[best] ? t : best), TYPES[0]!);
}

describe("allocateByWeight", () => {
  it.each(LEVELS)("allocateByWeight(%s, 30) sums to 30", (level) => {
    const result = allocateByWeight(level, 30);
    expect(sumValues(result)).toBe(30);
  });

  it.each(LEVELS)("allocateByWeight(%s, 1) returns 1 for dominant type, 0 elsewhere", (level) => {
    const result = allocateByWeight(level, 1);
    expect(sumValues(result)).toBe(1);
    const dominant = dominantType(level);
    expect(result[dominant]).toBe(1);
    for (const t of TYPES) {
      if (t !== dominant) expect(result[t]).toBe(0);
    }
  });

  it("allocateByWeight produces integer values for L2, count=30 (example from design doc)", () => {
    // L2 weights: mcq=35, log_analysis=30, scenario=20, kql=10, subjective=5
    // exact:   mcq=10.5, log=9, scenario=6, kql=3, subj=1.5
    // floored: mcq=10,  log=9, scenario=6, kql=3, subj=1   → sum=29
    // remainder=1 → goes to mcq (largest fraction 0.5), tie-break: subj(0.5)?
    // Actually both mcq and subj have 0.5 — tie-break by alpha: mcq < subj so mcq gets it
    const result = allocateByWeight("L2", 30);
    expect(sumValues(result)).toBe(30);
    expect(result["mcq"]).toBe(11);
    expect(result["log_analysis"]).toBe(9);
    expect(result["scenario"]).toBe(6);
    expect(result["kql"]).toBe(3);
    expect(result["subjective"]).toBe(1);
  });

  it("is deterministic — same inputs always yield same output", () => {
    const a = allocateByWeight("L3", 17);
    const b = allocateByWeight("L3", 17);
    expect(a).toEqual(b);
  });

  it("handles totalCount=0 — all zeros", () => {
    const result = allocateByWeight("L1", 0);
    expect(sumValues(result)).toBe(0);
  });
});

describe("applyOverride", () => {
  it("preserves overrides and rebalances residual", () => {
    const base = allocateByWeight("L2", 10);
    const overridden = applyOverride(base, { mcq: 5 });
    expect(overridden["mcq"]).toBe(5);
    expect(sumValues(overridden)).toBe(10);
    // non-overridden types together sum to 5
    const nonMcqSum = TYPES.filter((t) => t !== "mcq").reduce((s, t) => s + overridden[t], 0);
    expect(nonMcqSum).toBe(5);
  });

  it("overrides summing > totalCount returns overrides verbatim, zeros out rest", () => {
    const base = allocateByWeight("L1", 10);
    // Override with 15 total (> 10)
    const overridden = applyOverride(base, { mcq: 8, log_analysis: 7 });
    expect(overridden["mcq"]).toBe(8);
    expect(overridden["log_analysis"]).toBe(7);
    expect(overridden["scenario"]).toBe(0);
    expect(overridden["kql"]).toBe(0);
    expect(overridden["subjective"]).toBe(0);
  });

  it("overrides summing exactly to totalCount zeros out non-overridden", () => {
    const base = allocateByWeight("L1", 10);
    const overridden = applyOverride(base, { mcq: 6, log_analysis: 4 });
    expect(sumValues(overridden)).toBe(10);
    expect(overridden["scenario"]).toBe(0);
    expect(overridden["kql"]).toBe(0);
    expect(overridden["subjective"]).toBe(0);
  });

  it("empty override leaves allocation unchanged", () => {
    const base = allocateByWeight("L3", 20);
    const overridden = applyOverride(base, {});
    expect(overridden).toEqual(base);
  });
});
