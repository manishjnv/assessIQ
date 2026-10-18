// Z-39: the ONE "which attempt counts" rule for lists and reports that must show a
// candidate once. assessments.settings.score_counts is 'latest' (default) or 'best'.
// Used by 09 (cohort stats, leaderboard) and 15 (dashboard, cohort reports).
//
// Pure SQL predicate: it is true for exactly one attempt per (assessment, candidate).
//   1. A result that is released to the tenant is preferred over one that is not
//      (a pending retake never hides an earlier released result).
//   2. 'best' = highest score percent among those; ties and 'latest' = highest attempt_number.
//   3. A candidate with no released attempt counts by the newest attempt (workload counts).
// It only chooses a row. It never changes a score and never reads a setting from the client.

/** Same visibility rule as 09 TENANT_VISIBLE_ATTEMPT_SQL, on alias `ca`. */
const VISIBLE_CA = "(ca.status = 'released' OR (ca.status = 'graded' AND ca.evaluation_released_at IS NOT NULL))";

/**
 * SQL predicate for an `attempts` row aliased `alias` (default `a`).
 * Runs under the caller's RLS context (attempts, assessments, attempt_scores are tenant tables).
 */
export function countingAttemptSql(alias = "a"): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("countingAttemptSql: bad alias");
  return `${alias}.id = (
    SELECT ca.id FROM attempts ca
      JOIN assessments cm ON cm.id = ca.assessment_id
      LEFT JOIN attempt_scores cs ON cs.attempt_id = ca.id
     WHERE ca.assessment_id = ${alias}.assessment_id AND ca.user_id = ${alias}.user_id
     ORDER BY (CASE WHEN ${VISIBLE_CA} THEN 1 ELSE 0 END) DESC,
              (CASE WHEN ${VISIBLE_CA} AND cm.settings->>'score_counts' = 'best' AND cs.total_max > 0
                    THEN cs.total_earned / cs.total_max END) DESC NULLS LAST,
              ca.attempt_number DESC
     LIMIT 1)`;
}
