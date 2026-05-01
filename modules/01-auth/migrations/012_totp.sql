-- owned by modules/01-auth
-- Per-user secret material: TOTP envelope and (Phase 3+) password hash.
--
-- WHAT THIS TABLE HOLDS
--   One row per user, keyed by user_id (PK). Stores the AES-256-GCM-encrypted
--   TOTP secret, enrollment/last-use timestamps, and a stub password_hash column
--   for argon2id password auth (Phase 3+ only; NULL until password auth is enabled).
--
-- WHY 20 BYTES (RFC 4226 §4)
--   RFC 4226 §4 recommends a minimum of 160 bits (20 bytes) for the TOTP shared
--   secret. Every major authenticator app (Google Authenticator, Authy, 1Password,
--   Microsoft Authenticator) defaults to HMAC-SHA1 with a 20-byte secret. Using
--   32 bytes causes "code never matches" failures with apps that ignore the
--   `algorithm` parameter and default to SHA-1. See SKILL.md § Decisions §3.
--   The PLAN doc's earlier "32-byte" figure was wrong; this file and 04-auth-flows.md
--   line 102 ("20-byte secret") are authoritative.
--
-- WHY tenant_id IS DENORMALIZED
--   The original data model reached tenancy transitively via users.tenant_id.
--   The lint-rls-policies linter (tools/lint-rls-policies.ts) requires a direct
--   tenant_id column in every table that carries RLS policies, because:
--     (a) the linter cannot parse JOIN-subquery USING clauses;
--     (b) a JOIN-based policy pays a subquery cost on every read;
--     (c) if users.tenant_id ever changes, the JOIN silently breaks.
--   See SKILL.md § "Schema deviations from 02-DATA" and docs/02-data-model.md
--   § Schema note (2026-05-01) for the full rationale.
--
-- ENCRYPTION
--   totp_secret_enc is the AES-256-GCM output of a random 20-byte secret.
--   The master key is ASSESSIQ_MASTER_KEY (env var). Plaintext secret is never
--   persisted. See SKILL.md § Decisions §3 for the full encryption contract.

CREATE TABLE user_credentials (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES tenants(id),
  totp_secret_enc      BYTEA,                  -- AES-256-GCM envelope of a 20-byte SHA-1 TOTP secret
  totp_enrolled_at     TIMESTAMPTZ,
  totp_last_used_at    TIMESTAMPTZ,
  password_hash        TEXT,                   -- argon2id, only if password auth enabled in Phase 3+
  password_set_at      TIMESTAMPTZ
);

-- RLS for user_credentials: standard tenant_id-keyed two-policy template.
-- Policies must live in the same file as the CREATE TABLE for the linter
-- (tools/lint-rls-policies.ts) to accept them.
--
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON user_credentials
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON user_credentials
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
