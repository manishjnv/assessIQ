// AssessIQ — modules/09-scoring deterministic MCQ scoring.
//
// MCQ questions are scored with NO AI: candidate's selected option index is
// compared to the answer key (content.correct) in the question version FROZEN
// for this attempt (attempt_questions.question_version), never the live row.
//
// Why this is compliant with the "no ambient AI" rule: there is no model call,
// no subprocess, no network — pure SQL + integer compare. It may therefore run
// inside the candidate submit / timer auto-submit transactions.
//
// INVARIANTS:
//   - One gradings row per (attempt, MCQ question), grader='deterministic'.
//   - Idempotent + concurrency-safe: rows are written with the sentinel
//     prompt_version_sha MCQ_SENTINEL_SHA and ON CONFLICT DO NOTHING against
//     the existing partial unique index gradings_attempt_question_sha_idx
//     (attempt_id, question_id, prompt_version_sha) WHERE override_of IS NULL.
//     A concurrent second writer blocks on the first's uncommitted row, then
//     conflicts and skips. No advisory lock needed.
//   - Never returns correctness / answer key to callers — only counts.
//   - Unanswered or malformed = 0. Negative marking (EX-1): a WRONG, ATTEMPTED answer scores
//     -attempt_questions.negative_marks (frozen at attempt start, 0 = off). Partial credit is never
//     penalised. Totals may therefore be negative; the rollup does not clamp (band, certificate and
//     pass/fail clamp at read time). Rule lives in deterministicMarks() (@assessiq/question-types).

import type { PoolClient } from "pg";
import { streamLogger } from "@assessiq/core";
import { DETERMINISTIC_IDS, deterministicMarks, deterministicScoreFor } from "@assessiq/question-types";
import { auditInTx } from "@assessiq/audit-log";
import { finalizeAttemptIfComplete } from "./finalize.js";
import { getAttemptScore } from "./repository.js";

/** gradings.prompt_version_sha / _label / model sentinels for deterministic rows. */
export const MCQ_SENTINEL_SHA = "deterministic-mcq-v1";
export const MCQ_SENTINEL_LABEL = "deterministic-mcq-v1";
export const MCQ_SENTINEL_MODEL = "none";

const log = streamLogger("app");

export {
  isMcqAnswerCorrect,
  isNumericAnswerCorrect,
  parseNumericAnswer,
  multiSelectFraction,
  orderingFraction,
  structuredCaseFraction,
} from "@assessiq/question-types";

/** Types scored here with NO AI. Single source: the question-type registry (feeds the `qv.type = ANY($n)` SQL below). */
export const DETERMINISTIC_TYPES = DETERMINISTIC_IDS;

/** Fraction (0..1) of the question's points earned, for any deterministic type. */
export function deterministicFraction(type: string, content: unknown, answer: unknown): number {
  return deterministicScoreFor(type, content, answer);
}

interface McqRow {
  question_id: string;
  type: string;
  points: number;
  /** NUMERIC(6,2) frozen at attempt start (0185): pg returns a string. */
  negative_marks: string | number | null;
  content: unknown;
  answer: unknown;
}

/**
 * Write deterministic gradings rows for every MCQ question of the attempt.
 * Must run inside withTenant (RLS). Returns the number of rows newly inserted.
 */
