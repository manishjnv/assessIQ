-- GATE-8 A2-1/A2-2: DELETE (and UPDATE) policies that were missing under RLS.
-- With RLS on and no policy for a verb, the statement matches 0 rows and raises no error:
--   * DELETE /api/admin/webhooks/:id answered 2xx and wrote a "deleted" audit row, but the endpoint stayed
--     and kept receiving tenant events (webhook_endpoints had SELECT + INSERT only; 0058).
--   * The user purge (modules/03-users/src/purge.ts) deletes in_app_notifications (and candidate_login_tokens, see module 01
--     migration 0245) under withTenant; with no DELETE policy it removed 0 rows and its "rows survive" check rolled the tenant's purge back.
-- Same shape as the existing policies (tenant_id = app.current_tenant, fail-closed when unset).
-- Forward-only, idempotent (DROP POLICY IF EXISTS before CREATE). Rollback: DROP POLICY the three names below.
-- Not included: a lint that checks every verb per table (own ROADMAP row).

DROP POLICY IF EXISTS tenant_isolation_update ON webhook_endpoints;
CREATE POLICY tenant_isolation_update ON webhook_endpoints FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_delete ON webhook_endpoints;
CREATE POLICY tenant_isolation_delete ON webhook_endpoints FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_delete ON in_app_notifications;
CREATE POLICY tenant_isolation_delete ON in_app_notifications FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
