-- modules/02-tenancy/migrations/0221_self_serve_signup.sql
-- Z-71 / Z-81: self-serve organisation sign-up. Additive only.
--   1. tenants.self_registered   - true for an organisation made through the public sign-up.
--   2. signup_claims             - one row per verified sign-up address (the database guard
--                                  that makes "one organisation per email" race-safe).
--   (tenant_legal_acceptances, the append-only terms / DPA acceptance record, is in
--    modules/03-users/migrations/0223_tenant_legal_acceptances.sql: it references users, and
--    module-local test harnesses apply the 02-tenancy files before any users table exists.)

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS self_registered BOOLEAN NOT NULL DEFAULT false;

-- Platform table (no tenant context). email_key = HMAC-SHA256(server key, normalised email),
-- so the table holds no readable address. The column is named claimed_tenant_id, not
-- tenant_id, on purpose: modules/02-tenancy/src/purge.ts deletes from every table that has
-- a tenant_id column, and a purge must NOT free the email for a second sign-up.
-- RLS is enabled with NO policy: the application role sees and changes nothing here; only
-- the system role (BYPASSRLS, withSystemRole) reaches it.
CREATE TABLE IF NOT EXISTS signup_claims (
  email_key         TEXT PRIMARY KEY,
  claimed_tenant_id UUID REFERENCES tenants(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE signup_claims ENABLE ROW LEVEL SECURITY;

-- Deny-all policies for the application role (the system role has BYPASSRLS). They carry the
-- standard names only because tools/lint-rls-policies.ts matches the text "tenant_id" inside
-- the column name claimed_tenant_id and wants both policies in the file.
CREATE POLICY tenant_isolation ON signup_claims FOR SELECT USING (false);
CREATE POLICY tenant_isolation_insert ON signup_claims FOR INSERT WITH CHECK (false);

REVOKE ALL ON signup_claims FROM assessiq_app;
