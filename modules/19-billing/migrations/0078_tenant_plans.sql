-- modules/19-billing/migrations/0078_tenant_plans.sql
-- Phase A1 Session 1 — tenant billing plans table.
--
-- PURPOSE:
--   Tracks the billing tier and credit allowance for each tenant.
--   Used for soft enforcement of the 1-credit-per-graded-attempt metering
--   model. "Soft enforcement" means the system surfaces over-quota warnings
--   to the platform operator and tenant admin but does NOT hard-block grading
--   (blocking would require a real-time entitlement check in the hot grading
--   path — that is Phase B/C scope). See modules/19-billing/SKILL.md.
--
-- DESIGN DECISIONS:
--
--   1. tenant_id is the PRIMARY KEY (not a separate UUID id).
--      There is exactly one plan per tenant at any moment. A surrogate PK
--      would add no value and complicate the FK in billing_events.
--      ON DELETE CASCADE: if a tenant is purged, its plan row is purged too.
--
--   2. included_credits NULL ⇒ unlimited.
--      The 'internal' tier (platform + internal tenants like 'wipro-soc') has
--      NULL included_credits so they are never flagged as over-quota regardless
--      of usage volume. NULL is chosen over a magic large integer because it
--      is semantically unambiguous and propagates cleanly through the arithmetic
--      in service.computeUsage (null-check → 'unlimited' branch, no division).
--
--   3. NO UPDATE/DELETE RLS policy in A1.
--      Plan mutation (PATCH tier / custom credits / cycle_start) is A2 scope
--      and goes through the assessiq_system BYPASSRLS role (superuser-equivalent
--      used by operator scripts). An A1 company admin can only SELECT its own
--      row (via the SELECT policy); the provisioning hook INSERTs under the new
--      tenant's context so the INSERT WITH CHECK passes. Omitting UPDATE/DELETE
--      policies from assessiq_app means the app role cannot mutate plan rows at
--      all without assessiq_system — intentional (plan changes are operator
--      actions, not self-serve in A1). RLS denies by default for absent policies.
--
--   4. cycle_start defaults to now().
--      In A2, the billing cycle engine will set this to the tenant's actual
--      billing anchor date (e.g. monthly reset). For A1 it is recorded but
--      not used in any query — the COUNT(*) in countBillingEvents is lifetime,
--      not cycle-window.
--
--   5. status CHECK ('active'|'suspended').
--      'suspended' is reserved for operator-initiated lockout (non-payment,
--      policy violation). The grading path will check this in Phase B when
--      hard enforcement is added. In A1 the column exists but is not enforced.
--
--   6. notes TEXT — free-form operator notes (contract terms, exceptions, etc.).
--      Not surfaced to tenant admins; visible only in operator tooling.
--
-- APPLY ORDER:
--   Depends on: tenants (0001 — 02-tenancy).
--   Must run BEFORE 0079_billing_events.sql (billing_events has no FK to
--   tenant_plans, but run in numeric order for hygiene).
--   Must run BEFORE any session that reads/writes tenant_plans.
--
-- DO NOT APPLY manually — human applies surgically per CLAUDE.md rule #8.

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_plans (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tier             TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro','enterprise','internal')),
  included_credits INTEGER CHECK (included_credits IS NULL OR included_credits >= 0),
  cycle_start      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own plan row.
-- Standard AssessIQ RLS pattern (same as audit_log, attempts, billing_events).
CREATE POLICY tenant_isolation_select ON tenant_plans
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
-- Used by provisionDefaultPlan (called from the createCompany hook under
-- the new tenant's withTenant context).
CREATE POLICY tenant_isolation_insert ON tenant_plans
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no UPDATE or DELETE policies — RLS denies by default.
-- Plan mutation (PATCH tier / custom credits) is A2 and goes through
-- assessiq_system (BYPASSRLS superuser role). assessiq_app cannot UPDATE
-- or DELETE tenant_plans rows in A1. This is intentional.
