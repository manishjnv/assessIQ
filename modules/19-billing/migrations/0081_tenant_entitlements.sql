-- modules/19-billing/migrations/0081_tenant_entitlements.sql
-- Phase B1 — tenant entitlements table.
--
-- PURPOSE:
--   Tracks which content scopes (domains or packs) each tenant has been
--   explicitly granted access to by a super-admin. Drives the re-gate of
--   AI question generation (Phase B1 Part 4) so that only tenants with an
--   active entitlement for the relevant domain/pack can trigger generation.
--
-- DESIGN DECISIONS:
--
--   1. scope_type IN ('domain','pack').
--      Domain entitlement: tenant can generate/access questions for a given
--      domain slug or domain UUID. Pack entitlement: tenant can access a
--      specific pack UUID. Phase B1 ships domain-level only; pack-level is
--      reserved for Phase B2 but the column is present now to avoid a schema
--      migration mid-sprint.
--
--   2. scope_id TEXT (not UUID).
--      Domain entitlements use the domain string (e.g. 'soc', 'cloud') which
--      may be a slug or free-form label from question_packs.domain — not a
--      UUID. Pack entitlements WILL use UUIDs. Using TEXT accepts both shapes
--      without requiring a separate column or a type-specific cast.
--
--   3. UNIQUE (tenant_id, scope_type, scope_id).
--      One row per tenant+scope combination. Makes grant idempotent via
--      ON CONFLICT DO NOTHING (or DO UPDATE for re-grant of a revoked row).
--      Avoids double-grant races — the constraint is the authoritative guard.
--
--   4. NO UPDATE/DELETE RLS policy by design.
--      Grant and revoke mutations run under assessiq_system (BYPASSRLS), exactly
--      like the A2 tenant_plans mutation in updateTenantPlan. assessiq_app cannot
--      UPDATE or DELETE entitlement rows; the only app-visible operation is
--      SELECT. This is intentional: entitlements are operator-tier actions.
--      Revoke is a status UPDATE (status='revoked'), NOT a hard DELETE — rows
--      are never hard-deleted so the grant/revoke history is permanently readable
--      under assessiq_system for forensics and audit purposes.
--
--   5. granted_by / revoked_by are nullable.
--      Backfill rows (0082_entitlements_backfill.sql) carry NULL in both columns
--      because they represent implied entitlements derived from the pre-B1 data
--      model, not an explicit super-admin grant action. Production grants after B1
--      deploy will always carry the actor's userId.
--
-- APPLY ORDER:
--   Depends on: tenants (0001 — 02-tenancy).
--   Must run BEFORE 0082_entitlements_backfill.sql.
--   Must run BEFORE any B1 deploy that reads/writes tenant_entitlements.
--
-- DO NOT APPLY manually — human applies surgically per CLAUDE.md rule #8.

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_entitlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('domain','pack')),
  scope_id     TEXT NOT NULL,
  granted_by   UUID,                       -- super-admin user id (nullable: backfill rows = NULL)
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_by   UUID,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (tenant_id, scope_type, scope_id)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own entitlement rows.
-- Standard AssessIQ RLS pattern (same as tenant_plans, billing_events, audit_log).
CREATE POLICY tenant_isolation_select ON tenant_entitlements
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
-- Used indirectly — actual grants run under assessiq_system (BYPASSRLS),
-- but this policy is present for structural parity and future compatibility.
CREATE POLICY tenant_isolation_insert ON tenant_entitlements
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no UPDATE or DELETE policies — RLS denies by default for assessiq_app.
-- Grant and revoke run under assessiq_system (BYPASSRLS superuser role).
-- assessiq_app cannot UPDATE or DELETE tenant_entitlements rows. This is
-- intentional: entitlement mutations are operator-tier actions, not self-serve.
-- Revoke = status UPDATE under assessiq_system; hard DELETE is never used.

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary lookup: "which entitlements does this tenant have, and are they active?"
-- Covers getCompanyEntitlements (activeOnly) and listTenantEntitlements (all).
CREATE INDEX tenant_entitlements_tenant_status_idx ON tenant_entitlements (tenant_id, status);
