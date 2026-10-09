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
  assertTenantAiEnabled,
  findGradingByIdempotencyKey,
  insertGrading,
  isAttemptCandidateErased,
  isProposalNewerThanGradings,
} from "../repository.js";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { AppError, streamLogger } from "@assessiq/core";
import type { AnchorFinding, GradingProposal, GradingsRow } from "../types.js";
import type { PoolClient } from "pg";
import { computeAttemptScoreInTx, finalizeAttemptIfComplete } from "@assessiq/scoring";
import { auditInTx } from "@assessiq/audit-log";
import { recordAiAnswerEvaluated } from "@assessiq/billing";

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
  /**
   * Phase II (platform evaluation queue): when this accept COMPLETES the attempt (the
   * flip pre-graded -> 'graded' in this very tx), also set attempts.evaluation_released_at
   * / _by ("the tenant may see and publish it")? DEFAULT false — fail-closed: a caller
   * that does not say so never hands an evaluation to the tenant. The platform
   * evaluator's route passes true (owner decision 2026-10-01: accepting the last grade
   * IS the review, no separate click); tenants cannot call this handler — the tenant
   * /accept route answers 403 AI_EVALUATION_BY_ASSESSIQ. Never applied to an erased
   * candidate, and never to an attempt that was already 'graded' (a sent-back attempt
   * is handed back with the explicit release-to-tenant step).
   */
  markEvaluationReleased?: boolean;
}

export interface HandleAdminAcceptOutput {
  gradings: GradingsRow[];
  /**
   * Completion gate (SP1, 2026-10-01): `status` is `"graded"` when EVERY frozen question
   * (all five types, incl. KQL) has a final, non-flagged grade (module 09
   * finalizeAttemptIfComplete) — or when the attempt already was 'graded' (a re-run
   * accepted on a sent-back result). Partial accepts — or accepts that leave a
   * review_needed grade / an ungraded KQL question — return `"pending_admin_grading"`
   * so the attempt is NOT marked complete until every AI-failure is re-run or
   * overridden and every KQL question is scored.
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
// Payload bounds
// ---------------------------------------------------------------------------

/**
 * Ceiling for one question's score_max. Real values are tiny (AI rubric totals are
 * <= 200, question points <= 10) and gradings.score_earned/score_max are
 * NUMERIC(6,2): a value >= 10^4 would surface as a 500 (numeric overflow), so it is
 * refused up front as a clean 422.
 */
const MAX_QUESTION_SCORE = 1000;

/**
 * The accept body is echoed back by the client (the proposal came from the review
 * cache / a previous /grade response), so nothing server-side ties its scores to
 * the rubric: an unchecked value flows into gradings, the attempt rollup and from
 * there the published percentage, pass/fail and certificate tier. Until accept is
 * bound to attempts.ai_proposals (Phase II: accept becomes super-admin only) every
 * score must at least be a sane number, for the proposal AND for an admin edit:
 * 0 < score_max <= 1000 and 0 <= score_earned <= score_max, all finite.
 * One bad proposal rejects the whole request (422) before any tx is opened.
 */
function assertScoresInRange(proposals: HandleAdminAcceptInput["proposals"]): void {
  for (const p of proposals) {
    const reject = (message: string): never => {
      throw new AppError(message, AI_GRADING_ERROR_CODES.INVALID_BODY, 422, {
        details: { question_id: p.question_id, score_max: p.score_max },
      });
    };
    if (!Number.isFinite(p.score_max) || p.score_max <= 0 || p.score_max > MAX_QUESTION_SCORE) {
      reject(`score_max must be greater than 0 and at most ${MAX_QUESTION_SCORE}`);
    }
    for (const earned of [p.score_earned, p.edits?.score_earned]) {
      if (earned !== undefined && (!Number.isFinite(earned) || earned < 0 || earned > p.score_max)) {
        reject(`score_earned must be between 0 and ${p.score_max}`);
      }
    }
  }
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
  markEvaluationReleased: boolean,
): Promise<{ gradings: GradingsRow[]; flipped: boolean; statusNow: "graded" | "pending_admin_grading" }> {
  // RW-7: re-check pause inside the write tx (pause may land during the AI call).
  // Accept only ever commits AI proposals (grader "ai"); manual score/override use other handlers.
  await assertTenantAiEnabled(client, tenantId);

  // Lock the attempt row FIRST — the same row lock Release (09), override and
  // manual-score take — so the lock order is always attempt row -> everything
  // else. Without it a Release could check "no flagged grade" and publish while
  // this accept is still inserting a review_needed grade (and the rollup that
  // follows would then change an already-published score). A published result is
  // final: refuse before a single row is written.
  const lock = await client.query<{ status: string }>(
    `SELECT status FROM attempts WHERE id = $1 FOR UPDATE`,
    [attemptId],
  );
  const attemptStatus = lock.rows[0]?.status;
  if (attemptStatus === undefined) {
    throw new AppError(
      `Attempt ${attemptId} not found`,
      AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
      404,
    );
  }
  if (attemptStatus === "released") {
    throw new AppError(
      "This result has already been published to the candidate and can no longer be changed",
      AI_GRADING_ERROR_CODES.RESULT_ALREADY_PUBLISHED,
      409,
    );
  }

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
    // Id of the same-SHA row a re-evaluation row supersedes (see below); null = a plain insert.
    let supersedes: string | null = null;
    if (existing !== null) {
      // Re-evaluation of an ALREADY-GRADED attempt (sent back by the tenant, then re-run):
      // an unchanged prompt SHA only means the prompts did not change — it does not make a
      // fresh AI pass a replay of the old one, and skipping it would silently drop the
      // re-run. A proposal generated AFTER the question's newest grading (any grader) is a
      // new verdict: write it as a NEW row (newest wins) that points at the same-SHA row it
      // supersedes — override_of keeps the D7 partial unique index satisfied. A proposal at
      // or before the newest grading is a replay (double click) or a stale tab and is
      // skipped exactly as before, so it can never overwrite a newer grade or an override.
      // Pre-graded attempts keep the plain D7 behaviour.
      if (
        attemptStatus === "graded" &&
        (await isProposalNewerThanGradings(client, attemptId, proposal.question_id, proposal.generated_at))
      ) {
        supersedes = existing.id;
      } else {
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
      override_of: supersedes,
      override_reason: null,
    });

    // FU-A4 (2026-10-06): second billing meter, one row per accepted AI
    // grading (tenant, attempt, question), in the SAME tx as the gradings
    // insert. Idempotent on re-accept; any db error rolls the accept back
    // (same revenue-leak rule as recordGradedAttempt in 09 finalize).
    await recordAiAnswerEvaluated(client, tenantId, proposal.attempt_id, proposal.question_id);

    gradings.push(grading);
  }

