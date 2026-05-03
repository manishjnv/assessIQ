// AssessIQ — modules/15-analytics/src/types.ts
//
// Phase 3 G3.C — type definitions for the analytics module.
//
// All aggregations operate on banded values (0/25/50/75/100 from scoring)
// and archetype labels. Raw float scores are NEVER returned in aggregated
// report payloads — averaged percentage metrics are labelled clearly as
// "% of cohort meeting band X" or "avg auto_pct" (a derived metric, not
// the raw 0-100 score band itself).
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any
// AI SDK. Rule #1 CLAUDE.md. Analytics is deterministic aggregation only.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Dashboard tiles
// ---------------------------------------------------------------------------

export interface HomeKpis {
  /** Number of assessments currently in 'active' status for this tenant. */
  activeAssessments: number;
  /** Number of attempts created in the last 7 calendar days. */
  attemptsThisWeek: number;
  /** Number of attempts in 'pending_admin_grading' status. */
  awaitingReview: number;
  /**
   * Average auto_pct of attempts scored this week.
   * Null when no scored attempts exist for the period.
   * NOTE: this is the mean of the computed percentage score, not a raw score
   * band — it is derived from the banded scoring in attempt_scores.auto_pct
   * and returned as an informational KPI, not a raw band value.
   */
  avgPctThisWeek: number | null;
}

export interface QueueSummary {
  /** Attempts currently in 'in_progress' status. */
  inProgress: number;
  /**
   * Attempts in async grading queue ('grading' status).
   * Always 0 in claude-code-vps mode (Phase 1 sync-on-click pipeline).
   */
  grading: number;
  /** Attempts awaiting admin review ('pending_admin_grading'). */
  awaitingReview: number;
  /** Attempts fully graded and released ('graded' or 'released'). */
  ready: number;
}

// ---------------------------------------------------------------------------
// Cohort report (enriched over 09-scoring's CohortStats)
// ---------------------------------------------------------------------------

export interface LevelBreakdown {
  levelId: string;
  levelLabel: string;
  attemptCount: number;
  averagePct: number | null;
}

export interface TopicBreakdownItem {
  topic: string;
  attemptsCount: number;
  averagePct: number | null;
  hitRatePct: number | null;
}

export interface CohortReport {
  assessmentId: string;
  attemptCount: number;
  averagePct: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  archetypeDistribution: Record<string, number>;
  levelBreakdown: LevelBreakdown[];
  topicBreakdown: TopicBreakdownItem[];
}

// ---------------------------------------------------------------------------
// Individual report
// ---------------------------------------------------------------------------

export interface AttemptSummaryRow {
  attemptId: string;
  assessmentId: string;
  assessmentName: string;
  status: string;
  submittedAt: string | null;
  totalEarned: number;
  totalMax: number;
  autoPct: number;
  archetype: string | null;
  computedAt: string;
}

export interface IndividualReport {
  userId: string;
  attempts: AttemptSummaryRow[];
  archetypeProgression: Array<{ archetype: string; weight: number }>;
}

// ---------------------------------------------------------------------------
// Topic heatmap
// ---------------------------------------------------------------------------

export interface TopicHeatmapCell {
  topic: string;
  attemptsCount: number;
  attemptsCorrect: number;
  hitRatePct: number;
  /** Average reasoning_band (0–4), null if all questions are deterministic. */
  meanBand: number | null;
  p50Band: number | null;
}

export interface TopicHeatmap {
  tenantId: string;
  packId: string;
  periodStart: string | null;
  periodEnd: string | null;
  cells: TopicHeatmapCell[];
}

// ---------------------------------------------------------------------------
// Archetype distribution
// ---------------------------------------------------------------------------

export interface ArchetypeDistributionItem {
  archetype: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Cost telemetry (P3.D21)
// ---------------------------------------------------------------------------

export interface CostRow {
  /** YYYY-MM */
  month: string;
  currency: 'USD';
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Export column shapes (P3.D19)
// ---------------------------------------------------------------------------

export interface AttemptExportRow {
  tenant_id: string;
  assessment_id: string;
  assessment_name: string;
  user_id: string;
  user_email: string;
  attempt_id: string;
  status: string;
  submitted_at: string | null;
  total_earned: number;
  total_max: number;
  auto_pct: number;
  archetype: string | null;
  computed_at: string;
}

export interface TopicHeatmapExportRow {
  tenant_id: string;
  pack_id: string;
  topic: string;
  attempts_count: number;
  attempts_correct: number;
  hit_rate_pct: number;
  mean_band: number | null;
  p50_band: number | null;
}

// ---------------------------------------------------------------------------
// Report filters
// ---------------------------------------------------------------------------

export const ReportFilterSchema = z.object({
  assessmentId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
});
export type ReportFilter = z.infer<typeof ReportFilterSchema>;

export const ExportFilterSchema = z.object({
  assessmentId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  /** Hard limit: export at most this many rows. Default + max = 10_000. */
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 10_000))
    .pipe(z.number().int().min(1).max(10_000)),
});
export type ExportFilter = z.infer<typeof ExportFilterSchema>;
