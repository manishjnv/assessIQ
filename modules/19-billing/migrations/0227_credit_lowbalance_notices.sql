-- modules/19-billing/migrations/0227_credit_lowbalance_notices.sql
-- Z-96 part 1: one row per (grant, level) once a low-balance email went out (level 20 or 10
-- percent of the largest active grant). UNIQUE (grant_id, level) is the "send once" guard.
-- Written only by the daily worker job under assessiq_system; tenants may only read.
-- Additive only. No personal data (counts and ids).

CREATE TABLE IF NOT EXISTS credit_lowbalance_notices (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id  UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  level     SMALLINT NOT NULL CHECK (level IN (20, 10)),
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (grant_id, level)
);

CREATE INDEX IF NOT EXISTS credit_lowbalance_notices_tenant_idx ON credit_lowbalance_notices (tenant_id, sent_at);

ALTER TABLE credit_lowbalance_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_lowbalance_notices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON credit_lowbalance_notices
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON credit_lowbalance_notices FROM assessiq_app;
