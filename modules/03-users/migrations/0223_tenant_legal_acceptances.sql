-- modules/03-users/migrations/0223_tenant_legal_acceptances.sql
-- Z-81: append-only record of the terms / DPA a self-serve sign-up accepted. Additive only.
-- Lives in 03-users (not 02-tenancy) because it references users(id): several module-local
-- test harnesses apply every 02-tenancy file before a users table exists. Written by
-- modules/02-tenancy/src/self-serve.ts inside the sign-up transaction.

-- Acceptance evidence. Written once, inside the sign-up transaction, under the system role.
-- ip_hash / user_agent_hash are HMACs with a server key, never the plain values.
CREATE TABLE IF NOT EXISTS tenant_legal_acceptances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  document         TEXT NOT NULL CHECK (document IN ('terms', 'dpa')),
  version          TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 32),
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash          TEXT,
  user_agent_hash  TEXT,
  UNIQUE (tenant_id, user_id, document, version)
);

CREATE INDEX IF NOT EXISTS tenant_legal_acceptances_tenant_idx
  ON tenant_legal_acceptances (tenant_id, accepted_at);

ALTER TABLE tenant_legal_acceptances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_legal_acceptances
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_legal_acceptances
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- No UPDATE or DELETE policy exists; the grants are removed as a second layer. The system
-- role keeps its grants, so the tenant purge (system role) can still remove the rows.
REVOKE UPDATE, DELETE, TRUNCATE ON tenant_legal_acceptances FROM assessiq_app;
