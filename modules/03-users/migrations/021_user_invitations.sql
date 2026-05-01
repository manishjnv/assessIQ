-- owned by modules/03-users
-- `user_invitations` issues identity-grant tokens for admin/reviewer onboarding.
-- DISTINCT from `assessment_invitations` (05-assessment-lifecycle, Phase 1)
-- which issues task-grant magic-links to candidates for a specific assessment.
-- Both tables share the SHA256-of-base64url-32-byte token primitive but have
-- different TTLs, routes, and consumers. Do not conflate.
--
-- token_hash semantics: sha256 hex of a 32-byte crypto-random base64url token.
-- Plaintext token NEVER persisted — flows only through email body and the
-- 13-notifications JSONL dev log. App-side TTL enforcement: 7 days from creation
-- (addendum § 2). expires_at is the timestamp; the application compares against
-- now() at acceptance time. No CHECK constraint enforces TTL at the DB layer
-- because the policy is application-authored and may evolve per-tenant.
--
-- pgcrypto is already enabled by modules/02-tenancy/migrations/0001_tenants.sql.
--
-- WHY current_setting(..., true) — see 020_users.sql header for the fail-closed
-- rationale. Same pattern.

CREATE TABLE user_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  email           TEXT NOT NULL,
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      UUID NOT NULL REFERENCES users(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-invite hot path (addendum § 3): "is there an unaccepted invitation for
-- (tenant, lower(email))?" Partial-index on accepted_at IS NULL keeps the
-- index small even after the table accumulates accepted rows.
CREATE INDEX user_invitations_email_pending_idx
  ON user_invitations (tenant_id, lower(email))
  WHERE accepted_at IS NULL;

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON user_invitations
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON user_invitations
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