  // Completion gate (SP1, 2026-10-01 — replaces the 2026-05-28 Bug A gate).
  // The attempt is finalised (score rollup + status 'graded' + billing + review
  // cache cleared, ONE tx) only when EVERY frozen question — all five types,
  // including KQL — has a final, non-flagged grade (review_needed blocks).
  // That rule now lives in one place, module 09's finalizeAttemptIfComplete,
  // shared with deterministic MCQ scoring, override and manual scoring.
  //
  // Revenue-leak invariant (memory: billing-events-grade-commit-critical-path):
  // billing is tied to a TRUE completion, in the same tx as the flip; a partial
  // accept never bills. markEvaluationReleased comes from the caller (default
  // false). The platform evaluator's route passes true (owner decision 2026-10-01):
  // the accept that completes the evaluation also hands it to the tenant — same
  // statement as the flip, released_by = this admin — except for an erased
  // candidate, whose result is never handed over (same gate as release-to-tenant).
  // An attempt that was ALREADY 'graded' is not re-flipped by finalize, so a
  // sent-back re-evaluation is never auto-released: that is the explicit
  // release-to-tenant step.
  const handOver = markEvaluationReleased && !(await isAttemptCandidateErased(client, attemptId));
  const { finalized: flipped } = await finalizeAttemptIfComplete(client, {
    tenantId,
    attemptId,
    markEvaluationReleased: handOver,
    releasedBy: userId,
  });
  const released = flipped && handOver;
  const statusNow: "graded" | "pending_admin_grading" =
    flipped || attemptStatus === "graded" ? "graded" : "pending_admin_grading";

  // finalize rolls attempt_scores up only when it flips the status. Every other
  // accept (partial, or a re-run accepted on an already-'graded' result) rolls up
  // HERE — inside the attempt lock, in the same tx as the grade inserts — so
  // attempt_scores always matches the grades a concurrent Release will see. A
  // post-commit recompute left a window in which a Release could publish a stale
  // total (and a late recompute then changed a published score). A rollup error
  // now rolls the accept back, same as override and manual-score.
  if (!flipped) await computeAttemptScoreInTx(client, tenantId, attemptId);

  // One summary audit row for the whole accept batch (mirrors
  // help.content.imported precedent — N inserts, one audit row summarising
  // the batch). `attempt_status_now` reflects the actual post-gate state so
  // partial accepts are honestly recorded as `pending_admin_grading`. When THIS
  // accept completed the attempt and handed it to the tenant, the same row says so
  // (`evaluation_released: true`) — there is no separate release audit row for that
  // hand-over, so this is where an auditor finds it (actor = the releasing admin).
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
      attempt_status_now: statusNow,
      ...(released ? { evaluation_released: true } : {}),
    },
  });

  // Revenue metering + the Phase 2 proposals-cache clear (2026-05-29 Bug A
  // robustness) now happen inside finalizeAttemptIfComplete, in the same tx as
  // the status flip: either all of {flip, bill, cache clear} commit or none.

  return { gradings, flipped, statusNow };
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

  // The attempt row lock in acceptProposals is taken on `attemptId`, so every row
  // must be written to THAT attempt. The route already rejects a mismatch (400);
  // enforced here too so a direct caller can never lock one attempt and write
  // grades onto another (e.g. an already-published one).
  for (const p of proposals) {
    if (p.attempt_id !== attemptId) {
      throw new AppError(
        "proposal.attempt_id must match the attemptId",
        AI_GRADING_ERROR_CODES.INVALID_BODY,
        422,
        { details: { expected: attemptId, received: p.attempt_id } },
      );
    }
  }

  assertScoresInRange(proposals);

  const { gradings, flipped, statusNow } = await withTenant(tenantId, (client) =>
    acceptProposals(
      client,
      tenantId,
      userId,
      attemptId,
      proposals,
      input.markEvaluationReleased === true,
    ),
  );

  log.info(
    {
      attemptId,
      gradingCount: gradings.length,
      attemptStatusFlipped: flipped,
    },
    "grading.accept.complete",
  );

  // No post-commit rollup: attempt_scores was already written inside the accept
  // tx (finalizeAttemptIfComplete when it flipped, computeAttemptScoreInTx
  // otherwise — see acceptProposals).

  return {
    gradings,
    attempt: {
      id: attemptId,
      status: statusNow,
    },
  };
}
