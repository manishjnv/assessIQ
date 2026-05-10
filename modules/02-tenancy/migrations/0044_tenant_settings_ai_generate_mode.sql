-- owned by modules/02-tenancy
-- Stage 3.0 — per-tenant AI_GENERATE_MODE override flag.
--
-- Adds ai_generate_mode to tenant_settings so each tenant can be piloted on
-- the sharded generation path independently of the global AI_GENERATE_MODE
-- env var. NULL means "use the global env var". The column is the SQL
-- enforcement of the CHECK constraint; TypeScript enforcement lives in the
-- TenantSettings type in modules/02-tenancy/src/types.ts.
--
-- WHY NOT the existing `features` JSONB column:
--   features is an untyped bag for tenant-specific UI experiments. A
--   first-class operational mode flag would be invisible to TypeScript
--   consumers, fail silently on key misspelling, and require a runtime cast
--   in the handler. See docs/design/2026-05-10-stage-3-promotion-rollout.md §3.
--
-- NULL semantics: NULL means "use global AI_GENERATE_MODE env var". Non-NULL
-- overrides the env var for that tenant only, effective on the next request
-- with no container restart.
--
-- Rollback: UPDATE tenant_settings SET ai_generate_mode = NULL (or 'omnibus')
-- for the affected tenants. The column is left in place — additive-only.
--
-- See docs/design/2026-05-10-stage-3-promotion-rollout.md §3 and §5 Stage 3.0.

ALTER TABLE tenant_settings
  ADD COLUMN ai_generate_mode TEXT
    CHECK (ai_generate_mode IS NULL OR ai_generate_mode IN ('omnibus', 'sharded'))
    DEFAULT NULL;

COMMENT ON COLUMN tenant_settings.ai_generate_mode IS
  'Per-tenant override for AI_GENERATE_MODE. NULL = use global env var. See docs/design/2026-05-10-stage-3-promotion-rollout.md.';
