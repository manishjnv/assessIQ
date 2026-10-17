/**
 * Candidate progress across tests (RW-84) — GET /api/me/progress.
 *
 * RELEASED attempts only (a.status = 'released', same rule as listCandidateResults),
 * so nothing unreleased leaks: not the attempt, not its trend point, not its
 * per-subject answers. No AI: pure SQL + arithmetic.
 *
 * Subjects: newest gradings row per (attempt, question) joined to
 * question_taxonomy -> taxonomy_nodes. A node resolves to its subject (itself, its
 * parent or its grandparent, whichever has kind 'subject'). A question with no
 * subject is grouped under "Other". review_needed rows are skipped (not final).
 * "correct" matches modules/15-analytics: status 'correct' or full marks.
 */

import { withTenant } from "@assessiq/tenancy";
import { RELEASED_AT_SQL, certificateRef, resultPercent, type CandidateCertificateRef } from "./result.js";

export interface ProgressAttempt {
  attempt_id: string;
  assessment_id: string;
  assessment_name: string;
  released_at: string;
  total_earned: number;
  total_max: number;
  score_pct: number | null;
  passing_score_pct: number | null;
  passed: boolean | null;
  certificate: CandidateCertificateRef | null;
}

export interface ProgressSubject {
  node_id: string;
  label: string;
  questions: number;
  correct: number;
  rate_pct: number;
}

export interface CandidateProgress {
  attempts: ProgressAttempt[];
  /** score_pct of released attempts, oldest -> newest, nulls skipped. */
  trend: number[];
  subjects: ProgressSubject[];
}

const ATTEMPTS_SQL = `SELECT a.id AS attempt_id,
        a.assessment_id,
        asm.name AS assessment_name,
        s.total_earned::text AS total_earned,
        s.total_max::text    AS total_max,
        l.passing_score_pct,
        ${RELEASED_AT_SQL} AS released_at,
        c.credential_id
   FROM attempts a
   JOIN assessments asm ON asm.id = a.assessment_id
   JOIN levels l        ON l.id   = asm.level_id
   JOIN attempt_scores s ON s.attempt_id = a.id
   LEFT JOIN certificates c ON c.attempt_id = a.id AND c.revoked_at IS NULL
  WHERE a.user_id = $1
    AND a.status = 'released'
  ORDER BY released_at DESC, a.created_at DESC`;

const SUBJECTS_SQL = `WITH latest AS (
  SELECT DISTINCT ON (g.attempt_id, g.question_id)
         g.attempt_id, g.question_id, g.status, g.score_earned, g.score_max
    FROM gradings g
    JOIN attempts a ON a.id = g.attempt_id
   WHERE a.user_id = $1 AND a.status = 'released'
   ORDER BY g.attempt_id, g.question_id, g.graded_at DESC, g.id DESC
), rows AS (
  SELECT l.attempt_id, l.question_id,
         (l.status = 'correct' OR (l.score_earned = l.score_max AND l.score_max > 0)) AS is_correct,
         s.id::text AS node_id, s.label
    FROM latest l
    LEFT JOIN question_taxonomy qt ON qt.question_id = l.question_id
    LEFT JOIN taxonomy_nodes n  ON n.id  = qt.node_id
    LEFT JOIN taxonomy_nodes p  ON p.id  = n.parent_id
    LEFT JOIN taxonomy_nodes gp ON gp.id = p.parent_id
    LEFT JOIN taxonomy_nodes s  ON s.id  = CASE WHEN n.kind = 'subject' THEN n.id
                                                WHEN p.kind = 'subject' THEN p.id
                                                WHEN gp.kind = 'subject' THEN gp.id END
   WHERE l.status <> 'review_needed'
), kept AS (
  SELECT DISTINCT attempt_id, question_id, is_correct,
         COALESCE(node_id, 'other') AS node_id, COALESCE(label, 'Other') AS label
    FROM (SELECT r.*, bool_or(node_id IS NOT NULL) OVER (PARTITION BY attempt_id, question_id) AS has_subject
            FROM rows r) x
   WHERE node_id IS NOT NULL OR NOT has_subject
)
SELECT node_id, label,
       count(*)::int AS questions,
       count(*) FILTER (WHERE is_correct)::int AS correct
  FROM kept
 GROUP BY node_id, label`;

export async function getCandidateProgress(tenantId: string, userId: string): Promise<CandidateProgress> {
  return withTenant(tenantId, async (client) => {
    const att = await client.query<{
      attempt_id: string; assessment_id: string; assessment_name: string;
      total_earned: string; total_max: string;
      passing_score_pct: number | null; released_at: Date; credential_id: string | null;
    }>(ATTEMPTS_SQL, [userId]);
    const attempts: ProgressAttempt[] = att.rows.map((r) => {
      // Same percent and pass rule as /api/me/results (resultPercent), so the
      // Passed chip never differs between the two candidate pages.
      const earned = parseFloat(r.total_earned);
      const max = parseFloat(r.total_max);
      const pct = resultPercent(earned, max);
      return {
        attempt_id: r.attempt_id,
        assessment_id: r.assessment_id,
        assessment_name: r.assessment_name,
        released_at: new Date(r.released_at).toISOString(),
        total_earned: earned,
        total_max: max,
        score_pct: pct,
        passing_score_pct: r.passing_score_pct,
        passed: r.passing_score_pct === null ? null : pct >= r.passing_score_pct,
        certificate: certificateRef(r.credential_id),
      };
    });
    const sub = await client.query<{ node_id: string; label: string; questions: number; correct: number }>(
      SUBJECTS_SQL,
      [userId],
    );
    const subjects = sub.rows
      .map((r) => ({ ...r, rate_pct: Math.round((r.correct / r.questions) * 1000) / 10 }))
      .sort((x, y) => x.rate_pct - y.rate_pct || x.label.localeCompare(y.label));
    const trend = attempts
      .slice()
      .reverse()
      .flatMap((a) => (a.score_pct === null ? [] : [a.score_pct]));
    return { attempts, trend, subjects };
  });
}
