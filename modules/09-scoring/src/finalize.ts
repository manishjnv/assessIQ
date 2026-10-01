// AssessIQ — modules/09-scoring one shared finalize.
//
// SP1 (2026-10-01). Every path that can complete an attempt — deterministic MCQ
// scoring at submit, the admin "Accept", an override, a manual first score —
// goes through finalizeAttemptIfComplete(). One definition of "complete", one
// place that flips attempts.status to 'graded' and bills.
//
// A result is COMPLETE iff EVERY attempt_questions row of the attempt (all
// question types: mcq, subjective, scenario, log_analysis, kql) has an
// EFFECTIVE grading whose status is not 'review_needed'. Effective = the newest
// gradings row for the question; an admin_override row wins a graded_at tie
// (same rule as repository.getGradingsForAttempt and results-export). Past
// definitions let KQL be silently missing from the total and let flagged
// (review_needed) grades count — both break "a student only ever sees a
// complete, final score" (owner rule P1).
//
// Invariants (spec §0):
//   1. billing (recordGradedAttempt) runs in the SAME tx as the status flip,
//      exactly once per attempt (the flip only matches pre-graded statuses and
//      the attempt row is locked FOR UPDATE).
//   7. attempts.status enum is unchanged; new state lives in columns
//      (evaluation_released_at, migration 0113).
// No audit row is written here — callers keep their own (accept / override /
// manual score / mcq system row), which keeps the audit-writes pins intact.
//
// No AI call, no model, no network: pure SQL. Safe inside the candidate submit tx.

import type { PoolClient } from "pg";
import { recordGradedAttempt } from "@assessiq/billing";
import { computeAttemptScoreInTx } from "./service.js";

export interface FinalizeAttemptInput {
  tenantId: string;
  attemptId: string;
  /**
   * true  -> also set attempts.evaluation_released_at = now() ("the tenant may
   *          see and publish this result") in the SAME statement as the flip, so
   *          the result is never graded-but-unreleased in between. Used by
   *          auto-scorable completion and, since the 2026-10-01 owner decision, by
   *          the platform evaluator's accept / manual score / override: accepting
   *          the last grade IS the review, there is no separate click.
   * false -> leave it NULL (the default for every other caller; the explicit
   *          release-to-tenant step then hands it over).
   */
  markEvaluationReleased: boolean;
  /**
   * With markEvaluationReleased: the user handing the result over, written to
   * attempts.evaluation_released_by (the auto-release sweep uses it as the audit
   * actor). Omit for system completion (all-MCQ attempts) -> NULL. Ignored when
   * markEvaluationReleased is false.
   */
  releasedBy?: string;
}

/**
 * Finalise the attempt iff it is complete. Must run inside withTenant (RLS) on
 * the caller's open transaction. Safe to call repeatedly: a non-pre-graded
 * attempt (already graded / released / in progress) returns { finalized:false }.
 */
export async function finalizeAttemptIfComplete(
  client: PoolClient,
  input: FinalizeAttemptInput,
): Promise<{ finalized: boolean }> {
  const { tenantId, attemptId, markEvaluationReleased, releasedBy } = input;

  // 1. Lock the attempt row; only pre-graded states may be finalised. The status
  //    predicate is re-evaluated after the lock is acquired, so a concurrent
  //    finalizer that already flipped the row makes this return no row.
  const locked = await client.query<{ id: string }>(
    `SELECT id
       FROM attempts
      WHERE id = $1
        AND status IN ('submitted', 'auto_submitted', 'pending_admin_grading')
      FOR UPDATE`,
    [attemptId],
  );
  if (locked.rows.length === 0) return { finalized: false };

  // 2. Complete iff every frozen question has an effective, non-flagged grading.
  //    total = 0 (no frozen questions) is never complete: nothing to score.
  const progress = await client.query<{ total: number; done: number }>(
    `WITH effective AS (
       SELECT DISTINCT ON (g.question_id) g.question_id, g.status
         FROM gradings g
        WHERE g.attempt_id = $1
        ORDER BY g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE e.question_id IS NOT NULL AND e.status <> 'review_needed')::int AS done
       FROM attempt_questions aq
       LEFT JOIN effective e ON e.question_id = aq.question_id
      WHERE aq.attempt_id = $1`,
    [attemptId],
  );
  const p = progress.rows[0];
  if (p === undefined || p.total === 0 || p.done < p.total) return { finalized: false };

  // 3. Complete. Score BEFORE the flip: archetype signals read
  //    status='auto_submitted'. Then flip, then bill — one transaction.
  await computeAttemptScoreInTx(client, tenantId, attemptId);

  // evaluation_released_at / _by are set in the SAME statement as the flip (one tx):
  // now() is the completion moment, which is what the auto-release sweep compares
  // with result_release_auto_since.
  await client.query(
    `UPDATE attempts
        SET status = 'graded',
            ai_proposals = NULL,
            grading_started_at = NULL
            ${markEvaluationReleased ? ", evaluation_released_at = now(), evaluation_released_by = $2" : ""}
      WHERE id = $1`,
    markEvaluationReleased ? [attemptId, releasedBy ?? null] : [attemptId],
  );

  // Revenue-leak invariant: billing in the same tx as attempt -> graded.
  // Idempotent via UNIQUE(tenant_id, attempt_id); a non-conflict DB error rolls
  // the whole finalize back.
  await recordGradedAttempt(client, tenantId, attemptId);

  return { finalized: true };
}
