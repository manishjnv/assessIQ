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

## Suggested test time (Z-103, 2026-10-21)

- **Where the numbers live:** `modules/19-billing/src/suggested-time.ts`, the table `MINUTES_PER_QUESTION`. Edit the numbers there; nothing else holds them.
- **Minutes per question:** mcq, multi_select, numeric, ordering: easy 0.75, medium 1.25, hard 1.75. subjective: 5. kql, log_analysis: 6. scenario, structured_case: 10. An unknown type counts as medium mcq (1.25).
- **Difficulty split:** `questions.difficulty_est` 1-2 easy, 3 medium, 4-5 hard, null medium. The function `band()` in the same file holds the split. This split is an assumption (the code has no easy/medium/hard labels); the owner can change it.
- **How it reaches the form:** `GET /api/billing/available-sets` adds `avg_minutes_per_question` for each set (the average over its active questions). The Start a test form shows `ceil(question count x average)` as a suggestion with a "Use suggested time" button. The Z-102 limit stays the override; a full mock keeps its blueprint time.
- **Not included:** any automatic change to existing assessments or tests.

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

- `TIER_LIMITS.free` = 5 sets, 5 candidates in total (`max_candidates_total`), 5 AI-graded attempts (`ai_attempts_total`), hard stop at 100 % of 250 credits (Z-95 scale). Paid tiers: null (uncapped).
- Helpers (all no-ops while the flag is off): `assertCandidateTotalCap(tenantId, adding)`, `assertCandidateRoleChange(tenantId, userId, newRole)` (a role flip must not reset the count; added after the S32 gate), `assertAiAttemptAllowed(tenantId, attemptId?)` and the `FREE_PLAN_AI_DISABLED` kill switch (error code `AI_GRADING_DISABLED`).
- `FEATURE_MIN_TIER.certificates` is now `free` (owner 2026-10-19). Webhooks, API keys, embed, audit viewer stay locked.
- Callers: `apps/api` routes `admin-users.ts`, `invitations.ts`, `admin-super-evaluations.ts` (a pre-handler; `modules/07-ai-grading` is untouched).
- **Known gaps, accepted.** Check-then-act race and CSV double-count are closed by Z-71 (below). The AI count is not a perfect ledger: a Grade run that fails before caching proposals is not counted, and `release-to-tenant` clears the cache. Only a super admin can reach those cases.
- Tools: `tools/free-tier-at-risk.sql` (read-only), `tools/pilot-tenant-to-paid.sql` (written, ends in ROLLBACK). Full design: `docs/design/2026-10-20-free-tier-limits.md`.

## Z-93 credit ledger (2026-10-20)

- **What.** `credit_grants` (balance with expiry) and `credit_burns` (one row per graded attempt), migration 0215. Constants live only in `src/burn-rates.ts` (`BURN` mock 10, real 20, real with camera 30 after Z-95; `FREE_MONTHLY_CREDITS` 200; 12 months validity; low-balance ratio 0.2). SQL is in `src/credit-repository.ts`.
- **Burn.** `recordGradedAttempt` calls `burnCredits` in the same transaction as the `billing_events` row. The test type comes from `attempts.delivery_mode` and `attempts.camera_enabled`. Grants are locked `FOR UPDATE` and used oldest-expiry first, split across grants when needed. It never throws on a short balance: the missing part is stored as `credit_burns.shortfall`. A repeat call for the same attempt does nothing. Unlimited tenants (`included_credits` NULL) and tenants without a plan row are skipped. Mock attempts burn 10 and never touch certificates.
- **Grants.** `grantCredits` (super admin, route `POST /api/admin/super/tenants/:tenantId/credits`) writes under the system role, then audits as `billing.credits_granted` under the app role in the same transaction (same two-role pattern as `updateTenantPlan`). `provisionDefaultPlan` also inserts the free monthly grant for the current month.
- **Jobs (worker, no AI).** `credit-free-refill` on `10 0 1 * *`: zero the free grants of earlier months, add 200 credits for this month (unique index = idempotent, no rollover). `credit-expire` on `20 2 * * *`: zero `remaining` of expired grants.
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

## Credit scale x10 (Z-95, 2026-10-20)

