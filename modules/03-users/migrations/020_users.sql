-- owned by modules/03-users
-- `users` is the per-tenant identity table. Roles: admin | reviewer | candidate.
-- Statuses: active | disabled | pending. Soft-delete via `deleted_at`.
-- pgcrypto is already enabled by modules/02-tenancy/migrations/0001_tenants.sql; we
-- do NOT re-enable it here. UNIQUE (tenant_id, email) is plain — case-insensitive
-- uniqueness is enforced at the application layer via normalizeEmail() per the
-- modules/03-users/SKILL.md § "Decisions captured (2026-05-01)" § 10.
--
-- WHY current_setting(..., true) — the `, true` second argument:
--   With `true`, current_setting returns NULL instead of raising
--   "unrecognized configuration parameter" when the GUC has never been SET.
--   RLS then evaluates `tenant_id = NULL` which is FALSE (SQL three-value logic),
--   so every row is filtered out. This is fail-closed behaviour: an
--   unauthenticated or misconfigured session sees zero rows rather than all rows.

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','reviewer','candidate')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
  metadata        JSONB DEFAULT '{}'::jsonb,    -- employee_id, department, team
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, email)
);

CREATE INDEX users_tenant_role_idx
  ON users (tenant_id, role)
  WHERE deleted_at IS NULL;

-- Prefix-search hot path for listUsers (addendum § 9): case-insensitive prefix
-- on lower(email). text_pattern_ops makes LIKE 'foo%' index-eligible.
CREATE INDEX users_email_lower_idx
  ON users (tenant_id, lower(email) text_pattern_ops)
  WHERE deleted_at IS NULL;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON users
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
