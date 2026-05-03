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
  attempt: { id: string; status: "graded" };
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
): GradingsRow["status"] {
  // AI runtime failure → admin must review manually
  if (
    typeof errorClass === "string" &&
    errorClass.startsWith("AIG_")
  ) {
    return "review_needed";
  }
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
): Promise<GradingsRow[]> {
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
      status: deriveStatus(scoreEarned, scoreMax, errorClass),
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

  // Idempotent attempt status update — only transitions from gradeable states
  await client.query(
    `UPDATE attempts
     SET status = 'graded'
     WHERE id = $1
       AND status IN ('submitted', 'pending_admin_grading')`,
    [attemptId],
  );

  return gradings;
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

  const gradings = await withTenant(tenantId, (client) =>
    acceptProposals(client, tenantId, userId, attemptId, proposals),
  );

  log.info(
    { attemptId, gradingCount: gradings.length },
    "grading.accept.complete",
  );

  return {
    gradings,
    attempt: { id: attemptId, status: "graded" },
  };
}
