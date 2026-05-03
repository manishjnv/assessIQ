/**
 * Handler: POST /admin/attempts/:attemptId/grade
 *
 * Phase 2 G2.A Session 1.b — service-layer handler (no Fastify req/reply).
 *
 * Decision references:
 *   D1 — AI_PIPELINE_MODE check; only "claude-code-vps" in Phase 1.
 *   D2 — Allowed call site for gradeSubjective (this file + runtimes/claude-code-vps.ts).
 *        NEVER import child_process here — the runtime does the spawning.
 *   D7 — Single-flight mutex: at most one grading subprocess per API process.
 *   D8 — Handler returns proposals; gradings rows are written only after admin
 *        accept (handleAdminAccept). "Accept before commit" is the compliance line.
 *
 * COMPLIANCE NOTE (D8):
 *   This handler does NOT write any gradings rows. It calls gradeSubjective()
 *   per question and collects GradingProposal objects. The admin reviews and
 *   accepts/edits via handleAdminAccept — only then do gradings rows appear.
 *
 * Cross-module SQL note:
 *   @assessiq/attempt-engine is NOT in this package's dependencies (would add
 *   a circular-ish coupling; the package.json intentionally omits it).
 *   Instead, we issue inline SQL JOINs here — withTenant() RLS still enforces
 *   tenancy. The join mirrors listFrozenQuestionsForAttempt in 06-attempt-engine
 *   but adds the rubric column (internal-only; candidates never see rubric).
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
// Internal types
// ---------------------------------------------------------------------------

interface FrozenQuestionWithRubric {
  question_id: string;
  position: number;
  question_version: number;
  type: string;
  topic: string;
  points: number;
  content: unknown;
  rubric: unknown;
}

interface AttemptAnswerRow {
  question_id: string;
  answer: unknown | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HandleAdminGradeInput {
  tenantId: string;
  userId: string;
  attemptId: string;
  /** From req.session — null if session has no activity timestamp. */
  sessionLastActivity: Date | null;
}

export interface HandleAdminGradeOutput {
  /**
   * One proposal per question that required AI grading (subjective + scenario).
   * MCQ and KQL are deterministic — graded elsewhere (module 09) — and are
   * excluded from the proposal batch.
   */
  proposals: GradingProposal[];
}

// ---------------------------------------------------------------------------
// Helper — load frozen questions WITH rubric (admin-only) and answers
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
  // 1. Attempt status
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

  // 2. Frozen questions with rubric — rubric exposed only for admin grading path
  const qResult = await client.query<FrozenQuestionWithRubric>(
    `SELECT
       aq.question_id,
       aq.position,
       aq.question_version,
       q.type,
       q.topic,
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

  // 3. Answers
  const aResult = await client.query<AttemptAnswerRow>(
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

export async function handleAdminGrade(
  input: HandleAdminGradeInput,
): Promise<HandleAdminGradeOutput> {
  const { tenantId, attemptId, sessionLastActivity } = input;

  // D1 — mode check
  if (config.AI_PIPELINE_MODE !== "claude-code-vps") {
    throw new AppError(
      "Phase 1 grading only available in claude-code-vps mode",
      AI_GRADING_ERROR_CODES.MODE_NOT_CLAUDE_CODE_VPS,
      503,
    );
  }

  // D7 — heartbeat: admin must have been active within the last 60s
  if (
    sessionLastActivity === null ||
    Date.now() - sessionLastActivity.getTime() > 60_000
  ) {
    throw new AppError(
      "Session idle — refresh the page and re-confirm to grade",
      AI_GRADING_ERROR_CODES.HEARTBEAT_STALE,
      409,
    );
  }

  // D7 — single-flight mutex
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
    // Load attempt + questions + answers inside withTenant (RLS scoped)
    const { status, questions, answers } = await withTenant(
      tenantId,
      (client) => loadGradingData(client, attemptId),
    );

    // Validate attempt is in a gradeable status
    if (status !== "submitted" && status !== "pending_admin_grading") {
      throw new AppError(
        `Attempt is in status '${status}' — must be 'submitted' or 'pending_admin_grading' to grade`,
        AI_GRADING_ERROR_CODES.ATTEMPT_NOT_GRADEABLE,
        422,
      );
    }

    // Grade each AI-gradeable question; collect proposals
    const proposals: GradingProposal[] = [];
    let questionCount = 0;

    for (const q of questions) {
      if (!AI_GRADEABLE_TYPES.has(q.type)) {
        // MCQ, KQL — deterministic graders in module 09; skip here
        continue;
      }
      questionCount++;

      const answer = answers.get(q.question_id) ?? null;

      try {
        const proposal = await gradeSubjective({
          attempt_id: attemptId,
          question_id: q.question_id,
          question_content: q.content,
          rubric: q.rubric,
          answer,
        });
        proposals.push(proposal);
      } catch (err) {
        // Per-question failure: continue with other questions, surface error
        // inside a placeholder proposal. Never log answer text.
        const errorClass =
          err instanceof AppError
            ? err.code
            : AI_GRADING_ERROR_CODES.RUNTIME_FAILURE;

        log.warn(
          {
            attemptId,
            questionId: q.question_id,
            errorClass,
            // Redact err.message if it might contain answer content —
            // log only the error code for safety
          },
          "grading.run.question_failure",
        );

        // Build a minimal failed proposal so the admin sees the failure in UI
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
    // NEVER log answer text or evidence-quote excerpts at INFO (D8 / observability rule)
    log.info(
      { attemptId, questionCount, proposalCount: proposals.length, durationMs },
      "grading.proposal.batch",
    );

    return { proposals };
  } finally {
    slot.release();
  }
}
