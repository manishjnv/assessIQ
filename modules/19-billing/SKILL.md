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

**Revoke archives clones (RW-47).** `revokeEntitlement` also sets the tenant's cloned packs of the scope to `status='archived'` in the SAME transaction (pack scope: clones whose `source_pack_id` is the pack, or the clone id itself; domain scope: every clone whose source pack is in that domain) and writes one `tenant.pack_clone_archived` audit row (scope, source pack ids, archived clone ids, count; no content) when at least one clone was archived. Content is never deleted; in-flight attempts keep their snapshotted questions. **Re-granting does NOT un-archive** a clone: a super-admin must restore it explicitly (re-sync / manual status change). The SQL lives in `service.ts`, not in 04 `clone.ts`, because 19 has no dependency on 04 (rejected: adding the dep, or a callback wired from the route).

**Tier definition.** The full Starter/Growth/Enterprise table (owner-decided 2026-10-03) is `docs/plans/PRICING_TIERS_2026-10-06.md`. This SKILL still owns the mechanism (`tenant_plans`, `billing_events`, `tenant_entitlements`); the tier *contents* live in that doc so pricing changes do not require a module SKILL edit.

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
| Cycle-window credit counting (monthly reset) | FU-A2 ✓ (2026-10-06, derived window, migration 0160 index) |
| Second meter: AI-evaluated answers (per attempt + question, same tx as the accept) | FU-A4/FU-A9 ✓ (2026-10-06, migration 0160) |
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
// FU-A4 (2026-10-06): same-tx call from 07 admin-accept, one row per accepted AI grading
recordAiAnswerEvaluated(client: PoolClient, tenantId: string, attemptId: string, questionId: string): Promise<void>
// FU-A2: pure mirror of the SQL window rule (cycle_start + whole months elapsed, month end clamped)
cycleWindowStart(cycleStart: Date, now?: Date): Date
TIER_AI_ANSWERS_INCLUDED: Record<PlanTier, number | null>  // free 20, pro 500, enterprise null, internal null
provisionDefaultPlan(tenantId: string, includedCredits?: number): Promise<void>
computeUsage(tier: PlanTier, includedCredits: number | null, used: number): { remaining, overage, status }
getUsage(tenantId: string): Promise<BillingUsage>
// FU-A3 (2026-10-06): mechanism only, no route wired yet (FU-A5)
tierAllows(tenantId: string, feature: TierFeature): Promise<boolean>
TIER_DISPLAY_NAMES: Record<PlanTier, string>  // free→Starter, pro→Growth, enterprise→Enterprise, internal→Internal

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

## FU-A2 / FU-A4 / FU-A9 (2026-10-06) — monthly window and the AI-answer meter

**What changed.** `countBillingEvents` (and the system-role twin) returns `{ used, ai_used, cycle_window_start }` counted inside the current monthly window; `getAllTenantUsageRaw` does the same per tenant. `insertAiAnswerEvent` writes `event_type = 'ai_answer_evaluated'` rows keyed by (tenant, attempt, question). Migration `0160` (schema in `docs/02-data-model.md`). `BillingUsage`, `TenantUsageRow`, `TenantBillingDetail` carry the new fields; the plan card (`billing.tsx`) and the super-admin drawer show "AI-evaluated answers used / included" and "Counting since".

**Why.** Owner decisions 2026-10-03 (PT1): monthly credits, a second meter for AI evaluation. **Rejected:** rolling `cycle_start` with an UPDATE (no app-role policy; derived value is equivalent); a per-tenant `included_ai_answers` column (tier contents live in the pricing doc; contract overrides are FU-A7). **Not included:** hard caps, overage pricing, the `pending_admin_grading` rename. **Downstream:** 07 `admin-accept.ts` imports `recordAiAnswerEvaluated` (the only call site); `billing-events.test.ts` covers idempotency + window; `compute-usage.test.ts` covers `cycleWindowStart`. The pre-existing Docker probe race (`docker info` 5 s timeout when 5 test files start together) still skips the DB files when the whole package runs at once; run them one file at a time locally.

## Plan tier limits and gates (PT1, PT-4, S14, 2026-10-16)