- **What.** Every credit amount is 10 times larger; 1 new credit = 1/10 of an old credit. `BURN` = mock 10, real 20, real with camera 30. `FREE_MONTHLY_CREDITS` = 200. `DEFAULT_FREE_CREDITS` = 250 (was 25). Migration 0225 multiplies existing `credit_grants.credits/remaining`, `credit_burns.credits/shortfall` and non-NULL `tenant_plans.included_credits` by 10 once (guard: a table comment on `credit_grants`; the `remaining_decrease_only` trigger is dropped and recreated inside the migration) and raises the app-role insert limit for a `free_monthly` grant to 200. Help rows: migration 0226.
- **Old meter units.** The `billing_events` meter counts 1 row per graded attempt. It is now reported in credit units: `used` = attempts x `LEGACY_METER_UNITS_PER_ATTEMPT` (10), applied in the three SQL meters in `repository.ts` (`countBillingEvents` incl. the lifetime fallback, `getAllTenantUsageRaw`). So `computeUsage`, the usage banner, the hard-cap ratio and `TIER_LIMITS` keep their logic and compare like with like. `tools/free-tier-at-risk.sql` still counts attempts (25 attempts = 250 credits); only its comments changed.
- **Why.** Finer pricing steps later without fractions.
- **Rejected.** Changing only the price per credit (the monetary value would change for existing buyers).
- **Not included.** Any change to the monetary value of a test, prices, or the rules (expiry, order, no rollover). Rollback is NOT automatic: divide the same columns by 10 and restore the policy limit 20.

**Known approximation (review of 136d09f2, 2026-10-20).** The old per-attempt meter (`billing_events`) is multiplied by 10 for every graded attempt, but a real attempt burns 20 and a camera attempt burns 30 in the ledger. For pro, enterprise and pilot tenants the usage banner and the 80 percent warning therefore understate `used` by a factor of 2 to 3 against `included_credits`. Free tenants with grants use the ledger balance and are exact. Fix later (row Z-96 scope): compute `used` as the sum of `credit_burns.credits` in the cycle for tenants that have grants. Deploy-order note: `tools/deploy.sh` applies migrations before it recreates the services, so for a few minutes the old code runs on scaled data (an old burn of 1 to 3 credits, an unscaled refill grant). Accepted before launch.


## Z-96 part 1: low-balance emails (2026-10-20, migration 0227)

- **What.** The daily `credit-expire` worker tick (`apps/api/src/worker.ts`) also calls `sendCreditLowBalanceNotices(send)` (`service.ts`). For each active tenant with a finite plan it takes the unexpired grants: balance = sum of `remaining`, reference = the largest grant (`credits`, newest first on a tie; a spent grant still counts, so a tenant at zero is told). Balance at or below 20 percent, and separately 10 percent (`LOW_BALANCE_LEVELS`, from `LOW_BALANCE_THRESHOLD_RATIO`), gives one email to the active tenant admins (template `credit_low_balance`, plain text, balance and level, no prices). Table `credit_lowbalance_notices` (`UNIQUE (grant_id, level)`) makes it once per level per grant.
- **Per tenant, one transaction (system role).** Insert the notice rows first (`ON CONFLICT DO NOTHING`; a concurrent tick waits, then skips), send, then write audit row `billing.credit_low_balance_notice` (app role + tenant GUC). If no admin email could be sent (all failed, or no admin), the transaction rolls back, so the notice is not final and the next daily tick retries. A balance that jumps straight below 10 percent records both levels but sends one email (level 10).
- **Billing does not import notifications.** The worker passes the sender in (`LowBalanceSender`), so no new package dependency.
- **Rejected.** A separate queue/cron (the existing tick is enough); a "once per month" rule (the spec says once per level per grant; a Free refill is a new grant, so it can notify again next month); inserting the notice after the send (retry could double-send).
- **Not included.** The expiry-warning email, SMS, in-app banner, the exact usage meter (rest of Z-96). No AI call anywhere on this path. Delivery: `sendEmail` queues the mail, so "sent" means queued; a failure after queueing is handled by the email queue, not by this job.
- **Added outside billing.** Template files, schema and string in `modules/13-notifications`; one catalog entry in `modules/14-audit-log/src/types.ts`.

## Z-96 session 4: exact meter and expiry warning (2026-10-20)

- **Exact meter.** `countBillingEvents` (repository.ts, `USED_SQL`) now returns `used` = sum of `credit_burns.credits` in the current cycle window when the tenant has any `credit_burns` row. With none, it falls back to graded attempts x 10 (old counter). The banner, `GET /api/billing/usage` and the super-admin screens all use this one function, so they agree with the ledger (mock 10, real 20, real with camera 30).
- **Expiry warning.** `sendCreditExpiryNotices` (service.ts) runs in the daily `credit-expire` worker tick. For each non-Free grant with credits left that expires within 30 days, in ONE system-role transaction: insert the `credit_expiry_notices` row (unique guard), write the `billing.credit_expiry_notice` audit row, then send. If no admin mail goes out the transaction rolls back and the next tick retries. No AI call.


## Change history

### 2026-10-20 — Wave 1 batches A to D (session S36): credit ledger, test types, sign-up, candidate cap

