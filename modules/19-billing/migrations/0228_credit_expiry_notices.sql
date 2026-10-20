-- modules/19-billing/migrations/0228_credit_expiry_notices.sql
-- Z-96 part 2: one row per grant once the "expires in 30 days" email went out.
-- UNIQUE (grant_id) is the "send once" guard. Written only by the daily worker job under
-- assessiq_system; tenants may only read. Additive only. No personal data (ids only).

CREATE TABLE IF NOT EXISTS credit_expiry_notices (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id  UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (grant_id)
);

CREATE INDEX IF NOT EXISTS credit_expiry_notices_tenant_idx ON credit_expiry_notices (tenant_id, sent_at);

ALTER TABLE credit_expiry_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_expiry_notices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON credit_expiry_notices
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Required by lint:rls. The app role cannot insert anyway (REVOKE below); only the system role writes.
CREATE POLICY tenant_isolation_insert ON credit_expiry_notices
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON credit_expiry_notices FROM assessiq_app;