**What.**
- `TIER_LIMITS` in `src/service.ts` (Free plan, owner 2026-10-19, updated 2026-10-20): free has 5 licensed packs, 200 candidates for each drive (never reached), `max_candidates_total` 5, `ai_attempts_total` 5, and a credit hard stop at 100 % (`overage_hard_cap_ratio` 1.0; was 1.2). Other tiers have `null` (no limit). Full table: `docs/design/2026-10-20-free-tier-limits.md`.
- `assertCandidateTotalCap(tenantId, adding = 1)`: counts `users` rows with `role='candidate'` for the tenant (soft-deleted and erased rows stay counted) through `withTenant`. Wired in `POST /api/admin/invitations` (role candidate), `POST /api/admin/users` (role candidate) and `POST /api/admin/users/import`.
- `assertAiAttemptAllowed(tenantId, attemptId?)`: first the `FREE_PLAN_AI_DISABLED` kill switch (free tier only, code `AI_GRADING_DISABLED`), then `ai_attempts_total`. Counts distinct attempts with cached `attempts.ai_proposals` or an `ai_answer_evaluated` billing event; the attempt being graded is excluded, so a re-run is free. Wired in `apps/api/src/routes/admin-super-evaluations.ts` on `POST .../:attemptId/grade` and `/rerun` (not in 07-ai-grading). The per-tenant AI pause is a separate gate.
- Both helpers are no-ops while `PLAN_TIERS_ENFORCED` is false.
- Feature `cohort_analytics_full` is included from the pro tier.
- Assert helpers: `assertTierAllows(tenantId, feature)`, `assertTierLimit(tenantId, kind, current)`, `assertCreditsUnderHardCap(tenantId)`. Reads: `getTierLimits`, `tierDenial`. A denied call returns 403 with `TIER_NOT_INCLUDED`, `TIER_LIMIT_REACHED`, `CREDITS_HARD_CAP` or `AI_GRADING_DISABLED` (`details { code, tier, feature?, limit?, current? }`).
- `PLAN_TIERS_ENFORCED` (00-core config, default false, `.env.example`). While false, every assert is a no-op and `getUsage` reports `tiers_enforced: false`. `getUsage` adds `tier_limits` and `tiers_enforced`.
- Override column (migration `0186`): `tenant_plans.ai_answers_included_override INT NULL CHECK (>= 0)`. The AI answers included value is `ai_answers_included_override ?? TIER_AI_ANSWERS_INCLUDED[tier]`. `PATCH /api/admin/super/tenants/:id/plan` accepts `aiAnswersIncludedOverride` (400 `INVALID_AI_ANSWERS_OVERRIDE`). The super list `getAllTenantUsage` still shows the tier default.

**Gated routes.**
- Certificates admin routes (module 18, composed in `server.ts`).
- `/api/admin/webhook*` (module 13, option `webhooksGuard`).
- Audit routes (module 14, the `adminOnly` array).
- Cohort breakdown (module 15, option `fullReportGuard`).
- `GET` and `POST` of api-keys. `DELETE` stays open, so a downgraded organisation can revoke keys.
- `embed-admin` and embed secrets.
- Entitlement grant (pack cap; a re-grant of an active scope is not counted).
- Bulk import and single invite with `assessment_id` (hard cap first, then the per-drive cap; the count includes revoked invitations).

**Owner gate to flip the flag.** Flip `PLAN_TIERS_ENFORCED` only after you confirm that no current organisation is blocked. Run this query, and check webhooks, API keys and embed secrets for free-tier organisations:

```sql
SELECT p.tenant_id, count(e.*) FILTER (WHERE e.status='active') AS packs
FROM tenant_plans p LEFT JOIN tenant_entitlements e USING (tenant_id)
WHERE p.tier='free' GROUP BY 1;
```

**Why.** The tier table existed, but no route used `tierAllows`. The flag lets the owner turn the gates on after the check.

**Not included.** Payment flow. Per-tenant limit overrides other than the AI answers override.

**Downstream impact.** Billing page "Plan limits" block: `docs/08-ui-system.md`. Env flag: `docs/06-deployment.md`. Gate wording: `docs/03-api-contract.md`.

## S32 (2026-10-19): Free-plan limits behind `PLAN_TIERS_ENFORCED`

- `TIER_LIMITS.free` = 5 sets, 5 candidates in total (`max_candidates_total`), 5 AI-graded attempts (`ai_attempts_total`), hard stop at 100 % of 25 credits. Paid tiers: null (uncapped).
- Helpers (all no-ops while the flag is off): `assertCandidateTotalCap(tenantId, adding)`, `assertCandidateRoleChange(tenantId, userId, newRole)` (a role flip must not reset the count; added after the S32 gate), `assertAiAttemptAllowed(tenantId, attemptId?)` and the `FREE_PLAN_AI_DISABLED` kill switch (error code `AI_GRADING_DISABLED`).
- `FEATURE_MIN_TIER.certificates` is now `free` (owner 2026-10-19). Webhooks, API keys, embed, audit viewer stay locked.
- Callers: `apps/api` routes `admin-users.ts`, `invitations.ts`, `admin-super-evaluations.ts` (a pre-handler; `modules/07-ai-grading` is untouched).
- **Known gaps, accepted.** Check-then-act race and CSV double-count are closed by Z-71 (below). The AI count is not a perfect ledger: a Grade run that fails before caching proposals is not counted, and `release-to-tenant` clears the cache. Only a super admin can reach those cases.
- Tools: `tools/free-tier-at-risk.sql` (read-only), `tools/pilot-tenant-to-paid.sql` (written, ends in ROLLBACK). Full design: `docs/design/2026-10-20-free-tier-limits.md`.

## Z-93 credit ledger (2026-10-20)