Rows: Z-18, Z-70, Z-71, Z-72, Z-79, Z-80, Z-81, Z-83, Z-85, Z-87, Z-89, Z-90, Z-91, Z-93, Z-95, EXP-8 (passages), S32 Free-plan limits. Migrations 0215 to 0226 are applied. `PLAN_TIERS_ENFORCED` is ON since the late S36 owner yes (pilot tenants birla and wipro-soc are `pro`). `SIGNUP_ENABLED` is OFF (sign-up is built and CLOSED). For the final commit and flag state see the S36 block in `docs/SESSION_STATE.md`.

**Summary.** A credit ledger sits beside the old credit counter. Credits expire after 12 months, burn by test type and refill monthly on Free. The organisation admin picks Real exam or Mock test at invite. A separate Mock results dashboard exists. Public self-serve sign-up is built and closed. The 5-candidate Free cap is race-safe. The marketing site has `/dpa`, `/signup` and the terms and privacy edits.

**1. Credit ledger and offline grants (Z-93, Z-79), migration 0215**
- **What.** Tables `credit_grants` (source purchase, free_monthly, bonus or pilot; credits; remaining; expiry after 12 months) and `credit_burns` (one row per graded attempt, test type mock, real or real_camera, `shortfall` column when the balance is too low). Burn takes the oldest-expiring unexpired grant first and splits across grants. Burn amounts and the monthly Free amount are constants in `modules/19-billing/src/burn-rates.ts`.
- **Why.** Owner decision 2026-10-19: credits that expire, burn by test type and refill monthly on Free.
- **Rules that must stay true.** Burn runs in the same transaction as the grade (`recordGradedAttempt`) and never throws on a low balance, because grading must not fail. A tenant with `included_credits` NULL is unlimited and never burns. A Free tenant with grants is capped by its ledger balance, but only while `PLAN_TIERS_ENFORCED` is true.
- **Hardening after review.** The app role may insert only a `free_monthly` grant of at most 20 credits (200 after Z-95). A trigger lets `remaining` only decrease. One purchase invoice reference grants once. The backfill gives a Free tenant at most the monthly amount.
- **Jobs (worker, no AI).** `credit-free-refill` runs daily at 00:10 UTC and is idempotent: the first run each UTC month does the work, later runs do nothing, which heals a missed run. `credit-expire` runs daily at 02:20 UTC.
- **Routes.** `POST` and `GET /api/admin/super/tenants/:tenantId/credits` (super admin only, audit action `billing.credits_granted`, same transaction). `GET /api/billing/usage` gains a `credits` object (additive).
- **UI.** A Credits block on the tenant billing page and a Credits card in the super-admin billing drawer.
- **Not included.** Low-balance emails (done later, Z-96, see below). Online payment. A tier change does not add or remove grants.
- **Known limits.** The `burn_by_type` view counts all-time burns. A backfilled Free grant is replaced at the next refill.

**2. Mock or Real test type, desktop-only rule, readiness check (Z-89, Z-87, Z-91), migrations 0216, 0217, 0219**
- **What.** `delivery_mode` ('real' or 'mock') on `assessments`, `assessment_invitations` and `attempts`. `attempts.camera_enabled` (always false until Wave 2) and `attempts.readiness` (JSON). The admin sets the mode at invite. The server copies it to the attempt under the invitation row lock. A candidate request can never set it.
- **Device rule.** `modules/06-attempt-engine/src/device.ts` decides phone or tablet from `Sec-CH-UA-Mobile`, the user agent, or client-reported touch and screen signals. `readiness.ts` needs a screen of at least 1024 by 600, a recent Chrome, Edge, Firefox or Safari, and a network speed when one is reported.
- **Where enforced.** `POST /take/start` and `POST /api/me/assessments/:id/start`, including a retake from the result page. The gate lives in `startAttempt` and applies when the request route passes `gate`. A mobile client on a real exam gets 403 `DEVICE_NOT_ALLOWED`. A missing or failing readiness check gets 422 `READINESS_FAILED`. Mock tests and the public `/try` demo are never blocked.
- **Mock effects.** No certificate (guards in `09-scoring/release.ts` and in `18-certification` `issueCertificateOnRelease`). `countingAttemptSql` (00-core) counts real attempts only. Migration 0219 recreates `attempt_summary_mv` and `question_stats_mv` with `delivery_mode = 'real'`. A mock does not use up the real exam's retake allowance.
- **Review result.** The first review found that the second start route skipped the gate (high severity). Fixed in commit a3a0b337.
- **Accepted gaps.** (a) Embed starts are exempt from the device and readiness gate, because the host app asserts the candidate. (b) Readiness values are client-reported; only the device header and user agent are independent. (c) Camera, photos and video are Wave 2.
- **Rejected.** Trusting only the page check. A per-organisation opt-out of the desktop rule. A lockdown browser.

