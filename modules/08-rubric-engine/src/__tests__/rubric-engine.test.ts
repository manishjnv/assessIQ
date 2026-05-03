// AssessIQ — @assessiq/rubric-engine unit tests.
//
// Pure unit tests — no testcontainers, no DB. Per PHASE_2_KICKOFF.md G2.B
// Session 2 verification checklist.

import { describe, it, expect } from "vitest";
import {
  validateRubric,
  sumAnchorScore,
  computeReasoningScore,
  finalScore,
  RubricSchema,
  AnchorSchema,
  type Rubric,
  type Anchor,
  type AnchorFinding,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
//
// THREE_ANCHOR_RUBRIC mirrors docs/05-ai-pipeline.md § "Score computation"
// worked example (lines 336-345): anchor_weight_total=60, reasoning=40,
// three anchors of equal weight 20.

const THREE_ANCHOR_RUBRIC: Rubric = {
  anchors: [
    { id: "a1", concept: "lateral movement", weight: 20, synonyms: ["lateral", "T1021"] },
    { id: "a2", concept: "credential reuse", weight: 20, synonyms: ["pass-the-hash", "T1078"] },
    { id: "a3", concept: "pivot to identity", weight: 20, synonyms: ["AD", "kerberos"] },
  ],
  reasoning_bands: {
    band_4: "All anchors + correct causal chain + correct escalation path",
    band_3: "All anchors + minor causal gap or escalation imprecision",
    band_2: "Partial anchors + surface-level reasoning",
    band_1: "Anchors mentioned without understanding (keyword stuffing)",
    band_0: "Off-topic or empty",
  },
  anchor_weight_total: 60,
  reasoning_weight_total: 40,
};

const TWO_ANCHOR_RUBRIC: Rubric = {
  anchors: [
    { id: "a1", concept: "encryption at rest", weight: 30, synonyms: ["KMS", "BYOK"] },
    { id: "a2", concept: "key rotation", weight: 30, synonyms: ["rotation", "lifecycle"] },
  ],
  reasoning_bands: {
    band_4: "Top",
    band_3: "Strong",
    band_2: "Partial",
    band_1: "Surface",
    band_0: "Empty",
  },
  anchor_weight_total: 60,
  reasoning_weight_total: 40,
};

// ---------------------------------------------------------------------------
// validateRubric
// ---------------------------------------------------------------------------

describe("validateRubric", () => {
  it("accepts the canonical worked-example rubric", () => {
    const result = validateRubric(THREE_ANCHOR_RUBRIC);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an empty anchors array", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      anchors: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("anchors"))).toBe(true);
  });

  it("rejects when anchor_weight_total + reasoning_weight_total != 100", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      anchor_weight_total: 50,
      reasoning_weight_total: 40,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must equal 100"))).toBe(true);
  });

  it("rejects when a reasoning band description is missing", () => {
    const broken: Record<string, unknown> = { ...THREE_ANCHOR_RUBRIC };
    broken.reasoning_bands = {
      band_4: "ok",
      band_3: "ok",
      band_2: "ok",
      band_1: "ok",
      // band_0 missing
    };
    const result = validateRubric(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("band_0"))).toBe(true);
  });

  it("rejects an anchor with empty synonyms list", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      anchors: [
        { id: "a1", concept: "x", weight: 20, synonyms: [] },
        ...THREE_ANCHOR_RUBRIC.anchors.slice(1),
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      extra: "not allowed",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects negative anchor weights", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      anchors: [
        { id: "a1", concept: "x", weight: -5, synonyms: ["y"] },
        ...THREE_ANCHOR_RUBRIC.anchors.slice(1),
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("returns errors with path prefix for nested issues", () => {
    const result = validateRubric({
      ...THREE_ANCHOR_RUBRIC,
      anchors: [{ id: "", concept: "x", weight: 20, synonyms: ["y"] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("anchors.0.id"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sumAnchorScore
// ---------------------------------------------------------------------------

describe("sumAnchorScore", () => {
  it("sums weights for all hits (full mark on anchors)", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: true },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, findings)).toBe(60);
  });

  it("returns 0 when no findings hit", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: false },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: false },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, findings)).toBe(0);
  });

  it("partial hit sums only the hit anchors", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: true },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, findings)).toBe(40);
  });

  it("ignores findings for anchors not in the rubric (Stage-1 hallucination guard)", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "made_up_anchor", hit: true },
    ];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, findings)).toBe(20);
  });

  it("treats missing findings as miss (default zero)", () => {
    const findings: AnchorFinding[] = [{ anchor_id: "a1", hit: true }];
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, findings)).toBe(20);
  });

  it("empty findings array yields 0", () => {
    expect(sumAnchorScore(THREE_ANCHOR_RUBRIC.anchors, [])).toBe(0);
  });

  it("weighted differently — uses each anchor's own weight", () => {
    const anchors: Anchor[] = [
      { id: "a1", concept: "x", weight: 30, synonyms: ["y"] },
      { id: "a2", concept: "z", weight: 30, synonyms: ["w"] },
    ];
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: false },
    ];
    expect(sumAnchorScore(anchors, findings)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// computeReasoningScore — exact formula verification
// ---------------------------------------------------------------------------

describe("computeReasoningScore", () => {
  it("band 0 → 0", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 0)).toBe(0);
  });

  it("band 4 → reasoning_weight_total (40)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 4)).toBe(40);
  });

  it("band 2 → half of reasoning_weight_total (20)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 2)).toBe(20);
  });

  it("band 1 → quarter of reasoning_weight_total (10)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 1)).toBe(10);
  });

  it("band 3 → three-quarters of reasoning_weight_total (30)", () => {
    expect(computeReasoningScore(THREE_ANCHOR_RUBRIC, 3)).toBe(30);
  });

  it("decimal arithmetic preserved with non-divisible reasoning_weight_total", () => {
    const odd: Rubric = { ...THREE_ANCHOR_RUBRIC, anchor_weight_total: 70, reasoning_weight_total: 30 };
    expect(computeReasoningScore(odd, 1)).toBeCloseTo(7.5, 10);
    expect(computeReasoningScore(odd, 3)).toBeCloseTo(22.5, 10);
  });
});

