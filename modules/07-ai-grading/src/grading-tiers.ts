/**
 * Least-AI grading tier order (owner rule P4, 2026-10-01):
 *   grade with the least AI that keeps accuracy: answer keys first
 *   (deterministic types), AI only for written judgment, humans only for
 *   flagged cases.
 *
 * The order is enforced by handleAdminGrade: deterministic gradings rows exist
 * before the question loop (module 09 scores them); reuse and rule run per
 * question BEFORE the runtime; the runtime runs only for AI_GRADEABLE_TYPES
 * (and not at all when the tenant's ai_grading_scope is 'none'); everything
 * else (kql, flagged, manual) is human scoring. This file is pure and holds
 * no AI call path; it only names the tiers and classifies rows for metrics.
 */

import type { GradingProposal } from "./types.js";

export const GRADING_TIERS = ["answer_key", "reuse", "rule", "ai", "human"] as const;

export type GradingTier = (typeof GRADING_TIERS)[number];

export function emptyTierCounts(): Record<GradingTier, number> {
  return { answer_key: 0, reuse: 0, rule: 0, ai: 0, human: 0 };
}

/** Tier of a committed gradings row. */
export function tierOfGrading(row: {
  grader: string;
  model?: string | null;
  status?: string;
}): GradingTier {
  if (row.grader === "deterministic" || row.grader === "pattern") return "answer_key";
  if (row.grader === "admin_override" || row.grader === "manual") return "human";
  if (row.model === "reuse") return "reuse";
  if (row.model === "rule") return "rule";
  if (row.model === "none") return "human";
  if (row.grader === "ai") return "ai";
  return "human";
}

/** Tier of a not-yet-committed proposal (no source and model none = human to score). */
export function tierOfProposal(p: GradingProposal): GradingTier {
  if (p.source === "rule") return "rule";
  if (p.source === "reuse") return "reuse";
  if (p.source === "ai") return "ai";
  if (p.model === "none") return "human";
  return "ai";
}

export function countTiers(tiers: readonly GradingTier[]): Record<GradingTier, number> {
  const out = emptyTierCounts();
  for (const t of tiers) out[t] += 1;
  return out;
}