**3. Mock results dashboard (Z-90), no migration**
- Five admin-only GET endpoints under `/api/admin/mock/` (summary, topics, students, trend, not-taken) in `modules/15-analytics/src/mock/index.ts`. They read live tables for mock attempts only. The page `/admin/mock-results` has a tab next to Reports. It is read-only and has no export.
- Also fixed: the admin and candidate activity leaderboards, feed and heatmaps now count real exams only.
- Not included: per-question drilldown, export, candidate-started practice tracks.

**4. Self-serve sign-up (Z-71, Z-81), migrations 0221, 0223, CLOSED**
- **Routes (public by design).** `GET /api/public/signup/config`, `POST /api/public/signup/request`, `POST /api/public/signup/verify`. They answer 404 unless `PLAN_TIERS_ENFORCED`, `SIGNUP_ENABLED`, both Turnstile keys and Redis all hold. The config route answers `open:false` while closed.
- **Why public is safe.** No tenant data is read or written before the tenant exists. Controls: Turnstile (single use, bound to action and host); 5 requests a day per source; 3 a day per address; 50 completed sign-ups a day in total; an emailed code with an atomic one-time take in its own Redis key space; one organisation per verified address (`signup_claims`); a brand and look-alike blocklist; a neutral answer that never shows whether an address has an account.
- **One transaction.** `createSelfServeTenant` (02-tenancy) writes the claim, tenant, settings, first admin (role admin only), Free plan and monthly credit grant, sample pack entitlements, DPA and Terms acceptance rows and audit rows. The tenant starts 'provisioning' and becomes 'active' in the same transaction. The taxonomy seed runs right after the commit.
- **DPA.** The form needs both boxes. The server rejects a request without `dpaAccepted`, `termsAccepted` and the right versions (1.0). Acceptance rows store the version, the time and HMAC hashes of the IP and user agent, not the plain values.
- **Review result.** Verdict revise; no takeover path found. Fixed: look-alike organisation names, a missing Terms checkbox, an audit row written before a valid code, mail job data kept after completion, a 500 after a burnt code, and the IP source in verify.
- **Accepted residuals.** A Turnstile farm can fill the daily cap. The 3-a-day address bucket can lock out one victim for a day. A spoofed request replaces a pending code. The cap can overshoot by the number of outstanding codes. The plain request IP and user agent sit in Redis for up to 10 minutes. `email_log.to_address` keeps the plain address. Acceptance rows go with the tenant purge and no archive row is written.
- **Owner decision 2026-10-20 (option A).** An address that already exists in ANY organisation, even only as a candidate, cannot start a new organisation. The visitor gets the neutral screen and the mail "You already have an account". Rejected: allowing sign-up when the address is only a candidate (needs a rule for the old candidate record and the sign-in; revisit when a real customer asks).
- **Not included.** The certificate line "Issued by [Organisation], a self-registered AssessIQ customer" (the flag `tenants.self_registered` is set; the certificate text is a follow-up). The 30-day purge of platform-tenant `email_log` rows. `org_verified`. FU-OTP-ATOMIC for the admin sign-in code.
- **Sample sets.** Only one aptitude pack exists, so a new Free organisation gets 1 sample set, not 5. No page may promise 5. Add slugs to `FREE_SAMPLE_PACK_SLUGS` when more packs are published.

**5. Race-safe candidate cap (Z-71 step b), migration 0222.** `countCandidateOrRefuse` takes a per-tenant advisory lock, records each candidate once in `tenant_candidate_counted` (append-only) and refuses above the cap inside the transaction that creates the user. Wired into user create, CSV import (new users only), role change and the embed JIT user. A delete never lowers the count. A refusal rolls back the user row too. Not wired: `POST /api/admin/invitations` and the assessment invite, because they create no candidates. Detail: section "Z-71 (2026-10-20): race-safe candidate cap" above.

**6. Locked-feature popup (Z-80), UptimeRobot guide (Z-83), Brevo wording (Z-85).** One shared popup on the webhooks and embed pages. No admin page exists for API keys, own email sender or data export, so the popup is not wired there. Guides: `docs/runbooks/uptimerobot-setup.md` and `docs/runbooks/open-signup.md`.

**7. Marketing site.** New pages `/dpa` and `/signup`. Terms and privacy edits from `docs/design/2026-10-19-legal-texts-v1.md`. The old privacy sentence "does not record webcam" now reads "Except for a real exam with the camera on...". The terms effective date is 20 October 2026. Open for the lawyer (owner accepted the risk): the liability floor and the breach-notice hours are the defaults from the legal text. Review is due before the second or third paying customer.

**8. Bug fixed on the way.** The passage draw (`takeUnits`) could refuse an attempt start at random when four single questions came up before two passages. See RCA 2026-10-20.

