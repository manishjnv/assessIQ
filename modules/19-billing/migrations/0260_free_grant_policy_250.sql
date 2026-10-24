-- Z-160: Free plan gets 250 credits each month (was 200). The app role may insert
-- only a free_monthly grant, now up to 250 credits. Idempotent.
DROP POLICY IF EXISTS tenant_isolation_insert ON credit_grants;
CREATE POLICY tenant_isolation_insert ON credit_grants
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid AND source = 'free_monthly'
              AND credits = remaining AND credits <= 250);
