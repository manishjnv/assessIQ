// AssessIQ — modules/09-scoring canonical types.
//
// Phase 2 G2.B Session 3. Public surface pinned for 10-admin-dashboard (G2.C).
//
// P2.D11 — ArchetypeSignals JSONB shape (verbatim from PHASE_2_KICKOFF.md).
// P2.D13 — ArchetypeLabel enum: 8 built-ins, no AI inference, deterministic only.

import { z } from "zod";

// ---------------------------------------------------------------------------
// ArchetypeLabel — 8 built-in labels (P2.D13 / modules/09-scoring/SKILL.md:32–39)
// ---------------------------------------------------------------------------
//
// Assigned by deterministic signal math; NEVER by an LLM.
// Tenant-defined custom archetypes are an explicit Phase 3 deferral.
// See archetype.ts for the classification rules.

export const ARCHETYPE_LABELS = [
  "methodical_diligent",
  "confident_correct",
  "confident_wrong",
  "cautious_uncertain",
  "last_minute_rusher",
  "even_pacer",
  "pattern_matcher",
  "deep_reasoner",
] as const;

export const ArchetypeLabelSchema = z.enum(ARCHETYPE_LABELS);
export type ArchetypeLabel = z.infer<typeof ArchetypeLabelSchema>;

// ---------------------------------------------------------------------------
// ArchetypeSignals — JSONB shape stored in attempt_scores.archetype_signals
//
// This shape is the contract that module 10 (admin dashboard) binds to for
// its ArchetypeRadar component (P2.D18). Do NOT change field names without a
// migration + module 10 update.
// ---------------------------------------------------------------------------

export const ArchetypeSignalsSchema = z.object({
  /** Median per-question time across all questions in the attempt (ms). */
  time_per_question_p50_ms: z.number(),
  /** IQR (Q3 − Q1) of per-question times (ms). Low IQR = even pacer. */
  time_per_question_iqr_ms: z.number(),
  /** Total edits across all answers (sum of attempt_answers.edits_count). */
  edit_count_total: z.number(),
  /** Number of questions flagged at any point. */
  flag_count: z.number(),
  /** multi_tab_conflict event count. */
  multi_tab_conflict_count: z.number(),
  /** tab_blur event count. */
  tab_blur_count: z.number(),
  /** copy + paste event count combined. */
  copy_paste_count: z.number(),
  /**
   * Mean reasoning band (0..4) across AI-graded (subjective) questions only.
   * null signals if no subjective questions exist in the attempt.
   */
  reasoning_band_avg: z.number().nullable(),
  /**
   * Count of AI-graded gradings per reasoning band value "0".."4".
   * Keys that did not appear have a count of 0.
   */
  reasoning_band_distribution: z.record(
    z.enum(["0", "1", "2", "3", "4"]),
    z.number(),
  ),
  /**
   * Count of gradings per error_class string.
   * Only non-null error_class values are counted.
   */
  error_class_counts: z.record(z.string(), z.number()),
  /** True iff the attempt ended via auto-submit (timer expired). */
  auto_submitted: z.boolean(),
});
export type ArchetypeSignals = z.infer<typeof ArchetypeSignalsSchema>;

// ---------------------------------------------------------------------------
// AttemptScore — the full row returned by computeAttemptScore
// ---------------------------------------------------------------------------

export const AttemptScoreSchema = z.object({
  attempt_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  total_earned: z.number(),
  total_max: z.number(),
  /** Stored as NUMERIC(5,2) in DB; returned as a number here (0..100). */
  auto_pct: z.number(),
  pending_review: z.boolean(),
  archetype: ArchetypeLabelSchema.nullable(),
  archetype_signals: ArchetypeSignalsSchema.nullable(),
  /** ISO-8601 timestamp. */
  computed_at: z.string(),
});
export type AttemptScore = z.infer<typeof AttemptScoreSchema>;

// ---------------------------------------------------------------------------
// CohortStats — returned by cohortStats(assessmentId)
// ---------------------------------------------------------------------------

export const CohortStatsSchema = z.object({
  attempt_count: z.number().int(),
  average_pct: z.number().nullable(),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p90: z.number().nullable(),
  archetype_distribution: z.record(z.string(), z.number()),
});
export type CohortStats = z.infer<typeof CohortStatsSchema>;

// ---------------------------------------------------------------------------
// LeaderboardRow — returned by leaderboard(assessmentId, opts)
// ---------------------------------------------------------------------------

export const LeaderboardRowSchema = z.object({
  rank: z.number().int(),
  attempt_id: z.string().uuid(),
  /** Null or masked when anonymize=true. */
  candidate_name: z.string().nullable(),
  /** Null or masked when anonymize=true. */
  candidate_email: z.string().nullable(),
  auto_pct: z.number(),
  archetype: ArchetypeLabelSchema.nullable(),
  computed_at: z.string(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

// ---------------------------------------------------------------------------
// IndividualReport — returned by individualReport(userId)
// ---------------------------------------------------------------------------

export const IndividualScoreSchema = z.object({
  attempt_id: z.string().uuid(),
  assessment_id: z.string().uuid(),
  assessment_name: z.string(),
  auto_pct: z.number(),
  archetype: ArchetypeLabelSchema.nullable(),
  computed_at: z.string(),
});
export type IndividualScore = z.infer<typeof IndividualScoreSchema>;

// ---------------------------------------------------------------------------
// Internal: CohortPercentiles — passed to deriveArchetype for threshold logic
// ---------------------------------------------------------------------------

export interface CohortPercentiles {
  time_p25_ms: number;
  time_p75_ms: number;
  edit_p25: number;
  edit_p75: number;
  iqr_p25_ms: number;
}
