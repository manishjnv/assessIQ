# 19-billing — Usage metering and plan management

## Status
**A1 COMPLETE** — Phase A1 Session 1 (2026-05-17). Scaffold, migrations, repository,
service (including pure computeUsage), routes, wire-in to admin-accept.ts and
server.ts. Unit tests (compute-usage) pass; DB-backed tests skip gracefully
without Docker.

## Purpose

Track and surface credit consumption for each tenant. One credit = one candidate
attempt reaching `graded` status. Enforcement is **soft** in A1: the system records
usage and exposes it via `GET /api/billing/usage` but does NOT block grading when
a tenant is over-quota. Hard entitlement enforcement (block grading, UI paywall)
is Phase B/C scope.

## Tables

### `tenant_plans` (migration 0078)

One row per tenant. Stores the billing tier and credit allowance.

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | UUID PK → tenants | One plan per tenant |
| `tier` | TEXT | `free` / `pro` / `enterprise` / `internal` |
| `included_credits` | INTEGER nullable | NULL ⇒ unlimited (internal tier) |
| `cycle_start` | TIMESTAMPTZ | Billing anchor; used in A2 cycle-window queries |
| `status` | TEXT | `active` / `suspended` |
| `notes` | TEXT | Operator-only free-form notes |
| `created_at` / `updated_at` | TIMESTAMPTZ | Standard AssessIQ timestamps |

RLS: SELECT + INSERT from assessiq_app (own tenant). No UPDATE/DELETE in A1 —
plan mutation goes through assessiq_system (BYPASSRLS) in A2.

### `billing_events` (migration 0079)

Append-only ledger. One row per graded attempt per tenant.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `tenant_id` | UUID → tenants | RLS-scoped |
| `attempt_id` | UUID → attempts | ON DELETE CASCADE (GDPR purge) |
| `event_type` | TEXT | `assessment_graded` (A1 only) |
| `occurred_at` | TIMESTAMPTZ | Defaults to now() |

UNIQUE(tenant_id, attempt_id) — idempotency hard guard.
assessiq_app is REVOKED UPDATE, DELETE (mirrors audit_log invariant).

### `tenant_entitlements` — DEFERRED (Phase B)

Will store feature flags and hard usage limits per tenant. Not built in A1.
The soft-enforcement model (warn/over status surfaced to operator) is intentional
for A1 — building the entitlement check infrastructure before the billing portal
exists would create a hard dependency with no user-facing payoff.

## Same-transaction revenue-leak invariant

`recordGradedAttempt(client, tenantId, attemptId)` MUST be called inside the
**same transaction** as the attempt→graded commit. This mirrors `auditInTx`
from modules/14-audit-log: if the billing INSERT fails (FK violation, RLS deny,
network), the enclosing `withTenant` ROLLBACK reverts the grade too. A graded
attempt with no billing row is a revenue leak.

The ON CONFLICT DO NOTHING in `insertBillingEvent` handles the only benign case
(re-grade / admin re-accept). Any other error propagates. **DO NOT wrap
recordGradedAttempt in try/catch.**

The wiring in `modules/07-ai-grading/src/handlers/admin-accept.ts` places the
call after `auditInTx` and before `return gradings;`, inside the `withTenant`
callback — same transaction boundary as the audit row.

## A1 scope vs deferred

| Feature | Phase |
|---|---|
| Record billing event on grade commit | A1 ✓ |
| GET /api/billing/usage (tenant admin) | A1 ✓ |
| Provision default plan on company create | A1 ✓ |
| Backfill existing tenants | A1 ✓ (migration 0080) |
| Billing usage widget in admin dashboard UI | A2 |
| Plan mutation (PATCH tier / credits) — operator | A2 |
| Cycle-window credit counting (monthly reset) | A2 |
| Hard entitlement enforcement (block grading) | Phase B |
| Self-serve plan upgrade UI | Phase C |
| Stripe/payment integration | Phase C |
| `tenant_entitlements` table | Phase B |

## Dependencies

| Module | What we consume |
|---|---|
| `00-core` | `streamLogger` — billing.warn on missing plan row |
| `02-tenancy` | `withTenant` — all DB calls run through this for RLS |
| `06-attempt-engine` | `attempts` table — FK for billing_events.attempt_id |
| `07-ai-grading` | Call site for `recordGradedAttempt` (admin-accept.ts) |

## Public surface

```ts
// Constants
DEFAULT_FREE_CREDITS: 25

// Service
recordGradedAttempt(client: PoolClient, tenantId: string, attemptId: string): Promise<void>
provisionDefaultPlan(tenantId: string, includedCredits?: number): Promise<void>
computeUsage(tier: PlanTier, includedCredits: number | null, used: number): { remaining, overage, status }
getUsage(tenantId: string): Promise<BillingUsage>

// Routes
registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): Promise<void>
// → GET /api/billing/usage
```

## Routes

```
GET /api/billing/usage   → BillingUsage JSON (company admin, own tenant)
```

## Migrations

| File | Number | Purpose |
|---|---|---|
| `0078_tenant_plans.sql` | 0078 | tenant_plans table + RLS |
| `0079_billing_events.sql` | 0079 | billing_events table + RLS + append-only REVOKE |
| `0080_billing_backfill.sql` | 0080 | Backfill existing tenants; idempotent; run as superuser |

Apply order: 0078 → 0079 → 0080. Depends on tenants (0001) and attempts (0030).
**Do NOT apply without verifying tenant slugs in prod first** (see 0080 header).

## Tests

- `compute-usage.test.ts` — pure unit, always runs (no Docker required)
- `billing-events.test.ts` — DB-backed (testcontainer); skips gracefully without Docker

## Env vars

No new env vars required for A1. The module uses the existing DATABASE_URL
consumed by @assessiq/tenancy's pool singleton.
