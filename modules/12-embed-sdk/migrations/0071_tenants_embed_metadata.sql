-- Phase 4: two embed-related metadata columns.
-- Spec: modules/12-embed-sdk/SKILL.md § Decisions captured (2026-05-03) D6, D13.
-- docs/02-data-model.md § Tenancy + § Users & auth need same-PR updates.
--
-- privacy_disclosed: DPDP / GDPR / CCPA gate for embed secret creation (D13).
--   Prevents createEmbedSecret from succeeding until the tenant admin confirms
--   that the integration is covered by their privacy disclosure to end users.
--
-- session_type: discriminates standard (admin/candidate) sessions from embed
--   sessions (aiq_embed_sess cookie, SameSite=None+Secure) in the sessions table.
--   Default 'standard' so all existing session rows are unaffected (D6).
--
-- RLS note:
--   tenants: special-cased RLS; no new policy needed.
--   sessions: standard two-policy RLS on tenant_id; existing policies cover new column.

-- tenants: privacy disclosure gate
ALTER TABLE tenants
  ADD COLUMN privacy_disclosed BOOLEAN NOT NULL DEFAULT FALSE;

-- sessions: session type discriminator
ALTER TABLE sessions
  ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (session_type IN ('standard', 'embed'));

CREATE INDEX sessions_session_type_idx
  ON sessions (session_type, tenant_id, expires_at);
