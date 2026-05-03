-- modules/09-scoring/migrations/0050_attempt_scores.sql
--
-- Phase 2 G2.B Session 3 — attempt-level score rollup table.
--
-- Standard tenant_id-direct RLS (two-policy template from docs/02-data-model.md
-- § "Critical: RLS policy template"). `tenant_isolation` covers ALL commands
-- (no FOR clause) so ON CONFLICT DO UPDATE in UPSERT operations also respects
-- tenant isolation. `tenant_isolation_insert` adds the WITH CHECK guard.
--
-- Indexes:
--   (tenant_id, computed_at DESC) — cohort dashboard queries ordered by recency
--   (tenant_id, archetype) WHERE archetype IS NOT NULL — archetype-distribution
--     rollup for GET /admin/reports/cohort/:assessmentId archetypeDistribution

CREATE TABLE attempt_scores (
  attempt_id        UUID PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  total_earned      NUMERIC(8,2) NOT NULL,
  total_max         NUMERIC(8,2) NOT NULL,
  auto_pct          NUMERIC(5,2) NOT NULL,      -- total_earned / total_max * 100, stored for sorting
  pending_review    BOOLEAN NOT NULL DEFAULT false,
  archetype         TEXT,                        -- ArchetypeLabel | null
  archetype_signals JSONB,                       -- ArchetypeSignals per P2.D11
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attempt_scores_tenant_computed_idx
  ON attempt_scores (tenant_id, computed_at DESC);

CREATE INDEX attempt_scores_tenant_archetype_idx
  ON attempt_scores (tenant_id, archetype)
  WHERE archetype IS NOT NULL;

ALTER TABLE attempt_scores ENABLE ROW LEVEL SECURITY;

-- Covers SELECT, UPDATE, DELETE — tenant isolation for reads and upserts.
CREATE POLICY tenant_isolation ON attempt_scores
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT WITH CHECK — rejects rows whose tenant_id doesn't match the session GUC.
CREATE POLICY tenant_isolation_insert ON attempt_scores
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
