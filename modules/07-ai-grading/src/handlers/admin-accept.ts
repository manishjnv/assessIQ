/**
 * Handler: POST /admin/attempts/:attemptId/accept
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D7 — Idempotency: findGradingByIdempotencyKey before insertGrading.
 *   D8 — "Accept before commit" invariant: this handler is the only place
 *        that writes gradings rows for AI proposals. The admin's click to
 *        accept is the human-in-the-loop confirmation required by the
 *        compliance frame (docs/05-ai-pipeline.md § "Phase 1 — Compliance frame").
 *
 * Band → status mapping (0/25/50/75/100 band scoring per CLAUDE.md rule #4):
 *   score_earned / score_max >= 0.85 → "correct"
 *   score_earned / score_max <= 0.15 → "incorrect"
 *   otherwise                        → "partial"
 *   If score_max == 0 or proposal has error_class → "review_needed"
 */

import { withTenant } from "@assessiq/tenancy";
import {
  findGradingByIdempotencyKey,
  insertGrading,
} from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { AppError, streamLogger } from "@assessiq/core";
import type { AnchorFinding, GradingProposal, GradingsRow } from "../types.js";
import type { PoolClient } from "pg";
import { computeAttemptScore } from "@assessiq/scoring";
import { auditInTx } from "@assessiq/audit-log";
import { recordGradedAttempt } from "@assessiq/billing";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AcceptEdits {
  question_id?: string;
  reasoning_band?: number | undefined;
  ai_justification?: string | undefined;
  anchor_hits?: AnchorFinding[] | undefined;
  error_class?: string | null | undefined;
  score_earned?: number | undefined;
}

export interface HandleAdminAcceptInput {
  tenantId: string;
  userId: string;
  attemptId: string;
  /** Per-question accepted proposals; admin may have edited fields. */
  proposals: Array<GradingProposal & { edits?: AcceptEdits }>;
}

export interface HandleAdminAcceptOutput {
  gradings: GradingsRow[];
  /**
   * Phase 2 completion-gate (2026-05-28): `status` is now `"graded"` only when
   * every AI-gradeable question (subjective | scenario | log_analysis) has a
   * non-overridden gradings row. Partial accepts return
   * `"pending_admin_grading"` so the attempt is NOT marked complete until
   * every AI-failure is re-run or overridden.
   */
  attempt: { id: string; status: "graded" | "pending_admin_grading" };
}

// ---------------------------------------------------------------------------
// Helper — derive status from score ratio
// ---------------------------------------------------------------------------

/**
 * Per Phase 3 critique H2: `error_class` is dual-namespace.
 *
 * AI runtime failures emit `AIG_*` codes (from AI_GRADING_ERROR_CODES) into
 * the placeholder proposal — those mean "no real verdict, admin must review".
 * Legitimate rubric error_classes (`missed_pivot_to_identity`,
 * `over_escalation`, etc — the catalog Stage-2 picks from) are a NORMAL part
 * of any band 0-3 verdict and should NOT flip the row to review_needed.
 *
 * Score-ratio derivation handles legitimate verdicts; AIG_* prefix is the
 * runtime-failure escape hatch.
 */
function deriveStatus(
  scoreEarned: number,
  scoreMax: number,
  errorClass: string | null | undefined,
  escalationChosenStage?: "2" | "3" | "manual" | null,
): GradingsRow["status"] {
  // AI runtime failure → admin must review manually
  if (
    typeof errorClass === "string" &&
    errorClass.startsWith("AIG_")
  ) {
    return "review_needed";
  }
  // Two-model vote disagreed by ≥2 bands (B / feature #3): the runtime tagged
  // escalation_chosen_stage='manual' and kept Stage 2's band as primary WITHOUT
  // picking a winner — the admin must adjudicate. Route to review_needed so a
  // sharp Stage-2-vs-Stage-3 disagreement can never be swept through Accept-all
  // as a silently-committed verdict. (Stage 3 agreeing → '3'; no escalation →
  // '2'; both are legitimate auto-commits.)
  if (escalationChosenStage === "manual") return "review_needed";
  // Score column missing/zero → admin must review manually
  if (scoreMax === 0) return "review_needed";
  const ratio = scoreEarned / scoreMax;
  if (ratio >= 0.85) return "correct";
  if (ratio <= 0.15) return "incorrect";
  return "partial";
}

