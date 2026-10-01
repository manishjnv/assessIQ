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
    if (original === null) {
      throw new AppError(
        `Grading ${gradingId} not found`,
        AI_GRADING_ERROR_CODES.GRADING_NOT_FOUND,
        404,
      );
    }

    // Published results are final (SP1): once the attempt is 'released' the
    // candidate may already have seen the score, so it can no longer change.
    // The row lock also serialises this override against a concurrent release
    // (release takes the same FOR UPDATE lock), so an override can never land
    // after the release commit.
    const attemptRes = await client.query<{ status: string }>(
      `SELECT status FROM attempts WHERE id = $1 FOR UPDATE`,
      [original.attempt_id],
    );
    if (attemptRes.rows[0]?.status === "released") {
      throw new AppError(
        "This result has already been published to the candidate and can no longer be changed",
        AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
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

    // G3.D: audit inside the same tx so grading INSERT and audit_log INSERT
    // commit or roll back atomically (atomicity fix — was out-of-tx before G3.D).
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
        // override_reason intentionally OMITTED — see PII policy comment above.
      },
    });

    // Keep the rollup truthful in the SAME tx (this is the previously
    // never-called recomputeOnOverride path): attempt_scores reflects the
    // override immediately, so the tenant review screen and the CSV never show
    // a stale total. Deliberately no second audit row — the override audit above
    // is the one row for this mutation; the derived rollup is recomputable.
    await computeAttemptScoreInTx(client, tenantId, original.attempt_id);

    // An override can be what completes the result (e.g. the admin overrides a
    // review_needed AI grade). Finalise if complete — no-op when the attempt is
    // already graded or still has pending questions. Phase I: the tenant admin
    // is the evaluator, so evaluation is released to the tenant.
    await finalizeAttemptIfComplete(client, {
      tenantId,
      attemptId: original.attempt_id,
      markEvaluationReleased: true,
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