// ---------------------------------------------------------------------------
// finalScore — worked example from docs/05-ai-pipeline.md § 341-345
// ---------------------------------------------------------------------------

describe("finalScore", () => {
  it("worked example: 2 hits + band 3 → 70/100", () => {
    // Worked example in the SKILL.md and 05-ai-pipeline.md §341-345:
    //   a1 hit, a2 hit, a3 miss, band 3
    //   anchor_score = 20 + 20 = 40
    //   reasoning_score = (3/4) * 40 = 30
    //   earned = 70, max = 100
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: false },
    ];
    const { earned, max } = finalScore(THREE_ANCHOR_RUBRIC, findings, 3);
    expect(earned).toBe(70);
    expect(max).toBe(100);
  });

  it("perfect: all hits + band 4 → 100/100", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: true },
      { anchor_id: "a3", hit: true },
    ];
    const { earned, max } = finalScore(THREE_ANCHOR_RUBRIC, findings, 4);
    expect(earned).toBe(100);
    expect(max).toBe(100);
  });

  it("zero: no hits + band 0 → 0/100", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: false },
      { anchor_id: "a2", hit: false },
      { anchor_id: "a3", hit: false },
    ];
    const { earned, max } = finalScore(THREE_ANCHOR_RUBRIC, findings, 0);
    expect(earned).toBe(0);
    expect(max).toBe(100);
  });

  it("max equals anchor_weight_total + reasoning_weight_total regardless of findings", () => {
    const { max } = finalScore(THREE_ANCHOR_RUBRIC, [], 0);
    expect(max).toBe(THREE_ANCHOR_RUBRIC.anchor_weight_total + THREE_ANCHOR_RUBRIC.reasoning_weight_total);
  });

  it("works on a different rubric shape", () => {
    const findings: AnchorFinding[] = [
      { anchor_id: "a1", hit: true },
      { anchor_id: "a2", hit: false },
    ];
    const { earned, max } = finalScore(TWO_ANCHOR_RUBRIC, findings, 2);
    // anchor: 30; reasoning: (2/4)*40 = 20; total 50.
    expect(earned).toBe(50);
    expect(max).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Schema identity guards — RubricSchema/AnchorSchema are usable as Zod
// ---------------------------------------------------------------------------

describe("schema exports", () => {
  it("RubricSchema parses the worked example", () => {
    const result = RubricSchema.safeParse(THREE_ANCHOR_RUBRIC);
    expect(result.success).toBe(true);
  });

  it("AnchorSchema parses a single anchor", () => {
    const result = AnchorSchema.safeParse(THREE_ANCHOR_RUBRIC.anchors[0]);
    expect(result.success).toBe(true);
  });
});
