-- modules/15-analytics/migrations/0189_question_stats_mv.sql
--
-- RW-60 / FU-C14 — per-question statistics for the Phase C report
-- (docs/design/2026-05-23-question-difficulty-spec.md § 6).
--
-- attempt_summary_mv is one row per ATTEMPT, so a per-QUESTION grain needs a
-- second view. One row per (tenant_id, question_id):
--   exposure_count  attempt_questions rows whose attempt is past in_progress
--   attempts        tenant-visible attempts (0122 rule) with an effective,
--                   non-review_needed grading for the question
--   correct_rate    correct_count / attempts (NULL when attempts = 0)
--   mean_band       avg(reasoning_band) / 4 over graded rows that have a band
--   point_biserial  corr(correct, rest_score); rest_score = attempt total
--                   earned minus this question's score (item-rest, so the item
--                   does not correlate with itself). NULL for < 2 attempts or
--                   zero variance (corr() returns NULL then).
-- Effective grading = newest gradings row per (attempt_id, question_id).
-- correct = status 'correct' OR full marks (same rule as 15 repository.ts).
--
-- source_question_id: tenants answer CLONES of platform questions (0084); the column
--   lets the super-admin roll-up filter question_id = X OR source_question_id = X.
--
-- Tenant: the MV is NOT covered by RLS. Every read must filter
-- tenant_id = current_setting('app.current_tenant') (tools/lint-mv-tenant-filter.ts).
--
-- ponytail: full recompute nightly (refresh-mv-job.ts). If the refresh gets
--   slow, move to an incremental per-question table updated on release.

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