- **What.** `credit_grants` (balance with expiry) and `credit_burns` (one row per graded attempt), migration 0215. Constants live only in `src/burn-rates.ts` (`BURN` mock 1, real 2, real with camera 3; `FREE_MONTHLY_CREDITS` 20; 12 months validity; low-balance ratio 0.2). SQL is in `src/credit-repository.ts`.
- **Burn.** `recordGradedAttempt` calls `burnCredits` in the same transaction as the `billing_events` row. The test type comes from `attempts.delivery_mode` and `attempts.camera_enabled`. Grants are locked `FOR UPDATE` and used oldest-expiry first, split across grants when needed. It never throws on a short balance: the missing part is stored as `credit_burns.shortfall`. A repeat call for the same attempt does nothing. Unlimited tenants (`included_credits` NULL) and tenants without a plan row are skipped. Mock attempts burn 1 and never touch certificates.
- **Grants.** `grantCredits` (super admin, route `POST /api/admin/super/tenants/:tenantId/credits`) writes under the system role, then audits as `billing.credits_granted` under the app role in the same transaction (same two-role pattern as `updateTenantPlan`). `provisionDefaultPlan` also inserts the free monthly grant for the current month.
- **Jobs (worker, no AI).** `credit-free-refill` on `10 0 1 * *`: zero the free grants of earlier months, add 20 credits for this month (unique index = idempotent, no rollover). `credit-expire` on `20 2 * * *`: zero `remaining` of expired grants.
- **Why.** Pay-per-credit plans need one balance with expiry and an audit trail. The old window counter stays for the existing usage banner.
- **Considered and rejected.** A balance column on `tenant_plans` (no UPDATE policy there, no history). Failing grading on a short balance (revenue vs. availability: grading must not fail). One burn row per grant (kept one row per attempt).
- **Not included.** Prices and invoices, low-balance e-mail (no existing helper that fits: skipped), rollover, refunds, any reader of `delivery_mode` (Z-89).
- **Downstream.** `GET /api/billing/usage` has a `credits` object. `assertCreditsUnderHardCap` uses the balance for a Free tenant with grants. Tier change (`PATCH .../plan`) is unchanged: it does not add or remove grants, so a tenant moved to Free gets credits at the next monthly refill.

## Z-71 (2026-10-20): race-safe candidate cap

- **What.** Table `tenant_candidate_counted` (migration 0222). `countCandidateOrRefuse(client, tenantId, userId)` in `service.ts` (query `recordCandidateCounted` in `repository.ts`): no-op while the flag is off or the tier has no `max_candidates_total`. Otherwise it takes `pg_advisory_xact_lock` on the tenant, inserts the user id (`ON CONFLICT DO NOTHING`), counts the tenant rows and throws the same `TIER_LIMIT_REACHED` when the count is above the cap. Call it inside the transaction that writes the candidate: the refusal rolls back the user and the counted row.
- **Wired in.** `03-users` `createUser` (candidate), `importCandidates` (new users only, so existing emails are not double-counted; a refusal aborts the whole file), `updateUser` (role flip to candidate), `12-embed-sdk` `resolveJitUser`. `03-users` and `12-embed-sdk` import `@assessiq/billing` directly (billing depends only on core, tenancy, audit-log, so there is no cycle); both gained a `fastify.d.ts` and the `fastify` dependency because billing routes type-check against the request augmentation. Routes `POST /api/admin/users` and `/import` no longer pre-check. `POST /api/admin/invitations` keeps its pre-check: `inviteUser` rejects the candidate role (501), so no candidate row is made there. Assessment `inviteUsers` (05) invites existing user ids and creates no users, so it needs no guard. `assertCandidateTotalCap` and `assertCandidateRoleChange` stay (the latter blocks candidate to other roles).
- **Why advisory lock.** `tenant_plans` has no UPDATE policy for the app role, so `SELECT ... FOR UPDATE` on it fails; the advisory lock also covers a tenant with no plan row.
- **Rejected.** Row-count check on `users` (race). Lock-free counter column (needs UPDATE rights). **Not included.** The AI-attempt allowance guard (still check then act), the admins cap.

## Z-71 (2026-10-20) - provisionSelfServePlan

- **What.** `provisionDefaultPlanInTx(client, tenantId)` is the client-taking inner step of `provisionDefaultPlan` (same two inserts, no behaviour change). `provisionSelfServePlan(client, tenantId)` (`src/self-serve-plan.ts`) adds the sample-set entitlements: the latest published platform pack of each slug in `FREE_SAMPLE_PACK_SLUGS`, at most 5, through `insertEntitlement`. A slug with no published platform pack is skipped. Today only `campus-placement-aptitude` is listed.
- **Why.** The Free plan, the monthly credit grant and the entitlements must commit with the new tenant (02-tenancy `createSelfServeTenant`). apps/api passes the function in.
- **Not included.** The other four sample slugs (add them to `FREE_SAMPLE_PACK_SLUGS` when published). Cloning the packs into the tenant (the admin adds them from the catalog).
