-- modules/14-audit-log/migrations/0050_audit_log.sql
-- Phase 3 G3.A — append-only audit trail table.
--
-- PURPOSE:
--   Records every state-changing action with actor, before/after state,
--   IP, user-agent, and timestamp. Required for HR/L&D-grade defensibility,
--   compliance audits, and forensic investigation. Default retention: 7 years.
--   See docs/02-data-model.md § audit_log and modules/14-audit-log/SKILL.md.
--
-- APPEND-ONLY INVARIANT (load-bearing rule per CLAUDE.md):
--   The assessiq_app role is REVOKED UPDATE, DELETE, TRUNCATE on this table.
--   Only assessiq_system (BYPASSRLS superuser role) may DELETE rows —
--   exclusively via the daily archive job that removes rows AFTER S3 upload
--   confirmation (P3.D11). Application code must NEVER issue UPDATE or DELETE
--   on audit_log. The lint-rls-policies tool checks for this invariant.
--
--   Future sessions: any change to this invariant requires explicit user
--   override + a new RCA + a new SKILL.md amendment (CLAUDE.md load-bearing rule).
--
-- IRREVERSIBILITY NOTE:
--   This migration cannot be rolled back without losing compliance evidence.
--   In the rare case of legitimate bulk truncation (e.g. GDPR erasure for a
--   specific tenant), the procedure is:
--     1. Obtain written authorisation from the data controller.
--     2. Connect as assessiq_system (BYPASSRLS).
--     3. DELETE FROM audit_log WHERE tenant_id = '<tenant>' AND ... ;
--     4. Record the deletion event in the runbook / incident log.
--   There is no automated path for this — it is intentionally manual.
--
-- RLS:
--   Two-policy template (SELECT + INSERT) per docs/02-data-model.md convention.
--   UPDATE and DELETE policies are ABSENT — RLS denies by default.
--   The REVOKE below is a second layer of defence beyond RLS.
--
-- INDEXES:
--   (tenant_id, at DESC) — primary query pattern: "give me this tenant's
--   recent audit events".
--   (entity_type, entity_id) — secondary pattern: "what happened to this
--   specific resource?" Note: this is a cross-tenant index; RLS filters to
--   the correct tenant at query time.
--
-- tenant_settings.audit_retention_years:
--   Added here (same migration) so the column exists before any audit rows
--   are written. Default 7 years covers most compliance windows; tenants
--   may override in range 1–10 years via the admin settings UI.

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  actor_user_id   UUID REFERENCES users(id),
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('user', 'api_key', 'system')),
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       UUID,
  before          JSONB,
  after           JSONB,
  ip              INET,
  user_agent      TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security — append-only (SELECT + INSERT only; UPDATE/DELETE absent)
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own rows.
CREATE POLICY tenant_isolation ON audit_log
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
CREATE POLICY tenant_isolation_insert ON audit_log
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no UPDATE or DELETE policies — RLS denies by default. This is the
-- load-bearing invariant. Do NOT add UPDATE/DELETE policies here.

-- ---------------------------------------------------------------------------
-- Revoke DML from the application role — defence-in-depth
-- ---------------------------------------------------------------------------

-- assessiq_app is the role used by the running application (Fastify/workers).
-- It must NOT be able to UPDATE, DELETE, or TRUNCATE audit_log rows.
-- Only assessiq_system (BYPASSRLS) — used by the daily archive job —
-- retains those permissions (they are not granted to assessiq_app at all,
-- so they are already denied; this REVOKE makes the intent explicit and
-- guards against future accidental GRANTs).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM assessiq_app;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary access pattern: paginated list filtered by tenant + time window.
CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);

-- Secondary: "what happened to resource X?" (filtered by RLS to current tenant).
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- tenant_settings: add audit_retention_years column
-- ---------------------------------------------------------------------------

-- Stores the tenant-specific audit retention window (years).
-- Range: 1–10 years. Default 7 covers ISO 27001 + GDPR requirement.
-- The daily archive job reads this column to determine which rows to archive.
-- IF NOT EXISTS guard: safe to re-run (idempotent).
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS audit_retention_years INT NOT NULL DEFAULT 7
    CHECK (audit_retention_years BETWEEN 1 AND 10);
