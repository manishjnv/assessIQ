-- modules/15-analytics/migrations/0219_summary_mvs_real_only.sql
--
-- Z-89 (mock vs real): attempt_summary_mv and question_stats_mv feed the REAL-exam
--   reports (cohort, individual, archetype, attempts export, activity stats, question
--   statistics). A mock test must not move those numbers. The views are recreated with the
--   same columns, indexes, owner and grants; the only change is
--     attempts.delivery_mode = 'real'
--   (0217 added the column; existing rows are 'real').
--   Considered and rejected: adding a delivery_mode column and filtering in ~10 readers
--   (easy to forget one; the lint cannot see it). The mock dashboard (Z-90) will read its
--   own source, so these views never need mock rows.
--   Definitions copied from 0122 and 0189 without other change.

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
) v
WHERE a.delivery_mode = 'real';

CREATE UNIQUE INDEX attempt_summary_mv_pk
  ON attempt_summary_mv (tenant_id, attempt_id);

CREATE INDEX attempt_summary_mv_assessment_idx
  ON attempt_summary_mv (tenant_id, assessment_id);

CREATE INDEX attempt_summary_mv_archetype_idx
  ON attempt_summary_mv (tenant_id, archetype)
  WHERE archetype IS NOT NULL;

ALTER MATERIALIZED VIEW attempt_summary_mv OWNER TO assessiq_system;
GRANT SELECT ON attempt_summary_mv TO assessiq_app, assessiq_system;

DROP MATERIALIZED VIEW IF EXISTS question_stats_mv;

CREATE MATERIALIZED VIEW question_stats_mv AS
WITH exposure AS (
  SELECT a.tenant_id,
         aq.question_id,
         count(*)                                           AS exposure_count,
         max(coalesce(a.submitted_at, a.started_at))        AS last_used_at
  FROM   attempt_questions aq
  JOIN   attempts a ON a.id = aq.attempt_id
  WHERE  a.status IN ('submitted','auto_submitted','pending_admin_grading','graded','released')
    AND  a.delivery_mode = 'real'
  GROUP  BY a.tenant_id, aq.question_id
),
eff AS (
  SELECT DISTINCT ON (g.attempt_id, g.question_id)
         g.attempt_id, g.question_id, g.status, g.score_earned, g.score_max, g.reasoning_band
  FROM   gradings g
  -- same rule as 09-scoring finalize/release: newest graded_at, admin_override wins a tie
  ORDER  BY g.attempt_id, g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC, g.id DESC
),
graded AS (
  SELECT a.tenant_id,
         e.question_id,
         (e.status = 'correct' OR (e.score_earned = e.score_max AND e.score_max > 0)) AS is_correct,
         e.reasoning_band,
         (ats.total_earned - e.score_earned) AS rest_score
  FROM   eff e
  JOIN   attempts a        ON a.id = e.attempt_id
  -- inner join: a released attempt without an attempt_scores row is still pending in 06 result.ts, so it is left out here too
  JOIN   attempt_scores ats ON ats.attempt_id = a.id
  WHERE  e.status <> 'review_needed'
    AND  a.delivery_mode = 'real'
    AND  (a.status = 'released'
          OR (a.status = 'graded' AND a.evaluation_released_at IS NOT NULL))
),
agg AS (
  SELECT tenant_id,
         question_id,
         count(*)                                           AS attempts,
         count(*) FILTER (WHERE is_correct)                 AS correct_count,
         avg(reasoning_band)                                AS avg_band,
         corr(is_correct::int, rest_score)                  AS pb
  FROM   graded
  GROUP  BY tenant_id, question_id
)
SELECT x.tenant_id,
       x.question_id,
       q.pack_id,
       q.level_id,
       q.source_question_id,
       x.exposure_count,
       coalesce(g.attempts, 0)                              AS attempts,
       coalesce(g.correct_count, 0)                         AS correct_count,
       round(g.correct_count::numeric / NULLIF(g.attempts, 0), 4)::numeric(5,4)  AS correct_rate,
       round(g.avg_band::numeric / 4, 4)::numeric(5,4)      AS mean_band,
       round(g.pb::numeric, 4)::numeric(6,4)                AS point_biserial,
       x.last_used_at,
       now()                                                AS computed_at
FROM   exposure x
JOIN   questions q ON q.id = x.question_id
LEFT   JOIN agg g  ON g.tenant_id = x.tenant_id AND g.question_id = x.question_id;

CREATE UNIQUE INDEX question_stats_mv_pk
  ON question_stats_mv (tenant_id, question_id);

CREATE INDEX question_stats_mv_pack_idx
  ON question_stats_mv (tenant_id, pack_id);

ALTER MATERIALIZED VIEW question_stats_mv OWNER TO assessiq_system;
GRANT SELECT ON question_stats_mv TO assessiq_app, assessiq_system;
