-- owned by modules/02-tenancy
-- Provides gen_random_uuid() for the DEFAULT fallback below.
-- Application code generates UUIDs via @assessiq/core uuidv7() and passes them
-- explicitly; the column DEFAULT is only a fallback for raw/tooling inserts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- owned by modules/02-tenancy
-- `tenants` is the root multi-tenancy anchor. Every other domain table carries a
-- tenant_id FK back to tenants(id). The application role (assessiq_app) connects
-- with RLS active; the system role (assessiq_system) may bypass RLS for support
-- tooling (see 0002_rls_helpers.sql).
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,         -- 'wipro-soc'
  name            TEXT NOT NULL,
  domain          TEXT,                         -- 'wipro.com' for SSO domain restriction
  branding        JSONB DEFAULT '{}'::jsonb,    -- logo URL, colors, favicon
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- owned by modules/02-tenancy
-- JSONB shape contract for auth_methods and features lives in docs/02-data-model.md:59-71.
-- webhook_secret is stored encrypted at the application layer before insert.
CREATE TABLE tenant_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auth_methods        JSONB NOT NULL DEFAULT '{"google_sso":true,"totp_required":true}'::jsonb,
  ai_grading_enabled  BOOLEAN NOT NULL DEFAULT true,
  ai_model_tier       TEXT NOT NULL DEFAULT 'standard' CHECK (ai_model_tier IN ('basic','standard','premium')),
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- feature flags
  webhook_secret      TEXT,                                  -- for outgoing webhooks (encrypted)
  data_region         TEXT DEFAULT 'in',                     -- for future multi-region
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS for tenant_settings: standard tenant_id-keyed policy.
-- Policies must live in the same file as the CREATE TABLE for the linter
-- (tools/lint-rls-policies.ts) to accept them.
-- The tenants table RLS lives in 0003_tenants_rls.sql (no tenant_id column,
-- so the linter does not flag that file for missing policies here).
--
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_settings
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
