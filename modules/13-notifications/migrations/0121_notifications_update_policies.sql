-- modules/13-notifications/migrations/0121_notifications_update_policies.sql
-- Notifications hardening (2026-10-01) — UPDATE policies for email_log + webhook_deliveries.
--
-- WHY
--   0055 (email_log) and 0058 (webhook_deliveries) gave each table a `FOR SELECT`
--   and a `FOR INSERT` policy and nothing else. With RLS enabled and no policy
--   for UPDATE, an UPDATE run as assessiq_app (no BYPASSRLS) matches ZERO rows —
--   silently, no error. Verified on a real Postgres built from the repo
--   migrations. Effect: the worker's status writes never persist —
--     * email_log stays 'queued' for ever (the symptom of docs/RCA_LOG.md
--       2026-05-09 and of the 2026-05-15 e2e walkthrough: "rows stay queued
--       forever"), so a failed / permanently bounced email is invisible;
--     * webhook_deliveries stays 'pending' for ever, so a delivery refused by the
--       SSRF guard (last_error='blocked_address') or failed with a 4xx is never
--       recorded.
--   If production was patched by hand, this migration is a harmless no-op
--   addition (policies are OR-ed).
--   Other tables use `CREATE POLICY tenant_isolation ... USING (...)` with no FOR
--   clause, which covers UPDATE; these two simply never got that.
--
-- WHAT
--   One FOR UPDATE policy per table, same tenant predicate as the existing
--   SELECT/INSERT policies, applied to both the old row (USING) and the new row
--   (WITH CHECK) — so a row can neither be touched from another tenant nor be
--   moved to one (email_log.tenant_id / webhook_deliveries.endpoint_id).
--
-- NOT INCLUDED
--   - No DELETE policy (nothing deletes these rows; webhook_deliveries goes away
--     via ON DELETE CASCADE from webhook_endpoints, which is not RLS-evaluated).
--   - in_app_notifications has the same SELECT+INSERT-only shape (so mark-read
--     matches 0 rows). Out of scope for this change; same fix applies.
--   - webhook_deliveries is still one row per delivery: a replay writes a NEW
--     row. What this allows is the processor recording the outcome of that
--     delivery (status / http_status / last_error / delivered_at), which
--     updateWebhookDeliveryStatus has always tried to do.
--
-- ROLLBACK
--   DROP POLICY tenant_isolation_update ON email_log;
--   DROP POLICY tenant_isolation_update ON webhook_deliveries;
--
-- Idempotent and additive: no table, column or data is touched.

DROP POLICY IF EXISTS tenant_isolation_update ON email_log;
CREATE POLICY tenant_isolation_update
  ON email_log
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- JOIN-based like the existing policies: webhook_deliveries has no tenant_id;
-- tenancy flows through endpoint_id -> webhook_endpoints.tenant_id.
DROP POLICY IF EXISTS tenant_isolation_update ON webhook_deliveries;
CREATE POLICY tenant_isolation_update
  ON webhook_deliveries
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM webhook_endpoints e
      WHERE e.id = webhook_deliveries.endpoint_id
        AND e.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM webhook_endpoints e
      WHERE e.id = webhook_deliveries.endpoint_id
        AND e.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
