-- owned by modules/01-auth
-- Candidate magic-link login tokens. A candidate submits their email address;
-- the server generates a CSPRNG 32-byte token, stores its sha256 hex hash here,
-- and emails the plaintext to the candidate. The candidate clicks the link,
-- the server hashes the plaintext, finds this row, marks it consumed, and mints
-- a 30-day candidate session. Plaintext token is NEVER stored.
--
-- Single-use semantics enforced by the consumed_at IS NULL partial index combined
-- with an atomic UPDATE … RETURNING in the verify path (no separate read step).
-- Token TTL: 15 minutes from creation. Session TTL: 30 days.
--
-- See modules/01-auth/src/candidate-login.ts and SKILL.md § Candidate login.
CREATE TABLE candidate_login_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,           -- sha256 hex of CSPRNG token (never store plaintext)
  expires_at    TIMESTAMPTZ NOT NULL,    -- 15 min from creation
  consumed_at   TIMESTAMPTZ,             -- single-use; set on verify
  requested_ip  INET,
  requested_ua  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX candidate_login_tokens_hash_idx
  ON candidate_login_tokens(token_hash);

CREATE INDEX candidate_login_tokens_user_unconsumed_idx
  ON candidate_login_tokens(user_id) WHERE consumed_at IS NULL;

-- RLS: standard three-policy tenant-isolation template (SELECT + INSERT + UPDATE).
-- current_setting(..., true) is the NULL-safe form: returns NULL instead of
-- raising an error when the GUC is unset. RLS then evaluates
-- `tenant_id = NULL` which is FALSE, so all rows are filtered out (fail-closed).
ALTER TABLE candidate_login_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON candidate_login_tokens FOR SELECT
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

CREATE POLICY tenant_isolation_insert ON candidate_login_tokens FOR INSERT
  WITH CHECK (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );

CREATE POLICY tenant_isolation_update ON candidate_login_tokens FOR UPDATE
  USING (
    current_setting('app.current_tenant', true) IS NOT NULL
    AND current_setting('app.current_tenant', true) <> ''
    AND tenant_id = current_setting('app.current_tenant', true)::uuid
  );
