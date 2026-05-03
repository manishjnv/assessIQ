// AssessIQ — modules/09-scoring service layer.
//
// Phase 2 G2.B Session 3.
//
// Public surface (pinned for 10-admin-dashboard consumption):
//   computeAttemptScore(tenantId, attemptId) → AttemptScore   (idempotent)
//   recomputeOnOverride(tenantId, attemptId) → AttemptScore   (same, different callsite)
//   cohortStats(tenantId, assessmentId)      → CohortStats
//   leaderboard(tenantId, assessmentId, opts) → LeaderboardRow[]  (admin-only, P2.D13)
//   getAttemptScoreRow(tenantId, attemptId)  → AttemptScore | null
//   individualReport(tenantId, userId)       → IndividualScore[]
//
// INVARIANTS:
//   - No AI calls. Archetype is deterministic signal aggregation.
//   - No WHERE tenant_id = $1. RLS enforces isolation.
//   - computeAttemptScore is idempotent: UPSERT on attempt_id PK.

import { withTenant } from "@assessiq/tenancy";
import { AppError } from "@assessiq/core";
import {
  computeSignals,
  deriveArchetype,
  computeLastMinuteFraction,
} from "./archetype.js";
import * as repo from "./repository.js";
import type {
  AttemptScore,
  CohortStats,
  LeaderboardRow,
  IndividualScore,
} from "./types.js";

// ---------------------------------------------------------------------------
// computeAttemptScore — main rollup writer
// ---------------------------------------------------------------------------

export async function computeAttemptScore(
  tenantId: string,
  attemptId: string,
): Promise<AttemptScore> {
  return withTenant(tenantId, async (client) => {
    // 1. Fetch attempt metadata (status + timing + assessment linkage)
    const attemptRow = await repo.getAttempt(client, attemptId);
    if (attemptRow === null) {
      throw new AppError(
        `attempt ${attemptId} not found`,
        "SCORING_ATTEMPT_NOT_FOUND",
        404,
      );
    }

    // 2. Fetch all gradings (latest per question)
    const gradings = await repo.getGradingsForAttempt(client, attemptId);

    // 3. Score aggregation
    const totalEarned = gradings.reduce((s, g) => s + g.score_earned, 0);
    const totalMax = gradings.reduce((s, g) => s + g.score_max, 0);
    const autoPct =
      totalMax > 0 ? parseFloat(((totalEarned / totalMax) * 100).toFixed(2)) : 0;
    const pendingReview = gradings.some((g) => g.status === "review_needed");

    // 4. Behavioral signals from answers + events
    const answers = await repo.getAttemptAnswers(client, attemptId);
    const events = await repo.getAttemptEvents(client, attemptId);

    const signals = computeSignals({
      answers,
      events,
      gradings,
      autoSubmitted: attemptRow.status === "auto_submitted",
    });

    // 5. MCQ fraction for archetype rules (pattern_matcher / deep_reasoner)
    const mcqGradings = gradings.filter((g) => g.question_type === "mcq");
    const mcqEarned = mcqGradings.reduce((s, g) => s + g.score_earned, 0);
    const mcqMax = mcqGradings.reduce((s, g) => s + g.score_max, 0);
    const mcqPct = mcqMax > 0 ? mcqEarned / mcqMax : null;

    // 6. Last-minute fraction from answer_save event timestamps
    const saveEvents = events
      .filter((e) => e.event_type === "answer_save")
      .map((e) => ({ at: e.at }));
    const lastMinuteFraction = computeLastMinuteFraction(
      saveEvents,
      attemptRow.started_at,
      attemptRow.duration_seconds,
    );

    // 7. Cohort percentiles for archetype thresholds
    const cohortPercentiles = await repo.getCohortPercentiles(
      client,
      attemptRow.assessment_id,
      attemptId,
    );

    // 8. Derive archetype label
    const { archetype } = deriveArchetype({
      signals,
      totalPct: totalMax > 0 ? totalEarned / totalMax : 0,
      mcqPct,
      lastMinuteFraction,
      cohortPercentiles,
    });

    // 9. Upsert the score row
    const scoreRow = await repo.upsertAttemptScore(client, {
      attempt_id: attemptId,
      tenant_id: tenantId,
      total_earned: totalEarned,
      total_max: totalMax,
      auto_pct: autoPct,
      pending_review: pendingReview,
      archetype,
      archetype_signals: signals,
    });

    return scoreRow;
  });
}

// ---------------------------------------------------------------------------
// recomputeOnOverride — same as computeAttemptScore; separate export so
// callers can distinguish why a recompute is happening (override vs initial).
// ---------------------------------------------------------------------------

export async function recomputeOnOverride(
  tenantId: string,
  attemptId: string,
): Promise<AttemptScore> {
  return computeAttemptScore(tenantId, attemptId);
}

// ---------------------------------------------------------------------------
// getAttemptScoreRow — fetch existing score row (null if not yet computed)
// ---------------------------------------------------------------------------

export async function getAttemptScoreRow(
  tenantId: string,
  attemptId: string,
): Promise<AttemptScore | null> {
  return withTenant(tenantId, (client) =>
    repo.getAttemptScore(client, attemptId),
  );
}

// ---------------------------------------------------------------------------
// cohortStats — aggregate statistics for all scored attempts in an assessment
// ---------------------------------------------------------------------------

export async function cohortStats(
  tenantId: string,
  assessmentId: string,
): Promise<CohortStats> {
  return withTenant(tenantId, (client) =>
    repo.getCohortStats(client, assessmentId),
  );
}

// ---------------------------------------------------------------------------
// leaderboard — tenant-private, admin-only (P2.D13). Returns top-N by score.
//
// DPDP note: public-facing cross-tenant leaderboards are deferred to Phase 3+
// with an explicit DPDP / data-residency review. This is admin-only.
// ---------------------------------------------------------------------------

export async function leaderboard(
  tenantId: string,
  assessmentId: string,
  opts: { topN?: number; anonymize?: boolean } = {},
): Promise<LeaderboardRow[]> {
  const topN = opts.topN ?? 10;
  const anonymize = opts.anonymize ?? false;

  if (topN < 1 || topN > 200) {
    throw new AppError(
      "topN must be between 1 and 200",
      "SCORING_INVALID_TOPN",
      400,
    );
  }

  return withTenant(tenantId, (client) =>
    repo.getLeaderboard(client, assessmentId, { topN, anonymize }),
  );
}

// ---------------------------------------------------------------------------
// individualReport — sequence of AttemptScore rows for a given user
// ---------------------------------------------------------------------------

export async function individualReport(
  tenantId: string,
  userId: string,
): Promise<IndividualScore[]> {
  return withTenant(tenantId, (client) =>
    repo.getIndividualScores(client, userId),
  );
}
