// AssessIQ — modules/09-scoring archetype computation.
//
// Phase 2 G2.B Session 3 — deterministic signal aggregation + label assignment.
//
// RULE: no AI calls here or anywhere in modules/09-scoring. The D2 lint at
// modules/07-ai-grading/ci/lint-no-ambient-claude.ts enforces this.
// grep -r "claude\|anthropic" modules/09-scoring/** must return zero hits.
//
// Archetype labels are L&D coaching tools, NOT hiring/firing proxies. They
// must always be paired with admin.scoring.archetype.disclaimer in the UI.

import type { ArchetypeLabel, ArchetypeSignals, CohortPercentiles } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers — numeric utilities
// ---------------------------------------------------------------------------

/** Sort and return a copy; does not mutate. */
function sortedCopy(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

/** Linear-interpolation percentile (0..100). Returns 0 for empty arrays. */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = sortedCopy(arr);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (idx - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Interquartile range (Q3 − Q1). */
function iqr(arr: number[]): number {
  return percentile(arr, 75) - percentile(arr, 25);
}

// ---------------------------------------------------------------------------
// SignalsInput — data passed from the service layer into computeSignals
// ---------------------------------------------------------------------------

export interface SignalsInput {
  /** Per-answer timing + edit data from attempt_answers. */
  answers: Array<{ time_spent_seconds: number; edits_count: number }>;
  /** All rows from attempt_events for this attempt. */
  events: Array<{ event_type: string; at: Date }>;
  /** Latest grading per question (override-last). Only AI-graded types
   *  carry non-null reasoning_band. */
  gradings: Array<{
    reasoning_band: number | null;
    error_class: string | null;
  }>;
  /** True iff attempts.status = 'auto_submitted'. */
  autoSubmitted: boolean;
}

// ---------------------------------------------------------------------------
// computeSignals — pure function, no IO
// ---------------------------------------------------------------------------

export function computeSignals(input: SignalsInput): ArchetypeSignals {
  const { answers, events, gradings, autoSubmitted } = input;

  // Per-question time
  const timesMs = answers.map((a) => (a.time_spent_seconds ?? 0) * 1000);
  const time_per_question_p50_ms = percentile(timesMs, 50);
  const time_per_question_iqr_ms = iqr(timesMs);

  // Edit count total
  const edit_count_total = answers.reduce((s, a) => s + (a.edits_count ?? 0), 0);

  // Flag count (from flag events — each distinct flag event counts once)
  const flag_count = events.filter((e) => e.event_type === "flag").length;

  // Multi-tab conflict
  const multi_tab_conflict_count = events.filter(
    (e) => e.event_type === "multi_tab_conflict",
  ).length;

  // Tab blur
  const tab_blur_count = events.filter(
    (e) => e.event_type === "tab_blur",
  ).length;

  // Copy + paste combined
  const copy_paste_count = events.filter(
    (e) => e.event_type === "copy" || e.event_type === "paste",
  ).length;

  // Reasoning band (subjective / AI-graded only — null band = deterministic question)
  const bands = gradings
    .map((g) => g.reasoning_band)
    .filter((b): b is number => b !== null && b !== undefined);

  const reasoning_band_avg =
    bands.length > 0
      ? bands.reduce((s, b) => s + b, 0) / bands.length
      : null;

  const reasoning_band_distribution: ArchetypeSignals["reasoning_band_distribution"] =
    { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
  for (const b of bands) {
    const key = String(b) as "0" | "1" | "2" | "3" | "4";
    reasoning_band_distribution[key] = (reasoning_band_distribution[key] ?? 0) + 1;
  }

  // Error class counts (non-null only)
  const error_class_counts: Record<string, number> = {};
  for (const g of gradings) {
    if (g.error_class != null) {
      error_class_counts[g.error_class] =
        (error_class_counts[g.error_class] ?? 0) + 1;
    }
  }

  return {
    time_per_question_p50_ms,
    time_per_question_iqr_ms,
    edit_count_total,
    flag_count,
    multi_tab_conflict_count,
    tab_blur_count,
    copy_paste_count,
    reasoning_band_avg,
    reasoning_band_distribution,
    error_class_counts,
    auto_submitted: autoSubmitted,
  };
}

// ---------------------------------------------------------------------------
// DeriveArchetypeInput — passed by the service after it fetches cohort data
// ---------------------------------------------------------------------------

export interface DeriveArchetypeInput {
  signals: ArchetypeSignals;
  /** total_earned / total_max as 0..1 (not 0..100). */
  totalPct: number;
  /**
   * MCQ-only score fraction (0..1). null when the attempt has no MCQ questions
   * (and thus no deterministic grading rows).
   */
  mcqPct: number | null;
  /**
   * Fraction of questions answered in the first third of the attempt duration.
   * null when timing data is insufficient (no started_at / duration_seconds).
   */
  lastMinuteFraction: number | null;
  /**
   * Cohort percentile thresholds derived from previously stored attempt_scores
   * for the same assessment_id. null when fewer than 2 prior scored attempts
   * exist — in that case archetype returns null ("not enough cohort data yet").
   */
  cohortPercentiles: CohortPercentiles | null;
}

// ---------------------------------------------------------------------------
// deriveArchetype — pure classification, no IO
//
// Rule priority: first rule that matches wins. null = no cohort data or no
// rule matched.
// ---------------------------------------------------------------------------

export function deriveArchetype(
  input: DeriveArchetypeInput,
): { archetype: ArchetypeLabel | null } {
  const { signals, totalPct, mcqPct, lastMinuteFraction, cohortPercentiles } = input;

  // Not enough cohort data → cannot apply relative thresholds
  if (cohortPercentiles === null) {
    return { archetype: null };
  }

  const {
    time_p25_ms,
    time_p75_ms,
    edit_p25,
    edit_p75,
    iqr_p25_ms,
  } = cohortPercentiles;

  const { reasoning_band_avg } = signals;
  const bandAvg = reasoning_band_avg ?? 0;

  // 1. methodical_diligent — high time, high edits, high reasoning quality
  if (
    signals.time_per_question_p50_ms > time_p75_ms &&
    signals.edit_count_total > edit_p75 &&
    bandAvg > 3
  ) {
    return { archetype: "methodical_diligent" };
  }

  // 2. confident_correct — fast, few edits, high score
  if (
    signals.time_per_question_p50_ms < time_p25_ms &&
    signals.edit_count_total < edit_p25 &&
    totalPct > 0.85
  ) {
    return { archetype: "confident_correct" };
  }

  // 3. confident_wrong — fast, few edits, low score (overconfidence)
  if (
    signals.time_per_question_p50_ms < time_p25_ms &&
    signals.edit_count_total < edit_p25 &&
    totalPct < 0.5
  ) {
    return { archetype: "confident_wrong" };
  }

  // 4. cautious_uncertain — high time, many flags, mid reasoning
  if (
    signals.time_per_question_p50_ms > time_p75_ms &&
    signals.flag_count > 3 &&
    bandAvg >= 1.5 &&
    bandAvg <= 2.5
  ) {
    return { archetype: "cautious_uncertain" };
  }

  // 5. last_minute_rusher — answered <30% of questions in the first third of
  //    attempt time (burst at end pattern)
  if (lastMinuteFraction !== null && lastMinuteFraction < 0.3) {
    return { archetype: "last_minute_rusher" };
  }

  // 6. even_pacer — consistent pacing (IQR below the cohort's p25 IQR)
  if (signals.time_per_question_iqr_ms < iqr_p25_ms) {
    return { archetype: "even_pacer" };
  }

  // 7. pattern_matcher — high MCQ score, low reasoning quality (knows facts,
  //    can't reason through subjective questions)
  if (mcqPct !== null && mcqPct > 0.85 && bandAvg < 2) {
    return { archetype: "pattern_matcher" };
  }

  // 8. deep_reasoner — moderate MCQ score, high subjective reasoning quality
  if (mcqPct !== null && bandAvg > 3 && mcqPct >= 0.5 && mcqPct <= 0.85) {
    return { archetype: "deep_reasoner" };
  }

  // No rule matched — return null (still stores signals for future analysis)
  return { archetype: null };
}

// ---------------------------------------------------------------------------
// computeLastMinuteFraction
//
// Returns the fraction of answer_save events that occurred in the FIRST third
// of the attempt's duration. A value < 0.3 means fewer than 30% of answers
// were saved in the first third → "last minute rusher" pattern.
//
// Returns null when timing data is unavailable.
// ---------------------------------------------------------------------------

export function computeLastMinuteFraction(
  answerSaveEvents: Array<{ at: Date }>,
  startedAt: Date | null,
  durationSeconds: number | null,
): number | null {
  if (
    startedAt === null ||
    durationSeconds === null ||
    durationSeconds <= 0 ||
    answerSaveEvents.length === 0
  ) {
    return null;
  }

  const thirdCutoffMs =
    startedAt.getTime() + (durationSeconds / 3) * 1000;
  const total = answerSaveEvents.length;
  const inFirstThird = answerSaveEvents.filter(
    (e) => e.at.getTime() < thirdCutoffMs,
  ).length;

  return inFirstThird / total;
}