export async function scoreMcqForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<number> {
  const res = await client.query<McqRow>(
    `SELECT aq.question_id, qv.type, aq.points, aq.negative_marks, qv.content, aa.answer
       FROM attempt_questions aq
       JOIN question_versions qv
         ON qv.question_id = aq.question_id
        AND qv.version     = aq.question_version
       LEFT JOIN attempt_answers aa
         ON aa.attempt_id = aq.attempt_id
        AND aa.question_id = aq.question_id
      WHERE aq.attempt_id = $1
        AND qv.type = ANY($2)`,
    [attemptId, DETERMINISTIC_IDS],
  );

  let inserted = 0;
  for (const r of res.rows) {
    const marks = deterministicMarks(r.type, r.content, r.answer, {
      points: r.points,
      negativeMarks: r.negative_marks === null ? 0 : Number(r.negative_marks),
    });
    const ins = await client.query(
      `INSERT INTO gradings (
         tenant_id, attempt_id, question_id, grader,
         score_earned, score_max, status,
         prompt_version_sha, prompt_version_label, model
       ) VALUES (
         current_setting('app.current_tenant', true)::uuid, $1, $2, 'deterministic',
         $3, $4, $5, $6, $7, $8
       )
       ON CONFLICT (attempt_id, question_id, prompt_version_sha)
         WHERE override_of IS NULL
       DO NOTHING`,
      [
        attemptId,
        r.question_id,
        marks.earned,
        marks.max,
        marks.status,
        MCQ_SENTINEL_SHA,
        MCQ_SENTINEL_LABEL,
        MCQ_SENTINEL_MODEL,
      ],
    );
    inserted += ins.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Score MCQ rows, then finalise the attempt through the shared
 * finalizeAttemptIfComplete() (SP1) in the SAME transaction: attempt_scores
 * rollup → status 'graded' (+ evaluation_released_at) → billing_events row.
 * An MCQ-only attempt completes here; an attempt with other question types
 * completes only once EVERY other question also has a final, non-flagged grade
 * (the old "mcq>0 && other==0" shortcut is gone — completeness is one rule now).
 * A system audit row is written only when this call actually finalised it.
 * Safe to call repeatedly.
 *
 * Returns { finalized } — true only when this call flipped the attempt to graded.
 */
export async function scoreMcqAndFinalizeIfComplete(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<{ finalized: boolean; mcqRowsInserted: number }> {
  const mcqRowsInserted = await scoreMcqForAttempt(client, attemptId);

  // Completion needs every attempt question graded: an MCQ whose frozen
  // question_versions snapshot is missing has no deterministic row, so the
  // attempt simply stays un-finalised for an admin (never an under-counted max).
  const { finalized } = await finalizeAttemptIfComplete(client, {
    tenantId,
    attemptId,
    markEvaluationReleased: true,
  });
  if (!finalized) {
    // Observability for the one MCQ-specific stall: a question whose frozen
    // snapshot is missing is skipped by the scoring JOIN, so it has no
    // deterministic row and the attempt waits for an admin.
    const unscored = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM attempt_questions aq
         JOIN question_versions qv
           ON qv.question_id = aq.question_id AND qv.version = aq.question_version
        WHERE aq.attempt_id = $1
          AND qv.type = ANY($2)
          AND NOT EXISTS (
            SELECT 1 FROM gradings g
             WHERE g.attempt_id = aq.attempt_id
               AND g.question_id = aq.question_id
               AND g.grader = 'deterministic'
          )`,
      [attemptId, DETERMINISTIC_IDS],
    );
    if ((unscored.rows[0]?.n ?? 0) > 0) {
      log.warn({ tenantId, attemptId, mcqUnscored: unscored.rows[0]?.n }, "mcq.finalize.skipped_missing_snapshot");
    }
    return { finalized: false, mcqRowsInserted };
  }

  const score = await getAttemptScore(client, attemptId);
  const counts = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM attempt_questions WHERE attempt_id = $1`,
    [attemptId],
  );

  await auditInTx(client, {
    action: "grading.accepted", // existing catalog action; no new catalog entry needed
    actorKind: "system",
    tenantId,
    entityType: "attempt",
    entityId: attemptId,
    after: {
      attempt_id: attemptId,
      source: "deterministic_mcq",
      grading_count: counts.rows[0]?.n ?? 0,
      total_earned: score?.total_earned ?? null,
      total_max: score?.total_max ?? null,
      attempt_status_now: "graded",
    },
  });

  return { finalized: true, mcqRowsInserted };
}

/**
 * Candidate-path wrapper (submit, timer sweep, read-time auto-submit): a scoring
 * or billing failure must NEVER fail the candidate's submit. Runs inside a
 * SAVEPOINT; on error only the scoring work is rolled back, the attempt stays
 * submitted/auto_submitted, and the admin Grade click (which calls the throwing
 * version) retries it.
 */
export async function scoreMcqAndFinalizeSafely(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<{ finalized: boolean; mcqRowsInserted: number } | null> {
  await client.query("SAVEPOINT mcq_score");
  try {
    const r = await scoreMcqAndFinalizeIfComplete(client, tenantId, attemptId);
    await client.query("RELEASE SAVEPOINT mcq_score");
    return r;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT mcq_score");
    log.error({ err, tenantId, attemptId }, "mcq.score.failed_deferred_to_admin_grade");
    return null;
  }
}