**9. Credit scale x10 (Z-95).** All credit amounts are 10 times larger (owner 2026-10-20): mock 10, real 20, real with camera 30; Free monthly refill 200; default Free allowance 250. The monetary value of each test is the same. Files: `burn-rates.ts`, `service.ts`, `repository.ts` (old meter reported in credit units, 10 per graded attempt). Migration 0225 (`credit_scale_x10`, scales data once, new insert-policy limit 200). Migration 0226 (help rows `admin.settings.billing.usage` and `.credits_burn`, new version). Sign-up page text: 200 credits each month. Rollback is not automatic: divide `credit_grants`, `credit_burns` and `tenant_plans.included_credits` by 10, restore the policy limit 20, clear the table comment on `credit_grants`, revert the code. Detail: section "Credit scale x10" above.

**Migrations (S36).**

| Migration | Owner module | Purpose |
|---|---|---|
| 0215 | 19-billing | credit_grants, credit_burns, backfill |
| 0216 | 05-assessment-lifecycle | delivery_mode on assessments and invitations |
| 0217 | 06-attempt-engine | delivery_mode, camera_enabled, readiness on attempts |
| 0218 | 16-help-system | help rows (ledger, popup) |
| 0219 | 15-analytics | attempt_summary_mv and question_stats_mv real only |
| 0220 | 16-help-system | help rows (test type, device, readiness) |
| 0221 | 02-tenancy | tenants.self_registered, signup_claims |
| 0222 | 19-billing | tenant_candidate_counted |
| 0223 | 03-users | tenant_legal_acceptances |
| 0224 | 16-help-system | help rows (mock results) |
| 0225 | 19-billing | credit_scale_x10 |
| 0226 | 16-help-system | help rows (billing usage, credits burn) |

**Flags, audit actions, scopes.** New flag `SIGNUP_ENABLED` (default false). Existing flags `PLAN_TIERS_ENFORCED` (default false) and `FREE_PLAN_AI_DISABLED`. New audit actions: `billing.credits_granted`, `signup.completed`, `signup.rejected`. New rate-limit scopes: `signup_ip`, `signup_email`, `signup_global`.

**How to verify.**
1. The public sign-up config route answers `open:false`. `POST /api/public/signup/request` answers 404.
2. `bash tools/post-deploy-sweep.sh` shows 0 failures.
3. As super admin, record a credit grant for a test tenant. The tenant billing page shows the balance.
4. Invite a candidate as Mock and open the link on a phone: it is allowed. Invite as Real and open it on a phone: the page shows "Please open this link on a laptop or desktop computer to take this test".
5. `/admin/mock-results` loads and shows the empty state.

**Rollback.** Code: revert the commits and deploy with `tools/deploy.sh`; all migrations are additive and stay. Sign-up: set `SIGNUP_ENABLED=false` and recreate `assessiq-api`. Plan limits: set `PLAN_TIERS_ENFORCED=false` and recreate `assessiq-api`. Pilot tier change: set the tier back with the platform plan screen, or with `tools/pilot-tenant-to-paid.sql` and the old tier.

**Downstream impact.** `docs/02-data-model.md`, `03-api-contract.md`, `04-auth-flows.md`, `06-deployment.md`, `08-ui-system.md` and the SKILL files of 01, 02, 05, 06, 15 and 19 carry the detail. Z-18 (the flag flip) must follow the pilot tier change: a Free-tier pilot would hit the 5-candidate cap. Wave 2 (camera, photos, video) uses `attempts.camera_enabled` and the burn type `real_camera`.

### 2026-10-20 — Wave 4 small rows (S37): low-balance emails and companions

Rows: Z-96 (part 1), Z-37 (b), Z-20, Z-49, Z-76 (pages 1 to 4), Z-93 (stayed PARTIAL until the expiry warning), RW-1 branch clean-up. Commits: `0bc3e5ad` (main change), `be3da797` (page dates), `6862328a` (review fix with trailer), `160e89e5` (CI fixes; the server runs it, and the marketing container was rebuilt from it). Migration `0227` applied; next free was `0228`. No new flag. No API change, so `docs/03-api-contract.md` is unchanged.

