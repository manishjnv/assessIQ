-- modules/15-analytics/migrations/0122_attempt_summary_mv_released_only.sql
--
-- Fix (2026-10-01): attempt_summary_mv carried a score for EVERY scored attempt,
--   so tenant reports (cohort, individual, archetype, export, activity stats) could
--   show graded-but-unreleased totals: attempts still being evaluated by the
--   platform, or sent back. The tenant may see a score only when
--     status = 'released'  OR  (status = 'graded' AND evaluation_released_at IS NOT NULL)
--   (same rule as results-export.ts and 07 deriveEvaluationStatus).
--
-- Fix at the single seam: the MV keeps every row (completion / attempt counts are
--   unchanged) but its score columns (total_earned, total_max, auto_pct,
--   pending_review, archetype) are NULL until the result is tenant-visible. AVG /
--   PERCENTILE ignore NULLs; the two score LISTS (individual report, cohort
--   attempts) filter auto_pct IS NOT NULL (repository.ts).
--   Considered and rejected: dropping unreleased rows from the MV — the Activity
--   "completions" KPI would then undercount submitted attempts.
--
-- Staleness is unchanged: the MV refreshes nightly (and on the manual refresh
--   route); a result released today appears after the next refresh, as before.
--
-- Recreated (a view's WHERE can't be ALTERed); indexes and the assessiq_system
--   owner (0088) are restored. SELECT grants come from the default privileges (0002).

DROP MATERIALIZED VIEW IF EXISTS attempt_summary_mv;

CREATE MATERIALIZED VIEW attempt_summary_mv AS
SELECT
  ats.tenant_id,
  ats.attempt_id,
  a.assessment_id,
  a.user_id,
  a.status                AS attempt_status,
  a.submitted_at,
  CASE WHEN v.visible THEN ats.total_earned   END AS total_earned,
  CASE WHEN v.visible THEN ats.total_max      END AS total_max,
  CASE WHEN v.visible THEN ats.auto_pct       END AS auto_pct,
  CASE WHEN v.visible THEN ats.pending_review END AS pending_review,
  CASE WHEN v.visible THEN ats.archetype      END AS archetype,
  ats.computed_at,
  asm.pack_id,
  asm.level_id,
  asm.name                AS assessment_name
FROM  attempt_scores  ats
JOIN  attempts        a   ON a.id  = ats.attempt_id
JOIN  assessments     asm ON asm.id = a.assessment_id
CROSS JOIN LATERAL (
  SELECT (a.status = 'released'
          OR (a.status = 'graded' AND a.evaluation_released_at IS NOT NULL)) AS visible
) v;

CREATE UNIQUE INDEX attempt_summary_mv_pk
  ON attempt_summary_mv (tenant_id, attempt_id);

CREATE INDEX attempt_summary_mv_assessment_idx
  ON attempt_summary_mv (tenant_id, assessment_id);

CREATE INDEX attempt_summary_mv_archetype_idx
  ON attempt_summary_mv (tenant_id, archetype)
  WHERE archetype IS NOT NULL;

ALTER MATERIALIZED VIEW attempt_summary_mv OWNER TO assessiq_system;
-- Explicit (belt and braces over the 0002 default privileges).
GRANT SELECT ON attempt_summary_mv TO assessiq_app, assessiq_system;
