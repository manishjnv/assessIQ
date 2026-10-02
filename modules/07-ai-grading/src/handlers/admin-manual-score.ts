/**
 * Handler: POST /admin/attempts/:attemptId/questions/:questionId/manual-score
 *
 * SP1 (2026-10-01) — "manual first score". A question that has NO grading yet
 * (typically KQL: there is no AI/deterministic grader for it) must be scored by a
 * human before the result can be complete (module 09 finalizeAttemptIfComplete).
 * This handler writes that first grade. NO AI call anywhere on this path.
 *
 * Decision references:
 *   D8 — INSERT a new gradings row, never UPDATE. grader='admin_override',
 *        override_of NULL (there is nothing to override), the free-text reason
 *        lives on the immutable row (gradings.override_reason), NOT in audit_log.
 *   Sentinels: prompt_version_sha/label 'manual:v1', model 'manual',
 *        escalation_chosen_stage 'manual' — same precedent as the deterministic
 *        MCQ rows (09 MCQ_SENTINEL_SHA).
 *
 * score_max is attempt_questions.points (frozen at attempt start): the same source the deterministic MCQ rows and
 * the AI-failure placeholder rows use, and the only source KQL has (no rubric).
 *
 * Auth: fresh-MFA gating is the route layer's responsibility, same as override.
 * Phase II (2026-10-01): the tenant route answers 403 AI_EVALUATION_BY_ASSESSIQ; this
 * handler is reached only from the platform evaluator's route (super admin, fresh
 * MFA), which runs it inside withTenant(<the attempt's tenant>).
 */

import { AppError, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { computeAttemptScoreInTx, finalizeAttemptIfComplete } from "@assessiq/scoring";
import { insertGrading, isAttemptCandidateErased } from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingsRow } from "../types.js";
import { deriveOverrideStatus } from "./admin-override.js";

const log = streamLogger("grading");

/** gradings.prompt_version_sha / _label for a human first score. */
export const MANUAL_SENTINEL_SHA = "manual:v1";
export const MANUAL_SENTINEL_MODEL = "manual";

export interface HandleAdminManualScoreInput {
  tenantId: string;
  userId: string;
  attemptId: string;
  questionId: string;
  scoreEarned: number;
  /** Free-form justification (1..500 chars, validated by the route). Stored on the row only. */
  reason: string;
  /**
   * When this score completes the attempt, also hand it to the tenant
   * (evaluation_released_at / _by)? DEFAULT false (fail-closed). The platform
   * evaluator's route passes true (see HandleAdminAcceptInput.markEvaluationReleased);
   * never applied to an erased candidate or an already-'graded' attempt.
   */
  markEvaluationReleased?: boolean;
}

export interface HandleAdminManualScoreOutput {
  /** The new grading row. */
  grading: GradingsRow;
  /** Attempt status after this score ('graded' when it completed the result). */
  attempt: { id: string; status: string };
}

const WRITABLE_STATUSES = new Set([
  "submitted",
  "auto_submitted",
  "pending_admin_grading",
  // Legacy attempts finalised before KQL joined the completion rule have a
  // question with no grade; allow scoring it (the rollup is recomputed).
  "graded",
]);