- **Low-balance emails (Z-96 part 1).** Files: `modules/19-billing/src/service.ts` (`sendCreditLowBalanceNotices`), `credit-repository.ts`, `burn-rates.ts` (`LOW_BALANCE_LEVELS` 20 and 10), `index.ts`, `apps/api/src/worker.ts`, `modules/19-billing/migrations/0227_credit_lowbalance_notices.sql`. The daily `credit-expire` tick also sends one email to the tenant admins when the balance is at or below 20 percent, and again at 10 percent, of the largest unexpired grant. One email per level per grant (UNIQUE `grant_id, level`). Full design: section "Z-96 part 1" above.
- **Companions.** Email template `credit_low_balance` in `modules/13-notifications` (html, txt, `en.json`, `render.ts`, `types.ts`, `delivery-policy.ts`): plain mail with balance and level, and a link to the plan tab, no price. One audit action in `modules/14-audit-log/src/types.ts`: `billing.credit_low_balance_notice`. Wording (Z-37 b): invitation_reminder, invitation_admin, admin_email_otp, totp_enrolled, totp_reset_notice and evaluation_queue_alert use the approved wording. Legal wording (Z-20, Z-49): `apps/marketing/src/pages/terms.astro` section 8 uses the approved draft; `privacy.astro` says `/try` carries the Cloudflare beacon. `signup.astro` meta description says one sample set. Router step 1 (`apps/web/src/App.tsx`): `BrowserRouter future={{ v7_startTransition, v7_relativeSplatPath }}`, no version change. The notifications template count test is now 16 (`email-result-copy.test.ts`).
- **Z-76 pages 1 to 4** (four files in `apps/marketing/src/pages/resources/`, plus `resources.astro`, `astro.config.mjs` sitemap and `src/data/page-dates.json`): `/resources/how-to-run-a-campus-aptitude-test`, `/resources/release-campus-test-results`, `/resources/send-test-invitations-to-students`, `/resources/verify-skill-certificate`. Each claim was checked in code: CSV 1,000 rows and 512 KB (`modules/03-users/src/import.ts`), daily mail cap 250 (`bulk-cap.ts`), invite link 7 days, certificate verify fields (`modules/18-certification/src/routes-public.ts`).
- **Why.** Z-96: the owner wants admins told before credits run out. Z-20 and Z-49: the owner approved the wording on 2026-10-19, and the privacy page must match what the site does. Z-76: the owner approved pages 1 to 4; each answers a query no current page answers. Router step 1: owner approved step 1 only; it removes the v7 behaviour risk before any version bump.
- **Rejected.** Sending the mail after the commit (needs an outbox table; the daily job is simple, at-least-once is acceptable, the code has a `ponytail:` comment). A separate worker queue for the notices (the existing tick is enough). Adding the `future` prop to the 31 `MemoryRouter` test files (no test behaviour changed). Building SP11 with a new admin API field (not done here, see S38).
- **NOT included.** SP11 admin ETA notice (the admin app has no value for `EVALUATION_TURNAROUND_TEXT`, server only; done in S38). Z-15 (a) one-time sign-in link (done in S38). Expiry warning email and exact usage meter (done in S38). Z-76 pages 5 to 7 (pages 5 and 6 are later by owner decision). IndexNow ping after the marketing deploy. Opening sign-up, CSP enforce (Z-77), camera and photos, exam content, GATE-8.
- **Bugs found.** (1) `lint:rls` needs a `tenant_isolation_insert` policy on every tenant table, even when the app role cannot insert; fixed in `0227` (policy plus the existing REVOKE). (2) `email-bulk-cap.test.ts` used the fixed date 2026-10-19 and broke after 06:00 UTC on 2026-10-20; fixed with `Date.now()`. (3) `totp-reset-notice.test.ts` still expected the old wording after Z-37 b; fixed. (4) `lint:rls` scans `.claude/worktrees/*`, so a stale agent worktree turns the lint red locally; remove agent worktrees before the final lint run. (5) Review finding, fixed: the audit row now comes before the mail, so an audit failure cannot repeat a sent mail every day. (6) Known and accepted (low): if one admin send fails and another works, the failed admin is not retried; a scan error in the first query fails the job result after `expireCredits` has run; a grant change can allow a few extra mails.
- **How to verify.** (1) The page `/resources/verify-skill-certificate` answers 200 with one H1 and the sitemap lists the four pages. (2) Search `/privacy` for "public demo page at /try" and `/terms` for "The Customer owns its own data". (3) On the server, table `credit_lowbalance_notices` exists with forced RLS; worker log lines `credit_low_balance.*` appear after the next daily tick for a tenant at or below 20 percent. (4) `pnpm exec vitest run modules/19-billing/src/__tests__/credit-ledger.test.ts` (10 tests, includes the low-balance test). (5) Owner: open `/admin` signed in and one take page (router flags); the CI signed-in smoke passed.
- **Rollback.** Emails: revert the Z-96 code and redeploy. Table `credit_lowbalance_notices` can stay (additive). To stop only the mail, remove the `sendCreditLowBalanceNotices` call in `worker.ts`. Router: remove the `future` prop. Wording and pages: revert the files and rebuild `assessiq-marketing`.
- **Branch clean-up (RW-1), done after the owner yes.** Proof before deleting: each branch had 0 commits that `main` lacks (`git rev-list --count main..<branch>`), `merge-base --is-ancestor` said yes, no CI file, hook or script named them, no open PR used them. The owner said no one else uses the repo. Deleted locally with `git branch -d`: `autopilot/P01-T01`, `feat/domain-consistency-blueprint-scope`, `feat/question-difficulty`, `worktree-agent-a24d9a579ffd83f94`, `worktree-agent-ac882dada56ed9469`, `worktree-agent-af82986a755cc74be`. Deleted on the remote with `git push origin --delete` (all from 2026-05-24, merged): `origin/feat/platform-edit-admin`, `origin/feat/platform-edit-company`, `origin/feat/qdiff-admin-ui-followups`, `origin/feat/question-difficulty`. Left alone (not on the approved list, not checked): `autopilot/P01-T01.kept-af67488`, `n7b-react19`, `n7b-vite8`, two other `worktree-agent-*` branches, and the two Dependabot branches.

### 2026-10-20 — Session 4 (S38): exact meter, expiry warning, companions

Rows: Z-96, Z-93, Z-15 (a), SP11, Z-84. Code commit `5afedc62` (CI green, deployed, sweep 0 failures). Migration 0228 applied; next free: 0229. No new flag. The daily `credit-expire` job now also sends expiry warnings.

- **Exact meter (Z-96).** `modules/19-billing/src/repository.ts` (`USED_SQL`): `used` = sum of `credit_burns.credits` in the cycle for any tenant with a ledger row (10, 20 or 30 per attempt). The old counter (graded attempts x 10) is used only when the tenant has no ledger row. One function feeds the banner, `GET /api/billing/usage` and the super-admin screens. This closes the "Known approximation" in the Credit scale section above.
- **Expiry warning (Z-93, Z-96).** Files: migration `0228_credit_expiry_notices.sql`, `credit-repository.ts`, `service.ts` (`sendCreditExpiryNotices`), `apps/api/src/worker.ts`, notifications template `credit_expiring` (html, txt, schema, strings, delivery policy), audit action `billing.credit_expiry_notice`. The daily `credit-expire` tick mails the org admins once for each non-Free grant that has credits left and expires within 30 days. One system-role transaction per grant: notice row (UNIQUE grant_id), audit row, then the mail. If no mail goes out, the transaction rolls back and the next tick retries. No AI call.
- **Companions (outside billing).**
  - Result sign-in link (Z-15 a): `modules/13-notifications/src/email/result-login-token.ts`, `result-released.ts`, `modules/01-auth/src/candidate-login.ts`, `apps/web/src/pages/candidate/CandidateLoginVerify.tsx`, `CandidateLogin.tsx`. The result email button is a one-time link: 7 days, token in the URL fragment. The SPA POSTs it, then clears the address bar. An expired or used link shows a plain message and the email form.
  - Admin ETA notice (SP11): `modules/07-ai-grading/src/handlers/admin-queue.ts`, `modules/10-admin-dashboard/src/pages/grading-jobs.tsx`, help id `admin.grading.jobs.eta_notice`. `GET /admin/dashboard/queue` gains `evaluationTurnaroundText`. One muted line on the Evaluation status page. Help seed count 574 to 575.
  - Sample quiz (Z-84): `tools/sample-quiz-report.mjs` unpacks to a scratch folder, reports counts and quality, writes normalised JSON to the gitignored `docs/exam-content/Aptitude/Sample-Quiz/normalised/`. Report: `docs/exam-content/Aptitude/2026-10-20-sample-quiz-report.md` (gitignored). Counts only, no question text.
  - Load test: `tools/load-test/take-flow.mjs`, `docs/runbooks/load-test-500.md`, `docs/runbooks/pre-pilot-checklist.md`. Written, NOT run against any host.
