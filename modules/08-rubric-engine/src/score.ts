// AssessIQ — score-computation pure helpers.
//
// Per docs/05-ai-pipeline.md § "Score computation" (lines 336-345):
//   anchor_score    = sum(anchor.weight for each hit)
//   reasoning_score = (band / 4) * rubric.reasoning_weight_total
//   total           = anchor_score + reasoning_score
//   max             = anchor_weight_total + reasoning_weight_total  (== 100 by invariant)
//
// Pure functions, no DB, no IO. Deterministic. Lifted from
// modules/07-ai-grading/src/score.ts (now removed) per Phase 2 G2.B Session 2.

import type { Anchor, AnchorFinding, Rubric } from "./types.js";

/**
 * Sum of anchor weights for hits. Anchors not in the rubric are ignored
 * (a Stage-1 hallucination shouldn't earn points). Anchors in the rubric
 * but missing from findings count as miss (default-zero behavior).
 *
 * Plan-pinned signature: takes the bare anchor list (not the full rubric)
 * so 09-scoring can recompute partial sums without round-tripping the
 * rubric structure.
 */
export function sumAnchorScore(
  anchors: Anchor[],
  findings: AnchorFinding[],
): number {
  let total = 0;
  for (const anchor of anchors) {
    const finding = findings.find((f) => f.anchor_id === anchor.id);
    if (finding?.hit === true) total += anchor.weight;
  }
  return total;
}

/**
 * Reasoning band → score, linear from 0 to reasoning_weight_total.
 * Band must be 0..4 (validated by upstream Zod schemas; this function
 * does not re-validate to keep it pure).
 */
export function computeReasoningScore(rubric: Rubric, band: number): number {
  return (band / 4) * rubric.reasoning_weight_total;
}

/**
 * Combined score for a single (attempt, question) pair. Returns earned + max
 * so the caller can render `42 / 100` style fractions or convert to a
 * percentage in the band-aware aggregation in 09-scoring.
 */
export function finalScore(
  rubric: Rubric,
  findings: AnchorFinding[],
  band: number,
): { earned: number; max: number } {
  const earned =
    sumAnchorScore(rubric.anchors, findings) +
    computeReasoningScore(rubric, band);
  const max = rubric.anchor_weight_total + rubric.reasoning_weight_total;
  return { earned, max };
}
