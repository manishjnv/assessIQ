-- modules/13-notifications/migrations/0126_in_app_notifications_update_policy.sql
-- UPDATE policy for in_app_notifications (2026-10-02).
--
-- WHY
--   0056 gave in_app_notifications FOR SELECT + FOR INSERT policies only. With RLS
--   enabled and no UPDATE policy, markInAppNotificationRead (UPDATE ... SET
--   read_at = now()) run as assessiq_app matched ZERO rows, silently — "mark as
--   read" never persisted. Same bug 0121 fixed for email_log / webhook_deliveries.
--
-- WHAT
--   One FOR UPDATE policy, same tenant predicate as the SELECT policy, on both the
--   old row (USING) and the new row (WITH CHECK) so a row cannot be moved across
--   tenants. The SELECT policy is tenant-only (per-user scoping is done in the
--   repository: user_id = $2 OR audience IN ('role','all')), so the UPDATE policy
--   mirrors it; the per-user WHERE stays in markInAppNotificationRead.
--
-- NOT INCLUDED
--   No DELETE policy (nothing deletes these rows). No per-user predicate in RLS
--   (the SELECT policy has none either; role/all audiences are shared rows).
--
-- ROLLBACK
--   DROP POLICY tenant_isolation_update ON in_app_notifications;
--
-- Idempotent and additive.

DROP POLICY IF EXISTS tenant_isolation_update ON in_app_notifications;
CREATE POLICY tenant_isolation_update
  ON in_app_notifications
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
