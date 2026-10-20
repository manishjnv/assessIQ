-- modules/19-billing/migrations/0222_tenant_candidate_counted.sql
-- Free-plan total candidate cap, race-safe. One row per candidate user ever counted for a tenant.
-- Written by countCandidateOrRefuse (19-billing) inside the transaction that creates the candidate.
-- Append-only: a delete never lowers the count. user_id has no FK on purpose (erased users stay counted).
-- Additive only.

CREATE TABLE IF NOT EXISTS tenant_candidate_counted (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE tenant_candidate_counted ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON tenant_candidate_counted
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_candidate_counted
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON tenant_candidate_counted FROM assessiq_app;

-- Backfill: every existing candidate user row (soft-deleted and erased included, same rule as
-- countCandidatesEver). Idempotent. Runs as the migration role (bypasses RLS).
INSERT INTO tenant_candidate_counted (tenant_id, user_id)
SELECT tenant_id, id FROM users WHERE role = 'candidate'
ON CONFLICT DO NOTHING;
