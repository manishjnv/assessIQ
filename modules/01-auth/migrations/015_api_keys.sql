-- owned by modules/01-auth
-- Server-to-server authentication tokens. The full key (format: aiq_live_<43-char base62>,
-- where base62 = [0-9A-Za-z] encoding of crypto.randomBytes(32)) is shown to the admin
-- ONCE at creation and never again. Storage is sha256(full_key) hex; lookup is
-- "Authorization: Bearer <key>" → sha256 → query api_keys WHERE key_hash = $1
-- AND status = 'active' AND (expires_at IS NULL OR expires_at > now()).
-- key_prefix is the first 12 chars (e.g. aiq_live_xyz4) for admin UI display only —
-- low entropy, leak-safe. See modules/01-auth/SKILL.md § Decisions captured § 6.
--
-- last_used_at is updated asynchronously (fire-and-forget pg query) on every
-- authenticated request — never blocks the request path. Eventual-consistency
-- window is acceptable for an audit-visibility field.
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  key_prefix      TEXT NOT NULL,                    -- first 12 chars, e.g. 'aiq_live_xyz4'
  key_hash        TEXT NOT NULL UNIQUE,             -- sha256(full_key) hex; never store plaintext
  scopes          TEXT[] NOT NULL,                  -- e.g. '{assessments:read,submissions:write}'
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at    TIMESTAMPTZ,                      -- async fire-and-forget; may lag by seconds
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ                       -- NULL = never expires
);

-- Fast lookup for the auth middleware: given a tenant + status filter,
-- narrow to active keys before the key_hash UNIQUE index does the final hit.
-- Also serves the admin "list keys for my tenant" query.
CREATE INDEX api_keys_tenant_status_idx
  ON api_keys (tenant_id, status);

-- RLS: standard two-policy tenant-isolation template.
-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON api_keys
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
