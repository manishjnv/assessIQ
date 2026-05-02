-- owned by modules/16-help-system
-- Application code generates UUIDs via @assessiq/core uuidv7() and passes them
-- explicitly; the column DEFAULT is only a fallback for raw/tooling inserts.
--
-- `help_content` stores all contextual help copy used by the three-layer help
-- system (tooltip, inline, drawer). The nullable-tenant design lets global
-- defaults (tenant_id IS NULL) apply across all tenants while per-tenant
-- overrides co-exist in the same table — see docs/07-help-system.md for the
-- merge/fallback rules applied at read time.

CREATE TABLE help_content (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- nullable: NULL row = global default; non-NULL = per-tenant override; see docs/07-help-system.md
  tenant_id       UUID,
  key             TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('admin','reviewer','candidate','all')),
  locale          TEXT NOT NULL DEFAULT 'en',
  short_text      TEXT NOT NULL,
  long_md         TEXT,
  version         INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT (Postgres 15+) — required because tenant_id is nullable.
  -- Default UNIQUE semantics treat NULL as distinct from itself, so two global
  -- rows with (NULL, 'foo', 'en', 1) would both insert. The seed migration's
  -- ON CONFLICT (tenant_id, key, locale, version) DO NOTHING clause depends
  -- on this constraint matching NULL = NULL — without NULLS NOT DISTINCT, a
  -- re-run of 0011_seed_help_content.sql would duplicate every global row.
  UNIQUE NULLS NOT DISTINCT (tenant_id, key, locale, version)
);

-- Speeds up the most common read path: single-key lookup with locale + audience
-- filter restricted to active content only.
CREATE INDEX help_content_lookup
  ON help_content (key, locale, audience, status)
  WHERE status = 'active';

-- RLS — NULLABLE-TENANT VARIANT (decision #2, revised).
--
-- Design: four separate FOR-scoped policies instead of one FOR ALL policy.
--
-- WHY NOT a single FOR ALL policy:
--   A FOR ALL (or bare CREATE POLICY without FOR) contributes its USING clause
--   as an implicit WITH CHECK for INSERT/UPDATE. The USING clause here includes
--   `tenant_id IS NULL` to allow global rows to be read. If that same clause
--   were used as WITH CHECK for INSERT, inserting tenant_id = NULL would pass
--   (`NULL IS NULL` = TRUE), allowing the app role to create global rows —
--   defeating the defense-in-depth design. Splitting into FOR SELECT and FOR
--   INSERT makes each policy's intent explicit and avoids the implicit-WITH-CHECK
--   footgun.
--
-- WHY NULLIF(current_setting(..., true), ''):
--   • The `true` arg suppresses "unrecognized configuration parameter" when the
--     GUC has never been SET in this session, returning NULL instead of raising.
--   • NULLIF(..., '') handles pooled connections where a prior transaction left
--     the GUC session-level at '' (empty string). After COMMIT, set_config's
--     tx-local value reverts to the session default ''. The ::uuid cast of ''
--     throws "invalid input syntax for type uuid". NULLIF converts '' to NULL
--     before the cast, preserving fail-closed semantics.
--
-- WHY tenant_id IS NOT NULL in INSERT / UPDATE / DELETE:
--   WITH CHECK only blocks when the expression is FALSE, not NULL.
--   `NULL = <expr>` evaluates to NULL, which would pass. The IS NOT NULL guard
--   makes tenant_id = NULL definitively FALSE.
ALTER TABLE help_content ENABLE ROW LEVEL SECURITY;

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

-- INSERT: only into the current tenant's own bucket.
-- The assessiq_app role CANNOT insert global rows (tenant_id IS NULL) directly.
-- Global defaults are seeded exclusively by the postgres superuser (via
-- 0011_seed_help_content.sql), which BYPASSes RLS.
CREATE POLICY tenant_isolation_insert ON help_content
  FOR INSERT
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );
