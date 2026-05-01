-- owned by modules/01-auth
-- Postgres durable mirror of the Redis session cache. Both are written
-- transactionally on session create; Redis is the fast-path read; this table
-- is authoritative for expiry sweeps, audit queries, and crash recovery.
--
-- Denormalization rationale:
--   `role`        — copied from users.role at session create so that
--                   sessionLoader (runs on every authenticated request) can
--                   enforce role-based access without joining back to users.
--   `last_totp_at` — powers requireFreshMfa(maxAgeMinutes) step-up checks
--                    in the middleware hot path without an extra users-table
--                    read; the value is updated in-place when TOTP is
--                    re-verified.
--
-- FK note: users(id) belongs to modules/03-users (Window 5). The FK is
-- specified intentionally — see Migration 010's task brief for the
-- cross-window apply plan.

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  role            TEXT NOT NULL CHECK (role IN ('admin','reviewer','candidate')),  -- copied from users.role at session create
  token_hash      TEXT NOT NULL UNIQUE,        -- sha256 hex of the cookie value
  totp_verified   BOOLEAN NOT NULL DEFAULT false,
  last_totp_at    TIMESTAMPTZ,                 -- powers requireFreshMfa(maxAgeMinutes)
  ip              INET,
  user_agent      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

-- RLS for sessions: standard tenant_id-keyed two-policy template.
-- Policies must live in the same file as the CREATE TABLE for the linter
-- (tools/lint-rls-policies.ts) to accept them.
--
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON sessions
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