export async function handleAdminManualScore(
  input: HandleAdminManualScoreInput,
): Promise<HandleAdminManualScoreOutput> {
  const { tenantId, userId, attemptId, questionId, reason } = input;
  // NUMERIC(6,2) column: round here so the range check below sees the stored value.
  const scoreEarned = Math.round(input.scoreEarned * 100) / 100;

  const result = await withTenant(tenantId, async (client) => {
    // Row lock: serialises concurrent manual scores / overrides / releases on
    // this attempt, so "no existing grading" below cannot race into a 23505.
    const attemptRes = await client.query<{ status: string }>(
      `SELECT status FROM attempts WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
    const status = attemptRes.rows[0]?.status;
    if (status === undefined) {
      throw new AppError(
        `Attempt ${attemptId} not found`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
        404,
      );
    }
    // E3: an erased candidate's grades are frozen (users.erased_at).
    if (await isAttemptCandidateErased(client, attemptId)) {
      throw new AppError("This candidate's data has been erased — scores can no longer be changed", "CANDIDATE_ERASED", 409);
    }
    if (status === "released") {
      throw new AppError(
        "This result has already been published to the candidate and can no longer be changed",
        AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
        409,
      );
    }
    if (!WRITABLE_STATUSES.has(status)) {
      throw new AppError(
        `Attempt is in status '${status}' — it cannot be scored yet`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_GRADEABLE,
        422,
      );
    }

    // The question must be part of THIS attempt's frozen set (RLS does not
    // catch a same-tenant cross-attempt question id).
    const qRes = await client.query<{ points: number }>(
      `SELECT aq.points
         FROM attempt_questions aq
         JOIN questions q ON q.id = aq.question_id
        WHERE aq.attempt_id = $1 AND aq.question_id = $2`,
      [attemptId, questionId],
    );
    const scoreMax = qRes.rows[0]?.points;
    if (scoreMax === undefined) {
      throw new AppError(
        "question_id is not part of this attempt's frozen question set",
        AI_GRADING_ERROR_CODES.INVALID_BODY,
        422,
        { details: { attemptId, invalidQuestionId: questionId } },
      );
    }

    // A first score only: any existing grading (even a review_needed one) means
    // the question is graded — correct it with the override path instead.
    const existing = await client.query(
      `SELECT 1 FROM gradings WHERE attempt_id = $1 AND question_id = $2 LIMIT 1`,
      [attemptId, questionId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new AppError(
        "This question already has a grade — use override to change it",
        AI_GRADING_ERROR_CODES.QUESTION_ALREADY_GRADED,
        409,
      );
    }

    if (!Number.isFinite(scoreEarned) || scoreEarned < 0 || scoreEarned > scoreMax) {
      throw new AppError(
        `score_earned must be between 0 and ${scoreMax}`,
        AI_GRADING_ERROR_CODES.INVALID_BODY,
        422,
        { details: { score_max: scoreMax } },
      );
    }

    const grading = await insertGrading(client, tenantId, {
      attempt_id: attemptId,
      question_id: questionId,
      grader: "admin_override",
      score_earned: scoreEarned,
      score_max: scoreMax,
      status: deriveOverrideStatus(scoreEarned, scoreMax),
      anchor_hits: null,
      reasoning_band: null,
      ai_justification: null,
      error_class: null,
      prompt_version_sha: MANUAL_SENTINEL_SHA,
      prompt_version_label: MANUAL_SENTINEL_SHA,
      model: MANUAL_SENTINEL_MODEL,
      escalation_chosen_stage: "manual",
      graded_by: userId,
      override_of: null,
      override_reason: reason,
    });

    // Rollup first (truthful totals even when still incomplete), then finalise
    // if this was the last missing grade. Whether the evaluation is also handed
    // to the tenant is the caller's decision (default: no); the platform route
    // asks for it, and an erased candidate is never handed over.
    await computeAttemptScoreInTx(client, tenantId, attemptId);
    const handOver =
      input.markEvaluationReleased === true && !(await isAttemptCandidateErased(client, attemptId));
    const { finalized } = await finalizeAttemptIfComplete(client, {
      tenantId,
      attemptId,
      markEvaluationReleased: handOver,
      releasedBy: userId,
    });
    const released = finalized && handOver;

    // One audit row, same tx (written AFTER the finalise so it can record the
    // hand-over: `evaluation_released: true` only when this score completed the
    // attempt and released it — there is no separate audit row for that).
    // PII policy (same as override): the reason text is kept OUT of audit_log — it
    // lives on the immutable gradings row.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: userId,
      action: "grading.override",
      entityType: "grading",
      entityId: grading.id,
      after: {
        kind: "manual_first_score",
        attempt_id: attemptId,
        question_id: questionId,
        new_grading_id: grading.id,
        score_earned: grading.score_earned,
        score_max: grading.score_max,
        status: grading.status,
        ...(released ? { evaluation_released: true } : {}),
      },
    });

    return { grading, attempt: { id: attemptId, status: finalized ? "graded" : status } };
  });

  log.info(
    {
      attemptId,
      questionId,
      gradingId: result.grading.id,
      attemptStatusNow: result.attempt.status,
    },
    "grading.manual_score.complete",
  );

  return result;
}
