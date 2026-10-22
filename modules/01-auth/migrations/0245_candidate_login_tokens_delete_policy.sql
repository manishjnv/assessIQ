-- GATE-8 A2-2: DELETE policy on candidate_login_tokens. With RLS on and no DELETE policy, the user purge
-- (modules/03-users/src/purge.ts, under withTenant) removed 0 rows, its "rows survive" check threw, and the
-- whole tenant's purge rolled back. Kept in module 01 (owner of the table) so module-scoped test setups still apply.
-- Forward-only, idempotent. Rollback: DROP POLICY tenant_isolation_delete ON candidate_login_tokens.

DROP POLICY IF EXISTS tenant_isolation_delete ON candidate_login_tokens;
CREATE POLICY tenant_isolation_delete ON candidate_login_tokens FOR DELETE
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );
