-- owned by modules/01-auth
-- Per-tenant signing secrets for embed JWTs (HS256).
--
-- `secret_enc` is the AES-256-GCM envelope of the HS256 signing key.
-- Encryption key: ASSESSIQ_MASTER_KEY (same envelope pattern as totp_secret_enc).
--
-- Two-key rotation grace:
--   The verify path tries `status = 'active'` first.  During a 90-day rotation
--   grace window it falls back to the most-recent `status = 'rotated'` secret.
--   Verification NEVER tries more than two keys — additional accepted keys would
--   create a brute-force oracle (SKILL.md § Decisions captured §5, addendum).
--
-- algorithm column:
--   Informational only. The verify code hard-codes `{ algorithms: ["HS256"] }` and
--   rejects every other value including alg:none, HS384, HS512, RS256. The column
--   exists so admins can confirm the algorithm in tooling without reading the code.

CREATE TABLE embed_secrets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  secret_enc      BYTEA NOT NULL,
  algorithm       TEXT NOT NULL DEFAULT 'HS256',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  rotated_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the verify-path lookup: active key first, fall back to most-recent
-- rotated key during grace. A composite (tenant_id, status) index makes both
-- legs of the two-key lookup a fast index scan rather than a seqscan.
CREATE INDEX embed_secrets_tenant_status_idx
  ON embed_secrets (tenant_id, status);

-- WHY current_setting(..., true):
--   The second argument `true` makes current_setting return NULL instead of
--   raising an error when the GUC is unset. RLS then evaluates
--   `tenant_id = NULL` which is FALSE, so all rows are filtered out.
--   This is fail-closed: an unauthenticated session sees zero rows.
ALTER TABLE embed_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON embed_secrets
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON embed_secrets
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
