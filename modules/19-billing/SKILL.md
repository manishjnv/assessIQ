# 19-billing — Usage metering and plan management

## Status
**A1, A2, B1 and B2 shipped** (A1 2026-05-17 `111dd77`; A2 `66ea0ff`; B1 entitlements `2ba822d`; B2 publish-time entitlement enforcement `5c80aaa`; clone-on-use Step 2 followed). Detail below describes A1 and is kept as history. Scaffold, migrations, repository,
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

### `tenant_entitlements` — SHIPPED (migrations 0081, 0082; B1/B2)

> **FU-A1 (2026-10-06): this section was stale.** It said "DEFERRED (Phase B)… not built in A1". Entitlements shipped in commits `2ba822d` (B1) and `5c80aaa` (B2, publish-time enforcement). See the Routes section below for the three live routes.

Stores feature flags and hard usage limits per tenant. `assertPublishEntitled` is a hard gate: `403 NOT_ENTITLED` at publish time; `internal` tier bypasses; fail-closed when no plan row. Super admin grants/revokes scope (`apps/api/src/routes/admin-super.ts:970,1024`).

**Tier definition.** The full Starter/Growth/Enterprise table (owner-decided 2026-10-03) is `docs/plans/PRICING_TIERS_2026-10-06.md`. This SKILL still owns the mechanism (`tenant_plans`, `billing_events`, `tenant_entitlements`); the tier *contents* live in that doc so pricing changes don't require a module SKILL edit.

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

> **FU-A1 (2026-10-06): this table was stale past A1/A2.** `tenant_entitlements` is live (see above), not Phase B. Self-serve upgrade UI and Stripe/payment integration stay not built; Razorpay is the decided provider (FU-A7), not Stripe.

| Feature | Phase |
|---|---|
| Record billing event on grade commit | A1 ✓ |
| GET /api/billing/usage (tenant admin) | A1 ✓ |
| Provision default plan on company create | A1 ✓ |
| Backfill existing tenants | A1 ✓ (migration 0080) |
| Billing usage widget in admin dashboard UI | A2 ✓ |
| Plan mutation (PATCH tier / credits) — operator | A2 ✓ |
| `tenant_entitlements` table + enforcement | B1/B2 ✓ (`2ba822d`, `5c80aaa`) |
| Cycle-window credit counting (monthly reset) | Not built — FU-A2 |
| Hard entitlement enforcement at non-publish routes (webhooks, API keys, embed, certs, audit) | Not built — FU-A5 |
| Self-serve plan upgrade UI | Phase C |
| Payment integration (Razorpay, decided 2026-10-03) | Not built — FU-A7 |

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

> **FU-A1 (2026-10-06): this section listed only one route; two more shipped with B1/B2.**

```
GET /api/billing/usage           → BillingUsage JSON (company admin, own tenant)
GET /api/billing/entitlements     → tenant's granted entitlement scopes (company admin, own tenant)
GET /api/billing/available-sets   → platform packs available to license (company admin, own tenant)
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

## CSV formula guard (RV77, 2026-10-03)

The billing export now prefixes a cell that starts with `= + - @` with `'` (one unit test). Before, this writer had no guard. Not included: merging the CSV escape functions into one helper.
