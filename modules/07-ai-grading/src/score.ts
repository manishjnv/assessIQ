// AssessIQ — Phase 1 score computation.
//
// Per docs/05-ai-pipeline.md § "Score computation" (lines 336-345):
//   anchor_score    = sum(anchor.weight for each hit)
//   reasoning_score = (band / 4) * rubric.reasoning_weight_total
//   total           = anchor_score + reasoning_score
//
// Pure functions, no DB, no IO. The Phase 2 G2.B-Session-2 lift will move the
// canonical Rubric Zod schema into @assessiq/rubric-engine and these helpers
// will re-import the type from there. For Phase 2 G2.A 1.b the local minimal
// interface keeps modules/07-ai-grading independent of rubric-engine's
// timeline (G2.B is the next group, not blocking).

export interface RubricAnchor {
  id: string;
  weight: number;
}

export interface RubricForScoring {
  anchors: RubricAnchor[];
  anchor_weight_total: number;
  reasoning_weight_total: number;
}

export interface AnchorHit {
  anchor_id: string;
  hit: boolean;
}

/**
 * Sum of anchor weights for hits. Anchors not in the rubric are ignored
 * (a Stage-1 hallucination shouldn't earn points). Anchors in the rubric
 * but missing from findings count as miss (default-zero behavior).
 */
export function sumAnchorScore(rubric: RubricForScoring, findings: AnchorHit[]): number {
  let total = 0;
  for (const anchor of rubric.anchors) {
    const finding = findings.find((f) => f.anchor_id === anchor.id);
    if (finding?.hit === true) total += anchor.weight;
  }
  return total;
}

/**
 * Reasoning band → score, linear from 0 to reasoning_weight_total.
 * Band must be 0..4 (validated by BandFindingSchema upstream).
 */
export function computeReasoningScore(rubric: RubricForScoring, band: number): number {
  return (band / 4) * rubric.reasoning_weight_total;
}

/**
 * Combined score for a single (attempt, question) pair. Returns earned + max
 * so the caller can render `42 / 60` style fractions.
 */
export function computeFinalScore(
  rubric: RubricForScoring,
  findings: AnchorHit[],
  band: number,
): { earned: number; max: number } {
  const earned = sumAnchorScore(rubric, findings) + computeReasoningScore(rubric, band);
  const max = rubric.anchor_weight_total + rubric.reasoning_weight_total;
  return { earned, max };
}
