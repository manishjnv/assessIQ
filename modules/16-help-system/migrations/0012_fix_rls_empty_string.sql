-- owned by modules/16-help-system
-- Patches the RLS policies on help_content deployed before 2026-05-01.
--
-- TWO BUGS fixed:
--
-- BUG 1 — Empty-string GUC cast error:
--   current_setting('app.current_tenant', true) returns '' (empty string)
--   on pooled connections where a prior transaction used set_config(). The
--   ''::uuid cast throws "invalid input syntax for type uuid: ''".
--   FIX: NULLIF(..., '') converts '' to NULL before the ::uuid cast.
--
-- BUG 2 — FOR ALL policy's implicit WITH CHECK allows NULL tenant_id INSERT:
--   A FOR ALL policy contributes its USING clause as implicit WITH CHECK for
--   INSERT. The USING clause included `tenant_id IS NULL` so that global rows
--   are visible for reads. But the same clause as WITH CHECK allowed the app
--   role to INSERT tenant_id = NULL rows (`NULL IS NULL` = TRUE passes the
--   check). This silently defeated the INSERT-denial design.
--   FIX: split into FOR SELECT (reads globals) + FOR INSERT (blocks globals).
--   Also add explicit FOR UPDATE / FOR DELETE policies.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE handles re-runs.

DROP POLICY IF EXISTS tenant_isolation ON help_content;
DROP POLICY IF EXISTS tenant_isolation_update ON help_content;
DROP POLICY IF EXISTS tenant_isolation_delete ON help_content;
DROP POLICY IF EXISTS tenant_isolation_insert ON help_content;

-- SELECT: global rows (tenant_id IS NULL) + current tenant's overrides.
-- FOR SELECT only — does NOT contribute an implicit WITH CHECK for INSERTs.
CREATE POLICY tenant_isolation ON help_content
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- UPDATE: only the current tenant's own rows.
CREATE POLICY tenant_isolation_update ON help_content
  FOR UPDATE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- DELETE: same as UPDATE.
CREATE POLICY tenant_isolation_delete ON help_content
  FOR DELETE
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- INSERT: only the current tenant's own bucket.
-- tenant_id IS NOT NULL: WITH CHECK only blocks on FALSE, not NULL, so the
-- explicit guard ensures tenant_id = NULL is definitively FALSE.
CREATE POLICY tenant_isolation_insert ON help_content
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
