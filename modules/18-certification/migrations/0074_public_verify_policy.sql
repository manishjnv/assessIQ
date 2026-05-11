-- AssessIQ — modules/18-certification/migrations/0074_public_verify_policy.sql
--
-- Phase 5 Session 3 — add the GUC-based public verify RLS policy.
--
-- Decision: OPTION 3 (GUC-based policy).
--   NOT assessiq_system role bypass (D7 option b) — would require a second DB
--   user, complicating the pool setup and VPS ops.
--   NOT SECURITY DEFINER function (D7 option a) — would bypass RLS entirely,
--   exposing tenant_id and other sensitive fields to the function logic rather
--   than relying on the DB engine to gate rows.
--
-- The new policy is OR-ed with the existing tenant_isolation SELECT policy
-- by Postgres. Normal tenant requests satisfy tenant_isolation (app.current_tenant
-- is set by withTenant). Verify-page requests satisfy public_verify_lookup
-- (app.public_verify='true' is set by withPublicVerifyContext). The verify-page
-- caller DOES NOT set app.current_tenant — so it only satisfies this policy.
--
-- The GUC is set transaction-local via:
--   SELECT set_config('app.public_verify', 'true', true)
-- The third argument (is_local=true) means the GUC reverts automatically on
-- COMMIT/ROLLBACK. There is no risk of it leaking across pool connections.
--
-- UPDATE/INSERT/DELETE are NOT affected — this policy is FOR SELECT only.
-- The public verify page never modifies certificate rows directly; the
-- verification_views counter uses a separate withTenant() transaction.

CREATE POLICY public_verify_lookup
  ON certificates
  FOR SELECT
  USING (current_setting('app.public_verify', true) = 'true');
