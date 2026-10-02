/**
 * Handler: POST /admin/gradings/:gradingId/override
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D4 — Override row inherits prompt_version_sha/label/model from original,
 *        documenting which AI version was overridden.
 *   D8 — Auditable AI invariant: NEVER UPDATE an existing gradings row.
 *        INSERT a new row with grader='admin_override', override_of=original.id.
 *        The original AI row is untouched and auditable forever.
 *
 * Auth note (D8 / compliance frame):
 *   Fresh-MFA gating (maxAge: 5min) is the route layer's responsibility.
 *   This handler does NOT re-check MFA — it trusts the route-layer middleware
 *   (`requireFreshMfa`) has already validated the session.
 *
 * escalation_chosen_stage for overrides:
 *   Always 'manual' — the admin is the "stage" for this row.
 */

import { AppError, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import {
  findGradingById,
  insertGrading,
  isAttemptCandidateErased,
} from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingsRow } from "../types.js";
import type { PoolClient } from "pg";
import { auditInTx } from "@assessiq/audit-log";
import { computeAttemptScoreInTx, finalizeAttemptIfComplete } from "@assessiq/scoring";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminOverrideInput {
  tenantId: string;
  userId: string;
  gradingId: string;
  override: {
    score_earned: number;
    reasoning_band?: number;
    ai_justification?: string;
    error_class?: string | null;
    /** Required free-form justification for the override. */
    reason: string;
  };
  /**
   * When set, the grading being overridden must belong to this attempt (else 404
   * AIG_GRADING_NOT_FOUND). The platform evaluator's route has the attempt id in
   * the URL and passes it, so a stale or mismatched grading id can never override
   * a grade on a different attempt. The tenant's id-only route leaves it unset.
   */
  expectedAttemptId?: string;
  /**
   * TENANT callers pass true: a tenant may only override once the platform released
   * the evaluation to it (attempt 'graded' AND evaluation_released_at set) — else
   * 409 EVALUATION_NOT_RELEASED. The platform evaluator leaves it unset: its
   * overrides are part of the evaluation itself. The check runs under the attempt
   * row lock, so it cannot race a send-back.
   */
  requireEvaluationReleased?: boolean;
  /**
   * When this override completes the attempt (e.g. it resolves the last
   * review_needed grade), also hand it to the tenant (evaluation_released_at / _by)?
   * DEFAULT false (fail-closed) — see HandleAdminAcceptInput.markEvaluationReleased.
   */
  markEvaluationReleased?: boolean;
}

