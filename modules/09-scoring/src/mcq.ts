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
//   - Unanswered or malformed = 0; no negative marking.

import type { PoolClient } from "pg";
import { streamLogger } from "@assessiq/core";
import { auditInTx } from "@assessiq/audit-log";
import { recordGradedAttempt } from "@assessiq/billing";
import { computeAttemptScoreInTx } from "./service.js";

/** gradings.prompt_version_sha / _label / model sentinels for deterministic rows. */
export const MCQ_SENTINEL_SHA = "deterministic-mcq-v1";
export const MCQ_SENTINEL_LABEL = "deterministic-mcq-v1";
export const MCQ_SENTINEL_MODEL = "none";

const log = streamLogger("app");

/**
 * Pure correctness check. `content` is the frozen question_versions.content,
 * `answer` the stored attempt_answers.answer. Never throws.
 * Accepted answer shapes: {selected: <int>} (canonical) or a bare integer.
 * Everything else (null, string, array, float, out-of-range) is incorrect.
 * Only single-correct MCQ is supported by the content schema (`correct: int`).
 */
export function isMcqAnswerCorrect(content: unknown, answer: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  const c = content as { correct?: unknown; options?: unknown };
  const correct = c.correct;
  if (typeof correct !== "number" || !Number.isInteger(correct) || correct < 0) return false;
  if (Array.isArray(c.options) && correct >= c.options.length) return false;

  let selected: unknown = answer;
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) {
    selected = (answer as { selected?: unknown }).selected;
  }
  if (typeof selected !== "number" || !Number.isInteger(selected)) return false;
  return selected === correct;
}

interface McqRow {
  question_id: string;
  points: number;
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
    `SELECT aq.question_id, q.points, qv.content, aa.answer
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN question_versions qv
         ON qv.question_id = aq.question_id
        AND qv.version     = aq.question_version
       LEFT JOIN attempt_answers aa
         ON aa.attempt_id = aq.attempt_id
        AND aa.question_id = aq.question_id
      WHERE aq.attempt_id = $1
        AND q.type = 'mcq'`,
    [attemptId],
  );

  let inserted = 0;
  for (const r of res.rows) {
    const correct = isMcqAnswerCorrect(r.content, r.answer);
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
        correct ? r.points : 0,
        r.points,
        correct ? "correct" : "incorrect",
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
 * Score MCQ rows, and — when the attempt is MCQ-only (no other question type;
 * KQL/scenario/etc. keep the current admin flow) — finalise it in the SAME
 * transaction: attempt_scores rollup → status 'graded' → billing_events row →
 * audit row (system actor). Safe to call repeatedly.
 *
 * Returns { finalized } — true only when this call flipped the attempt to graded.
 */
export async function scoreMcqAndFinalizeIfComplete(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<{ finalized: boolean; mcqRowsInserted: number }> {
  const mcqRowsInserted = await scoreMcqForAttempt(client, attemptId);

  const counts = await client.query<{ mcq: string; other: string }>(
    `SELECT COUNT(*) FILTER (WHERE q.type = 'mcq')  AS mcq,
            COUNT(*) FILTER (WHERE q.type <> 'mcq') AS other
       FROM attempt_questions aq
       JOIN questions q ON q.id = aq.question_id
      WHERE aq.attempt_id = $1`,
    [attemptId],
  );
  const mcq = Number(counts.rows[0]?.mcq ?? 0);
  const other = Number(counts.rows[0]?.other ?? 0);
  if (mcq === 0 || other > 0) return { finalized: false, mcqRowsInserted };

  // Never finalise a partial score: every MCQ must have its deterministic row
  // (a question missing its frozen question_versions snapshot is skipped by the
  // scoring JOIN — leave that attempt for an admin instead of under-counting max).
  const scored = await client.query<{ n: string }>(
    `SELECT COUNT(DISTINCT g.question_id) AS n
       FROM gradings g
       JOIN attempt_questions aq
         ON aq.attempt_id = g.attempt_id AND aq.question_id = g.question_id
       JOIN questions q ON q.id = g.question_id
      WHERE g.attempt_id = $1
        AND g.grader = 'deterministic'
        AND g.override_of IS NULL
        AND q.type = 'mcq'`,
    [attemptId],
  );
  if (Number(scored.rows[0]?.n ?? 0) < mcq) {
    log.warn({ tenantId, attemptId, mcq, scored: scored.rows[0]?.n }, "mcq.finalize.skipped_missing_snapshot");
    return { finalized: false, mcqRowsInserted };
  }

  // Lock the attempt row; only pre-graded states may be finalised. Score BEFORE
  // the flip: archetype signals read status='auto_submitted'.
  const st = await client.query<{ status: string }>(
    `SELECT status FROM attempts WHERE id = $1 FOR UPDATE`,
    [attemptId],
  );
  const status = st.rows[0]?.status;
  if (
    status !== "submitted" &&
    status !== "auto_submitted" &&
    status !== "pending_admin_grading"
  ) {
    return { finalized: false, mcqRowsInserted };
  }

  const score = await computeAttemptScoreInTx(client, tenantId, attemptId);

  // submitted|auto_submitted|pending_admin_grading → graded is CHECK-legal and
  // is the same transition admin-accept performs.
  await client.query(`UPDATE attempts SET status = 'graded' WHERE id = $1`, [attemptId]);

  // Revenue-leak invariant: billing in the same tx as attempt→graded.
  await recordGradedAttempt(client, tenantId, attemptId);

  await auditInTx(client, {
    action: "grading.accepted", // existing catalog action; no new catalog entry needed
    actorKind: "system",
    tenantId,
    entityType: "attempt",
    entityId: attemptId,
    after: {
      attempt_id: attemptId,
      source: "deterministic_mcq",
      grading_count: mcq,
      total_earned: score.total_earned,
      total_max: score.total_max,
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
