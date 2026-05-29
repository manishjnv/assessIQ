-- modules/20-data-rights/migrations/0101_consent_events.sql
-- Module 20 S1 — DPDP / GDPR consent ledger.
--
-- PURPOSE:
--   Append-only ledger of per-user consent grants and withdrawals. Each
--   action is one row; withdrawal does NOT delete the grant row, it inserts
--   a new row with withdrawn_at set and granted_at NULL. The full ledger
--   reconstructs by chronological ordering. Mirrors audit_log's
--   append-only posture and same two-policy RLS template.
--
-- APPEND-ONLY INVARIANT (load-bearing per CLAUDE.md):
--   The assessiq_app role is REVOKED UPDATE, DELETE, TRUNCATE on this table.
--   Only assessiq_system may DELETE rows (e.g. tenant-level GDPR-erasure
--   sweep). Application code must NEVER issue UPDATE or DELETE on
--   consent_events. The lint-rls-policies tool checks for this invariant
--   via the existing audit_log convention.
--
-- RELATIONSHIP TO tenants.privacy_disclosed:
--   `tenants.privacy_disclosed` (12-embed-sdk migration 0071) is a
--   TENANT-LEVEL embed-SDK gate — not a per-user candidate consent. It is
--   not a backfill source for this table; new consent_events rows are
--   written prospectively from S6 onward via the magic-link
--   invitation-accept page.
--
-- RLS:
--   Two-policy template (SELECT + INSERT). UPDATE and DELETE policies are
--   ABSENT — RLS denies by default. REVOKE below is defence-in-depth.

CREATE TABLE consent_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  purpose         TEXT NOT NULL
                    CHECK (purpose IN ('data_processing', 'marketing', 'benchmarking')),
  policy_version  TEXT NOT NULL,
  granted_at      TIMESTAMPTZ,
  withdrawn_at    TIMESTAMPTZ,
  ip              INET,
  user_agent      TEXT,
  lawful_basis    TEXT NOT NULL
                    CHECK (lawful_basis IN ('consent', 'legitimate_interest', 'contract', 'legal_obligation')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Invariant: at least one of granted_at / withdrawn_at must be set on every row.
  -- A row with both NULL is meaningless; a row with both set represents the
  -- shorthand "granted then immediately withdrawn" within a single event,
  -- which we never emit but accept for forward compatibility.
  CHECK (granted_at IS NOT NULL OR withdrawn_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Row Level Security — append-only (SELECT + INSERT only; UPDATE/DELETE absent)
-- ---------------------------------------------------------------------------

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own rows.
CREATE POLICY tenant_isolation ON consent_events
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
CREATE POLICY tenant_isolation_insert ON consent_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no UPDATE or DELETE policies — RLS denies by default. Load-bearing.

-- ---------------------------------------------------------------------------
-- Revoke DML from the application role — defence-in-depth
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON consent_events FROM assessiq_app;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary access pattern: "what is this user's current consent for X purpose?"
-- Implemented at query time as: SELECT * FROM consent_events
--   WHERE tenant_id=$1 AND user_id=$2 AND purpose=$3
--   ORDER BY created_at DESC LIMIT 1
CREATE INDEX consent_events_user_purpose_idx
  ON consent_events (tenant_id, user_id, purpose, created_at DESC);

-- Secondary: "show me this tenant's consent ledger" (admin view).
CREATE INDEX consent_events_tenant_created_idx
  ON consent_events (tenant_id, created_at DESC);