export interface HandleAdminOverrideOutput {
  /** The NEW override row — never the original. Route layer renders both alongside. */
  grading: GradingsRow;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminOverride(
  input: HandleAdminOverrideInput,
): Promise<HandleAdminOverrideOutput> {
  const { tenantId, userId, gradingId, override } = input;

  const grading = await withTenant(tenantId, async (client: PoolClient) => {
    // Load the original row — RLS ensures it belongs to this tenant
    const original = await findGradingById(client, gradingId);
    if (
      original === null ||
      (input.expectedAttemptId !== undefined && original.attempt_id !== input.expectedAttemptId)
    ) {
      throw new AppError(
        `Grading ${gradingId} not found`,
        AI_GRADING_ERROR_CODES.GRADING_NOT_FOUND,
        404,
      );
    }

    // Range guard: an override can only pick a score the question can award.
    // Unchecked, a negative or oversized value flows straight into the attempt
    // rollup and from there into the published percentage, pass/fail and
    // certificate tier. gradings rows are insert-only, so original.score_max is
    // immutable and this needs no lock.
    if (
      !Number.isFinite(override.score_earned) ||
      override.score_earned < 0 ||
      override.score_earned > original.score_max
    ) {
      throw new AppError(
        `score_earned must be between 0 and ${original.score_max}`,
        AI_GRADING_ERROR_CODES.INVALID_BODY,
        422,
        { details: { score_max: original.score_max } },
      );
    }

    // Published results are final (SP1): once the attempt is 'released' the
    // candidate may already have seen the score, so it can no longer change.
    // The row lock also serialises this override against a concurrent release
    // (release takes the same FOR UPDATE lock), so an override can never land
    // after the release commit.
    const attemptRes = await client.query<{
      status: string;
      evaluation_released_at: Date | null;
    }>(
      `SELECT status, evaluation_released_at FROM attempts WHERE id = $1 FOR UPDATE`,
      [original.attempt_id],
    );
    const lockedAttempt = attemptRes.rows[0];
    if (lockedAttempt?.status === "released") {
      throw new AppError(
        "This result has already been published to the candidate and can no longer be changed",
        AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
        409,
      );
    }
    // E3: an erased candidate's grades are frozen (users.erased_at).
    if (await isAttemptCandidateErased(client, original.attempt_id)) {
      throw new AppError("This candidate's data has been erased — scores can no longer be changed", "CANDIDATE_ERASED", 409);
    }
    // Phase II tenant gate: the evaluation must be with the tenant (released by the
    // platform) before the tenant may change a grade. Checked after the published
    // check so a released attempt keeps its RESULT_ALREADY_PUBLISHED answer.
    if (
      input.requireEvaluationReleased === true &&
      (lockedAttempt?.status !== "graded" || lockedAttempt.evaluation_released_at === null)
    ) {
      throw new AppError(
        "This result is still being evaluated by AssessIQ — you can override a score once the evaluation is released to you",
        AI_GRADING_ERROR_CODES.EVALUATION_NOT_RELEASED,
        409,
      );
    }

    // D8: INSERT a new row — NEVER UPDATE the original
    // The original row stays untouched as the auditable AI record.
    // Inherit prompt SHA metadata from the original so the audit trail
    // shows which AI version was overridden (D4).
    const newRow = await insertGrading(client, tenantId, {
      attempt_id: original.attempt_id,
      question_id: original.question_id,
      grader: "admin_override",
      score_earned: override.score_earned,
      score_max: original.score_max,
      // Override status uses the same band→status derivation:
      // score ratio determines correct/incorrect/partial for the override row.
      status: deriveOverrideStatus(override.score_earned, original.score_max),
      anchor_hits: original.anchor_hits, // preserve original anchors unless explicitly replaced
      reasoning_band: override.reasoning_band ?? original.reasoning_band,
      ai_justification: override.ai_justification ?? original.ai_justification,
      error_class:
        override.error_class !== undefined
          ? (override.error_class ?? null)
          : original.error_class,
      // D4: inherit SHA so the override row is traceable to the AI version it superseded
      prompt_version_sha: original.prompt_version_sha,
      prompt_version_label: original.prompt_version_label,
      model: original.model,
      // escalation_chosen_stage for admin overrides is always 'manual'
      escalation_chosen_stage: "manual",
      graded_by: userId,
      override_of: original.id,
      override_reason: override.reason,
    });

    // Keep the rollup truthful in the SAME tx (this is the previously
    // never-called recomputeOnOverride path): attempt_scores reflects the
    // override immediately, so the tenant review screen and the CSV never show
    // a stale total. Deliberately no second audit row — the override audit below
    // is the one row for this mutation; the derived rollup is recomputable.
    await computeAttemptScoreInTx(client, tenantId, original.attempt_id);

    // An override can be what completes the result (e.g. the platform evaluator
    // overrides a review_needed AI grade). Finalise if complete — no-op when the
    // attempt is already graded or still has pending questions. Whether the
    // evaluation is also handed to the tenant is the caller's decision (default
    // no); the platform route asks for it, and an erased candidate is never
    // handed over. An override on an already-'graded' attempt (a sent-back
    // re-evaluation) is never auto-released: that is the explicit release step.
    const handOver =
      input.markEvaluationReleased === true &&
      !(await isAttemptCandidateErased(client, original.attempt_id));
    const { finalized } = await finalizeAttemptIfComplete(client, {
      tenantId,
      attemptId: original.attempt_id,
      markEvaluationReleased: handOver,
      releasedBy: userId,
    });
    const released = finalized && handOver;

    // G3.D: audit inside the same tx so grading INSERT and audit_log INSERT
    // commit or roll back atomically (atomicity fix — was out-of-tx before G3.D).
    // Written AFTER the finalise so the row can record the hand-over
    // (`evaluation_released: true` only when this override completed the attempt
    // and released it — there is no separate audit row for that).
    //
    // PII policy (2026-05-13 follow-up, Sonnet review V8):
    //   override_reason is free-text admin input and may contain candidate
    //   PII, HR context, or sensitive business detail. The full text is
    //   preserved in gradings.override_reason (the immutable D8-INSERT row);
    //   the audit row carries IDs/scores/status but NOT the reason text.
    //   An auditor investigating "why was this overridden" pivots from
    //   audit_log.entity_id → gradings.id → reads the reason from the row.
    //   This keeps audit_log free of unbounded free-text PII while
    //   preserving forensic traceability through the FK chain.
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: userId,
      action: "grading.override",
      entityType: "grading",
      entityId: newRow.id,
      after: {
        new_grading_id: newRow.id,
        override_of: newRow.override_of,
        score_earned: newRow.score_earned,
        score_max: newRow.score_max,
        status: newRow.status,
        ...(released ? { evaluation_released: true } : {}),
        // override_reason intentionally OMITTED — see PII policy comment above.
      },
    });

    return newRow;
  });

  log.info(
    {
      gradingId: grading.id,
      overrideOf: grading.override_of,
      attemptId: grading.attempt_id,
      questionId: grading.question_id,
    },
    "grading.override.complete",
  );

  return { grading };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Band → status for an admin-authored score (also used by manual first score). */
export function deriveOverrideStatus(
  scoreEarned: number,
  scoreMax: number,
): GradingsRow["status"] {
  if (scoreMax === 0) return "review_needed";
  const ratio = scoreEarned / scoreMax;
  if (ratio >= 0.85) return "correct";
  if (ratio <= 0.15) return "incorrect";
  return "partial";
}
