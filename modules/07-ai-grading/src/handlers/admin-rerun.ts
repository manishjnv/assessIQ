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
 * Attempt-level re-evaluation (2026-10-01): on an already-'graded' attempt (the tenant
 * sent it back) this is the platform evaluator's "Re-run AI". It then behaves like
 * Grade all: the grading-in-progress marker (attempts.grading_started_at) is set for the
 * run and the returned proposals are cached on the attempt (attempts.ai_proposals), so
 * the evaluate page can poll progress and a proxy timeout loses nothing. On a pre-graded
 * attempt nothing of that applies — the per-question "Re-run (Opus)" helper keeps its
 * original, stateless behaviour. Either way NOTHING is committed here (D8): the
 * evaluator's accept writes the gradings rows.
 *
 * Cross-module SQL note: same as admin-grade.ts — inline SQL via withTenant,
 * no @assessiq/attempt-engine import (not in this package's dependencies).
 */

import { AppError, config, streamLogger } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import { gradeSubjective } from "../runtime-selector.js";
import { singleFlight } from "../single-flight.js";
import { resolveGradingRubric } from "./admin-grade.js";
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
  highStakes: boolean;
}> {
  const attemptResult = await client.query<{ status: string; high_stakes: boolean }>(
    `SELECT a.status, COALESCE(s.settings->>'high_stakes' = 'true', false) AS high_stakes
       FROM attempts a
       LEFT JOIN assessments s ON s.id = a.assessment_id
      WHERE a.id = $1 LIMIT 1`,
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
       aq.points,
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
    highStakes: attemptRow.high_stakes,
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

  // D7 — heartbeat: admin must have been active within the last 300s (5 min)
  if (
    sessionLastActivity === null ||
    Date.now() - sessionLastActivity.getTime() > 300_000
  ) {
    throw new AppError(
      "Your session was idle for more than 5 minutes — refresh the page to continue re-grading.",
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
  // True while this run holds the grading-in-progress marker (graded attempts only).
  let markerHeld = false;

  try {
    const { status, questions, answers, highStakes } = await withTenant(
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

    // Attempt-level re-evaluation of an already-graded (sent-back) attempt: mark the
    // run in progress exactly like Grade all, so the page shows the banner and polls,
    // and so the proposals survive a dropped response (cached below). A marker left
    // behind by a crash is treated as stalled by the page after 10 minutes.
    const reevaluation = status === "graded";
    if (reevaluation) {
      await withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE attempts SET grading_started_at = NOW() WHERE id = $1`,
          [attemptId],
        );
      });
      markerHeld = true;
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
          // Same rubric resolution as Grade all (synthesised / holistic fallback), so a
          // re-run does not fail on a question whose first pass was graded that way.
          rubric: resolveGradingRubric(q.type, q.content, q.rubric),
          answer,
          ...(input.forceEscalate === true ? { force_escalate: true } : {}),
          ...(highStakes ? { high_stakes: true } : {}),
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

    await withTenant(tenantId, async (client) => {
      if (reevaluation) {
        // Review cache + marker clear, atomically with the audit row (same as Grade all).
        // NOT a committed grade — the evaluator's accept is still required (D8).
        await client.query(
          `UPDATE attempts
              SET ai_proposals = $1::jsonb,
                  grading_started_at = NULL
            WHERE id = $2`,
          [JSON.stringify(proposals), attemptId],
        );
      }
      await auditInTx(client, {
        action: "grading.retry",
        actorKind: "user",
        actorUserId: input.userId,
        tenantId,
        entityType: "attempt",
        entityId: attemptId,
        after: {
          attempt_id: attemptId,
          question_count: questionCount,
          proposal_count: proposals.length,
          force_escalate: input.forceEscalate ?? false,
          duration_ms: durationMs,
        },
      });
    });
    markerHeld = false;

    return { proposals };
  } catch (err) {
    // Any failure while the marker is held must clear it, or the page's "grading in
    // progress" banner sticks on a run that is over. Best-effort — never mask the
    // original error.
    if (markerHeld) {
      try {
        await withTenant(tenantId, async (client) => {
          await client.query(
            `UPDATE attempts SET grading_started_at = NULL WHERE id = $1`,
            [attemptId],
          );
        });
      } catch (clearErr) {
        log.warn(
          { attemptId, err: (clearErr as Error).message },
          "grading.marker_clear_failed",
        );
      }
    }
    throw err;
  } finally {
    slot.release();
  }
}
