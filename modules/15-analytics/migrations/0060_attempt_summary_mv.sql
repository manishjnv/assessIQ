-- modules/15-analytics/migrations/0060_attempt_summary_mv.sql
--
-- Phase 3 G3.C — attempt_summary_mv materialized view (P3.D18).
--
-- WHY a materialized view rather than a live query:
--   At moderate tenant data sizes (1k–50k attempts) a bare JOIN across
--   attempt_scores + attempts + assessments on every report request is
--   acceptable. Shipping the MV now means the 50K-attempt scale threshold
--   is a deploy-time non-event (REFRESH CONCURRENTLY keeps reads live).
--   TimescaleDB hypertable migration deferred to Phase 4 per P3.D22.
--
-- RLS NOTE: Postgres 16 does NOT enforce RLS on materialized views.
--   The service layer (modules/15-analytics/src/repository.ts) MUST include
--   WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
--   on every query against this MV.
--   The CI lint tools/lint-mv-tenant-filter.ts enforces this in the codebase.
--
-- REFRESH:
--   Nightly via the analytics:refresh_mv BullMQ job at 02:00 UTC.
--   CONCURRENTLY requires the UNIQUE index on (tenant_id, attempt_id) — present.
--
-- INDEXES:
--   (tenant_id, attempt_id) UNIQUE — required for REFRESH CONCURRENTLY
--   (tenant_id, assessment_id)     — cohort / archetype-distribution queries
--   (tenant_id, archetype)         — archetype grouping

CREATE MATERIALIZED VIEW IF NOT EXISTS attempt_summary_mv AS
SELECT
  ats.tenant_id,
  ats.attempt_id,
  a.assessment_id,
  a.user_id,
  a.status                AS attempt_status,
  a.submitted_at,
  ats.total_earned,
  ats.total_max,
  ats.auto_pct,
  ats.pending_review,
  ats.archetype,
  ats.computed_at,
  asm.pack_id,
  asm.level_id,
  asm.name                AS assessment_name
FROM  attempt_scores  ats
JOIN  attempts        a   ON a.id  = ats.attempt_id
JOIN  assessments     asm ON asm.id = a.assessment_id;

-- UNIQUE index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX attempt_summary_mv_pk
  ON attempt_summary_mv (tenant_id, attempt_id);

-- Report query acceleration
CREATE INDEX attempt_summary_mv_assessment_idx
  ON attempt_summary_mv (tenant_id, assessment_id);

CREATE INDEX attempt_summary_mv_archetype_idx
  ON attempt_summary_mv (tenant_id, archetype)
  WHERE archetype IS NOT NULL;

-- Status index for homeKpis / queueSummary live queries (read from attempts, not MV)
-- N/A here — those queries go against live tables, not the MV.
