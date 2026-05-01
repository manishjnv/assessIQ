-- owned by modules/01-auth
--
-- What this table represents:
--   oauth_identities links external Identity Provider (IdP) subjects to
--   AssessIQ users. Each row records that a specific IdP account (identified by
--   the combination of `provider` + `subject`, where `subject` is the `sub`
--   claim in the OIDC token) has been linked to a given AssessIQ user. Today
--   only Google SSO is wired; the provider CHECK constraint is intentionally
--   forward-declared for Microsoft, Okta, SAML, and generic OIDC so Phase 2+
--   IdP expansion requires no schema change.
--
-- Why tenant_id is denormalized here:
--   The canonical data model (docs/02-data-model.md § Schema note (2026-05-01))
--   records that tenant ownership is reachable transitively via
--   oauth_identities.user_id → users.tenant_id. However, CLAUDE.md hard rule #4
--   and the tools/lint-rls-policies.ts linter both require that every domain
--   table with a `tenant_id` column carry the standard two-policy RLS template
--   (tenant_isolation + tenant_isolation_insert) directly on the table. A
--   denormalized tenant_id column is therefore added here so that:
--     (a) RLS can be expressed as a simple column equality without a subquery
--         JOIN on users (which would be invisible to the linter and expensive
--         at read time), and
--     (b) the linter passes in CI without special-casing this table.
--   The column is kept in sync with users.tenant_id at insert time by the
--   application layer (modules/01-auth). See docs/02-data-model.md §
--   Schema note (2026-05-01) and modules/01-auth/SKILL.md §
--   "Schema deviations from 02-DATA" for the full rationale and rejected
--   alternatives.

CREATE TABLE oauth_identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),  -- denormalized from users.tenant_id; see docs/02-data-model.md § Schema note (2026-05-01)
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google','microsoft','okta','saml','custom_oidc')),
  subject         TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  raw_profile     JSONB,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)              -- global; one IdP identity = one user across all tenants
);

-- Phase 0 index note: the UNIQUE (provider, subject) constraint above already
-- creates a btree index usable for the IdP-callback lookup (provider + subject
-- is the natural key for the callback path). A composite (tenant_id, user_id)
-- index may be added in Phase 1 if query profiling shows it is needed.

-- RLS for oauth_identities: standard tenant_id-keyed two-policy template.
-- Policies must live in the same file as the CREATE TABLE for the linter
-- (tools/lint-rls-policies.ts) to accept them.
--
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE oauth_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON oauth_identities
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON oauth_identities
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