// ---------------------------------------------------------------------------
// Core work — runs inside withTenant
// ---------------------------------------------------------------------------

async function acceptProposals(
  client: PoolClient,
  tenantId: string,
  userId: string,
  attemptId: string,
  proposals: HandleAdminAcceptInput["proposals"],
): Promise<{ gradings: GradingsRow[]; flipped: boolean }> {
  // Phase 3 critique #3 (sonnet rescue): validate each proposal.question_id
  // belongs to this attempt's frozen question set. Without this guard, an
  // admin could submit a body with a question_id from a different attempt
  // (within the same tenant) and the gradings row would be written with a
  // mismatched (attempt_id, question_id) pair. RLS scopes to tenant; there
  // is no FK from gradings.question_id to attempt_questions(attempt_id,
  // question_id). The pre-loop query is the integrity check.
  const validQuestions = await client.query<{ question_id: string }>(
    `SELECT question_id FROM attempt_questions WHERE attempt_id = $1`,
    [attemptId],
  );
  const validIds = new Set(validQuestions.rows.map((r) => r.question_id));
  for (const p of proposals) {
    if (!validIds.has(p.question_id)) {
      throw new AppError(
        "proposal.question_id is not part of this attempt's frozen question set",
        AI_GRADING_ERROR_CODES.INVALID_BODY,
        422,
        {
          details: {
            attemptId,
            invalidQuestionId: p.question_id,
          },
        },
      );
    }
  }

  const gradings: GradingsRow[] = [];

  for (const proposal of proposals) {
    const edits = proposal.edits;

    // D7 idempotency: skip insert if row already exists for this key
    const existing = await findGradingByIdempotencyKey(
      client,
      proposal.attempt_id,
      proposal.question_id,
      proposal.prompt_version_sha,
    );
    if (existing !== null) {
      log.info(
        {
          attemptId,
          questionId: proposal.question_id,
          gradingId: existing.id,
        },
        "grading.accept.idempotent_skip",
      );
      gradings.push(existing);
      continue;
    }

    const scoreEarned = edits?.score_earned ?? proposal.score_earned;
    const scoreMax = proposal.score_max;
    const errorClass =
      edits !== undefined && "error_class" in edits
        ? (edits.error_class ?? null)
        : (proposal.band.error_class ?? null);

    const grading = await insertGrading(client, tenantId, {
      attempt_id: proposal.attempt_id,
      question_id: proposal.question_id,
      grader: "ai",
      score_earned: scoreEarned,
      score_max: scoreMax,
      status: deriveStatus(scoreEarned, scoreMax, errorClass, proposal.escalation_chosen_stage),
      anchor_hits: edits?.anchor_hits ?? proposal.anchors,
      reasoning_band: edits?.reasoning_band ?? proposal.band.reasoning_band,
      ai_justification: edits?.ai_justification ?? proposal.band.ai_justification,
      error_class: errorClass,
      prompt_version_sha: proposal.prompt_version_sha,
      prompt_version_label: proposal.prompt_version_label,
      model: proposal.model,
      escalation_chosen_stage: proposal.escalation_chosen_stage,
      graded_by: userId,
      override_of: null,
      override_reason: null,
    });

    gradings.push(grading);
  }

  // Phase 2 completion-gate (2026-05-28, Bug A fix):
  // Flip `attempts.status` to 'graded' ONLY when every AI-gradeable question
  // (subjective | scenario | log_analysis) has a non-overridden gradings row.
  // MCQ/KQL are scored deterministically by module 09 (computeAttemptScore)
  // and produce NO gradings row, so they are excluded from the denominator.
  //
  // Previously: any single accept flipped status='graded' + fired billing,
  // even when N-1 of N questions were still pending. With Accept-all skipping
  // AI-failures (Phase 1 FE), this meant a single accepted question silently
  // claimed the whole attempt was done. Revenue-leak invariant
  // (memory: billing-events-grade-commit-critical-path) requires billing be
  // tied to a TRUE completion, not a partial one — so billing now fires
  // ONLY when the gate actually transitions the row.
  const flipResult = await client.query<{ id: string }>(
    `UPDATE attempts
        SET status = 'graded'
      WHERE id = $1
        AND status IN ('submitted', 'pending_admin_grading')
        AND (
          SELECT COUNT(*)
            FROM attempt_questions aq
            JOIN questions q ON q.id = aq.question_id
           WHERE aq.attempt_id = $1
             AND q.type IN ('subjective', 'scenario', 'log_analysis')
        ) = (
          SELECT COUNT(DISTINCT g.question_id)
            FROM gradings g
           WHERE g.attempt_id = $1
             AND g.override_of IS NULL
             AND g.grader IN ('ai', 'admin_override')
        )
      RETURNING id`,
    [attemptId],
  );
  const flipped = (flipResult.rowCount ?? 0) > 0;

  // One summary audit row for the whole accept batch (mirrors
  // help.content.imported precedent — N inserts, one audit row summarising
  // the batch). `attempt_status_now` reflects the actual post-gate state so
  // partial accepts are honestly recorded as `pending_admin_grading`.
  await auditInTx(client, {
    action: "grading.accepted",
    actorKind: "user",
    actorUserId: userId,
    tenantId,
    entityType: "attempt",
    entityId: attemptId,
    after: {
      attempt_id: attemptId,
      grading_count: gradings.length,
      grading_ids: gradings.map((g) => g.id).slice(0, 50),
      attempt_status_now: flipped ? "graded" : "pending_admin_grading",
    },
  });

  // Revenue metering — fires ONLY on the actual transition to 'graded', NOT
  // on partial accepts. Same transaction as the grade commit (auditInTx
  // same-tx invariant). Idempotent via UNIQUE(tenant_id,attempt_id); any
  // non-conflict db error rolls back the grade too (revenue-leak invariant).
  if (flipped) {
    await recordGradedAttempt(client, tenantId, attemptId);

    // Phase 2 cache (2026-05-29 Bug A robustness): clear the proposals
    // cache once the gate flips — the proposals now live in the gradings
    // table where they belong. Same transaction as the status flip so
    // either both happen or neither does. attempts.grading_started_at is
    // already null at this point (cleared by admin-grade.ts at batch
    // completion); we null it again defensively in case a partial state
    // ever leaks in.
    await client.query(
      `UPDATE attempts
          SET ai_proposals = NULL,
              grading_started_at = NULL
        WHERE id = $1`,
      [attemptId],
    );
  }

  return { gradings, flipped };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminAccept(
  input: HandleAdminAcceptInput,
): Promise<HandleAdminAcceptOutput> {
  const { tenantId, userId, attemptId, proposals } = input;

  if (proposals.length === 0) {
    throw new AppError(
      "proposals array must not be empty",
      AI_GRADING_ERROR_CODES.INVALID_BODY,
      422,
    );
  }

  const { gradings, flipped } = await withTenant(tenantId, (client) =>
    acceptProposals(client, tenantId, userId, attemptId, proposals),
  );

  log.info(
    {
      attemptId,
      gradingCount: gradings.length,
      attemptStatusFlipped: flipped,
    },
    "grading.accept.complete",
  );

  // Kick off scoring rollup. Idempotent (UPSERT) and meaningful even on
  // partial accepts (the scoring rollup updates running totals + sets
  // pending_review when not all questions are graded). Non-fatal: a scoring
  // failure must not roll back the already-committed gradings. Admin can
  // recompute via GET /api/admin/attempts/:id/score.
  try {
    await computeAttemptScore(tenantId, attemptId);
    log.info({ attemptId }, "grading.scoring.complete");
  } catch (scoringErr) {
    log.error({ attemptId, err: scoringErr }, "grading.scoring.error_after_accept");
  }

  return {
    gradings,
    attempt: {
      id: attemptId,
      status: flipped ? "graded" : "pending_admin_grading",
    },
  };
}