- **Tests.** `credit-ledger.test.ts` (+2), `billing-events.test.ts` (2 expectations moved to the real burn), `email-result-copy.test.ts` (16 to 17 templates), `result-login-token.test.ts` (new, 6 cases), `email-result-signin-link.test.ts`, `admin-queue-eta.test.ts`.
- **Why.** The banner showed attempts x 10, but real tests burn 10, 20 or 30, so paid tenants saw 2 to 3 times too little. Admins need a warning before bought credits expire. The result email forced two emails and three steps (owner live test).
- **Gate (Z-15 a, Sonnet takeover, owner approved in chat), verdict REVISE, all fixed before push.** (1) HIGH: the token was stored in `email_log` and queue data; fixed with `redactLogBody: true`. (2) MEDIUM: each release left another live 7-day link; fixed: minting retires older tokens that live longer than 1 hour, a fresh 15-minute login link stays valid. (3) LOW: verify did not check the user; fixed: the token consume needs an existing, not erased, not deleted user (`candidate-login.ts`). (4) MEDIUM, accepted: the 7 days start at mint, and bulk-class mail can be late by days.
- **Rejected.** A flag column on `credit_grants` for the expiry notice (the app role can update that table). Marketing in the default deploy list (`tools/deploy.sh` is unchanged: `--services "assessiq-marketing"` already passes its name check, documented in `docs/06-deployment.md`). The mint function in 01-auth (01-auth already depends on 13-notifications, so it would be a cycle). Editing the approved SP11 wording (changed later by the owner, see below).
- **NOT included.** Revoke the link when a result is withdrawn (needs a per-attempt column; see follow-up). Tenant slug in the fragment: after an expired link the sign-in page may ask for the organisation code. Fixed-date test time bombs: the sweep found none open (the bulk-cap one was fixed in S37). Load test run, GATE-8, camera, CSP enforce, Caddy or DNS changes. IndexNow: the existing script ran once after the check (HTTP 200, 48 URLs).
- **Downstream.** 13-notifications: new template (sign-off count test is 17), new `mintResultLoginToken` export. 14-audit-log: new action. 16-help-system: one new row. Docs updated: 02, 03, 04, 06, 08, this SKILL, RCA_LOG, ROADMAP.
- **How to verify.** `cd modules/19-billing && npx vitest run` (DB tests need Docker). `cd modules/01-auth && npx vitest run src/__tests__/result-login-token.test.ts`. `cd modules/13-notifications && npx vitest run`. `pnpm verify`, then `bash tools/post-deploy-sweep.sh`. Live: `select to_regclass('credit_expiry_notices')` returns the table (checked after deploy).
- **Roll back.** Revert `5afedc62` and redeploy. Then `DROP TABLE credit_expiry_notices` (no other table changed). The help row stays as a seed row (harmless).
- **Bugs found.** The old meter test asserted the old counter (400 vs 200); updated. The template count test needs a bump for each new template.
- **Sample quiz result (counts only).**

| Source | Licence | Questions | Usable now |
| --- | --- | --- | --- |
| Aptitude-Tests-Questions-main | MIT | 1800 (no options) | 0 |
| aptitude-grind-master | CC BY 4.0 | 28 (no options) | 0 |
| aptitude-main | none found | 316 (29 with options) | 0 |
| aptitude-test-platform-public-main | none found | 600 (4 options each) | 0 |

  The 600 platform questions repeat stems of the MIT source and look machine-made. The owner must settle rights before any use.
- **Load test blockers (from the runbook).** Invitation tokens are stored as hashes, so 500 raw tokens need a test-only export. One source IP is capped near 50 requests a second. Invite emails count against the daily cap. `tools/deploy.sh` has no image-tag rollback step; the checklist adds it by hand.
- **Owner answers and follow-up (same day, S38 part 2).**
  - SP11 wording changed. Text is now: "Results appear after AssessIQ finishes the evaluation. If your organisation releases results by hand, you release them next." It is true for both release modes. Showing it by mode was rejected: the mode is a tenant setting (`tenant_settings.result_release_mode`) and the queue endpoint would need a second query and field for one sentence.
  - Help text: `admin.grading.jobs.eta_notice` and `admin.grading.jobs.oldest` are version 2 (new text). The seed adds the v2 rows at the next deploy; no migration is needed because `tools/migrate.ts` re-applies the seed after the migrations. `admin.grading.jobs.page` was checked and is not stale. Gates run: `pnpm lint:help-seed-version`, full `modules/16-help-system` tests (116), help-id page prefix test, admin-dashboard tests (262).
  - Withdrawn results: no action withdraws a released result today (`attempts.status = 'released'` is never reverted). The existing retire step was extracted into `retireResultLoginLinks` and tested (used, expired, retired, newer link). No column was added. Any future withdraw action must call it in the same transaction. Reviewed change in `modules/13-notifications` only (no 01-auth or 09-scoring code changed).
  - Sample quiz sources: owner decision is to load none of the four sources (no licence, no answer options, and the 600-question source copies an MIT source and looks machine-made). Use original items (EXP-15) and AI-written questions that the owner reviews.
  - Load test: owner decision is not to run it until after Wave 2 (camera). Blockers to solve first: (a) a test-only token export for a test tenant; (b) no real invite emails; (c) a source-IP plan that does not weaken the production rate limit; (d) an image-tag rollback step in the deploy. Plan: start with 100 users, run off-hours, stop at a set limit.

## EXP-37 (2026-10-23)
- `tenant_plans.max_invited_per_assessment` (default 150, NULL unlimited, internal unlimited). `getInviteLimit(client, tenantId)` returns it (null = unlimited; a missing plan row = `DEFAULT_INVITE_LIMIT` 150). The usage summary carries `invite_limit`; the super-admin plan edit takes `maxInvitedPerAssessment` (audited).

## S51 additions (2026-10-23)
- `getUploadLimits(client, tenantId)` returns `{perUpload, perMonth, total}` (override first, then the `plan_tier_limits` row; null unlimited, 0 not allowed; a missing plan row counts as free). `plan_tier_limits` is platform data, app-role read-only.
