/**
 * Handler: POST /admin/attempts/:attemptId/rerun
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D1 — Mode check (claude-code-vps only).
 *   D3 — Manual re-trigger only; no auto-retry. Admin clicks "Re-run" to
 *        force a fresh grading pass after a previous failure or for escalation.
 *   D7 — Same heartbeat + single-flight gates as handleAdminGrade.
 *
 * Force-escalation contract:
 *   The `forceEscalate` flag is forwarded to the runtime via
 *   GradingInput.force_escalate (added in Session 1.b). When set, the
 *   claude-code-vps runtime skips the Stage-2 needs_escalation gate and
 *   always runs Stage 3 (grade-escalate skill / Opus). Returned proposals
 *   carry `escalation_chosen_stage: "3"` (or "manual" if Stage 2/3 disagree
 *   by ≥2 bands).
 *
 * Cross-module SQL note: same as admin-grade.ts — inline SQL via withTenant,
 * no @assessiq/attempt-engine import (not in this package's dependencies).
 */

import { AppError, config, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { gradeSubjective } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import type { GradingProposal } from "../types.js";
import type { PoolClient } from "pg";

const log = streamLogger("grading");

// ---------------------------------------------------------------------------
// Internal types (mirrors admin-grade.ts)
// ---------------------------------------------------------------------------

interface FrozenQuestionWithRubric {
  question_id: string;
  type: string;
  points: number;
  content: unknown;
  rubric: unknown;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminRerunInput {
  tenantId: string;
  userId: string;
  attemptId: string;
  sessionLastActivity: Date | null;
  /**
   * When true, every AI-gradeable question is sent through Stage 3
   * (grade-escalate skill / Opus) regardless of Stage 2's `needs_escalation`
   * flag. Live as of Session 1.b: the runtime honors `GradingInput.force_escalate`
   * in `claude-code-vps.ts` (skips the Stage-2 escalation gate when set).
   * undefined = not set by caller (treated as false; standard automatic-escalation
   * behavior applies — Stage 3 fires only when Stage 2 self-flags).
   */
  forceEscalate?: boolean | undefined;
}

export interface HandleAdminRerunOutput {
  proposals: GradingProposal[];
}

// ---------------------------------------------------------------------------
// Helper — load attempt + questions + answers (same as admin-grade, DRY later)
// ---------------------------------------------------------------------------

const AI_GRADEABLE_TYPES = new Set(["subjective", "scenario", "log_analysis"]);

async function loadGradingData(
  client: PoolClient,
  attemptId: string,
): Promise<{
  status: string;
  questions: FrozenQuestionWithRubric[];
  answers: Map<string, unknown>;
}> {
  const attemptResult = await client.query<{ status: string }>(
    `SELECT status FROM attempts WHERE id = $1 LIMIT 1`,
    [attemptId],
  );
  const attemptRow = attemptResult.rows[0];
  if (attemptRow === undefined) {
    throw new AppError(
      "Attempt not found",
      AI_GRADING_ERROR_CODES.ATTEMPT_NOT_FOUND,
      404,
    );
  }

  const qResult = await client.query<FrozenQuestionWithRubric>(
    `SELECT
       aq.question_id,
       q.type,
       q.points,
       qv.content,
       qv.rubric
     FROM attempt_questions aq
     JOIN questions q ON q.id = aq.question_id
     JOIN question_versions qv
       ON qv.question_id = aq.question_id
      AND qv.version    = aq.question_version
     WHERE aq.attempt_id = $1
     ORDER BY aq.position ASC, aq.question_id ASC`,
    [attemptId],
  );

  const aResult = await client.query<{ question_id: string; answer: unknown | null }>(
    `SELECT question_id, answer FROM attempt_answers WHERE attempt_id = $1`,
    [attemptId],
  );
  const answers = new Map<string, unknown>(
    aResult.rows.map((r) => [r.question_id, r.answer]),
  );

  return {
    status: attemptRow.status,
    questions: qResult.rows,
    answers,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAdminRerun(
  input: HandleAdminRerunInput,
): Promise<HandleAdminRerunOutput> {
  const { tenantId, attemptId, sessionLastActivity } = input;

  // D1 — mode check
  if (config.AI_PIPELINE_MODE !== "claude-code-vps") {
    throw new AppError(
      "Phase 1 grading only available in claude-code-vps mode",
      AI_GRADING_ERROR_CODES.MODE_NOT_CLAUDE_CODE_VPS,
      503,
    );
  }

  // D7 — heartbeat
  if (
    sessionLastActivity === null ||
    Date.now() - sessionLastActivity.getTime() > 60_000
  ) {
    throw new AppError(
      "Session idle — refresh the page and re-confirm to re-run grading",
      AI_GRADING_ERROR_CODES.HEARTBEAT_STALE,
      409,
    );
  }

  // D7 — single-flight
  const slot = singleFlight.acquire(attemptId);
  if (slot.kind === "rejected") {
    throw new AppError(
      slot.reason === "same_attempt_in_flight"
        ? "Another grading on this attempt is already in progress"
        : "Another grading is currently in progress on this API process",
      AI_GRADING_ERROR_CODES.GRADING_IN_PROGRESS,
      409,
    );
  }

  const startMs = Date.now();

  try {
    const { status, questions, answers } = await withTenant(
      tenantId,
      (client) => loadGradingData(client, attemptId),
    );

    // Re-run is valid on any non-terminal grading status
    if (
      status !== "submitted" &&
      status !== "pending_admin_grading" &&
      status !== "graded"
    ) {
      throw new AppError(
        `Attempt status '${status}' does not support re-grading`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_GRADEABLE,
        422,
      );
    }

    const proposals: GradingProposal[] = [];
    let questionCount = 0;

    for (const q of questions) {
      if (!AI_GRADEABLE_TYPES.has(q.type)) continue;
      questionCount++;

      const answer = answers.get(q.question_id) ?? null;

      try {
        // exactOptionalPropertyTypes: build the input with conditional
        // key assignment so we don't pass `force_escalate: undefined` to
        // a `force_escalate?: boolean` field.
        const gradingInput: import("../types.js").GradingInput = {
          attempt_id: attemptId,
          question_id: q.question_id,
          question_content: q.content,
          rubric: q.rubric,
          answer,
          ...(input.forceEscalate === true ? { force_escalate: true } : {}),
        };
        const proposal = await gradeSubjective(gradingInput);
        proposals.push(proposal);
      } catch (err) {
        const errorClass =
          err instanceof AppError
            ? err.code
            : AI_GRADING_ERROR_CODES.RUNTIME_FAILURE;

        log.warn(
          { attemptId, questionId: q.question_id, errorClass },
          "grading.rerun.question_failure",
        );

        const failedProposal: GradingProposal = {
          attempt_id: attemptId,
          question_id: q.question_id,
          anchors: [],
          band: {
            reasoning_band: 0,
            ai_justification: "",
            error_class: errorClass,
            needs_escalation: false,
          },
          score_earned: 0,
          score_max: q.points,
          prompt_version_sha: "error:no-sha",
          prompt_version_label: "error",
          model: "none",
          escalation_chosen_stage: null,
          generated_at: new Date().toISOString(),
        };
        proposals.push(failedProposal);
      }
    }

    const durationMs = Date.now() - startMs;
    log.info(
      {
        attemptId,
        questionCount,
        proposalCount: proposals.length,
        durationMs,
        forceEscalate: input.forceEscalate ?? false,
      },
      "grading.rerun.batch",
    );

    return { proposals };
  } finally {
    slot.release();
  }
}
