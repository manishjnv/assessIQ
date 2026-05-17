-- modules/19-billing/migrations/0079_billing_events.sql
-- Phase A1 Session 1 — append-only billing events ledger.
--
-- PURPOSE:
--   Records one row per graded candidate attempt (event_type = 'assessment_graded').
--   Each row represents one consumed credit. The table is append-only — no
--   UPDATE or DELETE from the application role (mirrors the module-14 audit_log
--   invariant). See modules/19-billing/SKILL.md for the revenue-leak invariant.
--
-- APPEND-ONLY INVARIANT (mirrors modules/14-audit-log/migrations/0050_audit_log.sql):
--   The assessiq_app role is REVOKED UPDATE, DELETE on this table.
--   Only assessiq_system (BYPASSRLS superuser role) may DELETE rows — e.g. for
--   GDPR attempt-purge (see ON DELETE CASCADE note below). Application code must
--   NEVER issue UPDATE or DELETE on billing_events.
--
-- DESIGN DECISIONS:
--
--   1. UNIQUE(tenant_id, attempt_id) — idempotency constraint.
--      The application uses ON CONFLICT DO NOTHING at the call site
--      (insertBillingEvent in repository.ts). The UNIQUE constraint is the
--      authoritative guard for concurrent or retry scenarios. A re-grade of
--      the same attempt produces exactly one billing row.
--
--   2. attempt_id ON DELETE CASCADE — GDPR attempt-purge.
--      When an attempt is purged for GDPR erasure, the billing row is purged
--      too. This is consistent with the certificates table (modules/18-cert
--      also CASCADE on attempt_id). The credit consumed by the purged attempt
--      is therefore also removed from the ledger — this is intentional: the
--      candidate's data is gone, so their credit usage should be too.
--
--   3. event_type CHECK ('assessment_graded') — extensible enum.
--      Only one event type exists in A1. Future event types (credit_purchase,
--      credit_adjustment, manual_override) are B/C phase and will be added
--      via ALTER TABLE ADD ... TO CHECK constraint or a migration that widens
--      the CHECK. Keeping the column + CHECK (not a separate event_types table)
--      matches the audit_log.action pattern used project-wide.
--
--   4. occurred_at defaults to now() (not GENERATED ALWAYS AS).
--      Allows the caller to pass an explicit timestamp in test fixtures and
--      backfill scenarios without needing a special INSERT path.
--
--   5. No UPDATE/DELETE RLS policies — RLS denies by default.
--      The REVOKE below is a second layer of defence beyond RLS (same rationale
--      as audit_log: future accidental GRANT to assessiq_app would still be
--      blocked by the explicit REVOKE).
--
-- APPLY ORDER:
--   Depends on: tenants (0001), attempts (0030 — 06-attempt-engine),
--               tenant_plans (0078) — run 0079 AFTER 0078 for hygiene.
--   Must run BEFORE any session that records graded-attempt billing events.
--
-- DO NOT APPLY manually — human applies surgically per CLAUDE.md rule #8.

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------

CREATE TABLE billing_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id   UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL DEFAULT 'assessment_graded' CHECK (event_type IN ('assessment_graded')),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attempt_id)
);

-- ---------------------------------------------------------------------------
-- Row Level Security — append-only (SELECT + INSERT only)
-- ---------------------------------------------------------------------------

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own rows.
-- Standard AssessIQ RLS pattern (same as audit_log, attempts, tenant_plans).
CREATE POLICY tenant_isolation_select ON billing_events
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
-- Enforced by assessiq_app when writing billing events in acceptProposals.
CREATE POLICY tenant_isolation_insert ON billing_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no UPDATE or DELETE policies — RLS denies by default. This is the
-- load-bearing invariant. Do NOT add UPDATE/DELETE policies here.

-- ---------------------------------------------------------------------------
-- Append-only enforcement — defence-in-depth (mirrors 0050_audit_log.sql)
-- ---------------------------------------------------------------------------

-- assessiq_app is the role used by the running application (Fastify/workers).
-- It must NOT be able to UPDATE, DELETE, or TRUNCATE billing_events rows.
-- Only assessiq_system (BYPASSRLS) retains those permissions via GDPR purge
-- procedures. The REVOKE makes the intent explicit and guards against future
-- accidental GRANTs to assessiq_app.
REVOKE UPDATE, DELETE, TRUNCATE ON billing_events FROM assessiq_app;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary access pattern: count events for a tenant (getUsage / dashboard).
-- Covering index on tenant_id speeds up the COUNT(*) in countBillingEvents.
CREATE INDEX billing_events_tenant_idx ON billing_events (tenant_id);

-- Secondary: "did this attempt already generate a billing row?" fast-path.
-- The UNIQUE constraint creates an implicit index on (tenant_id, attempt_id)
-- which covers this pattern — no separate index needed.
