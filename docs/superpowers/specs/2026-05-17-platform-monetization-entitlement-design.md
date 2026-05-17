# Design — Platform monetization, content entitlement & help-guide refresh

**Status:** APPROVED (brainstorming, 2026-05-17). One spec, three sub-projects (A/B/C), phased build A1→A2→B1→B2→C.
**Owner module:** new `modules/19-billing` (plan + metering + entitlement).

## Context

AssessIQ is a multi-tenant assessment SaaS. Super-admin (platform operator on the
`platform` tenant) provisions companies; each company has its own RLS-isolated
tenant. Today there is no commercial model: Billing page is a "not available yet"
placeholder; `tenant_grading_budgets` is an unrelated AI-grading cap primitive.
Generation ("Generate Questions") is currently available to every company admin.

## Locked decisions

- **Billable unit:** 1 credit = 1 candidate attempt reaching `graded`
  (assigned→submitted→graded all true). Deducted once on grade completion.
  Idempotent — re-grade/re-release never re-charges.
- **Plan tiers:** `free` / `pro` / `enterprise` / `internal`. One plan row per
  company. New company → `free` (default N included credits). Super-admin can
  change tier AND set a per-company custom `included_credits` override.
  `internal` = unlimited (no metering); `platform` & `wipro-soc` are `internal`.
- **Enforcement:** SOFT. Never blocks assign/submit/grade. Meter usage; warn the
  company admin near/over limit; surface overage to the super-admin for
  out-of-band follow-up/invoicing (CSV-exportable).
- **Accounting:** append-only `billing_events` ledger, idempotent by
  `UNIQUE(tenant_id, attempt_id)` + `ON CONFLICT DO NOTHING`. Usage = row count.
- **Monetization scope:** named plan tiers only. Deferred (not rejected): seats,
  credit expiry, gen-credit metering, recurring cycles, payment integration,
  self-serve upgrade, per-company generated pools.
- **B entitlement model:** Generate Questions → super-admin only. ONE shared
  central library; super-admin grants per-company domain/pack entitlements.
  Companies cannot self-generate; they assign only entitled content.
  Question-burn mitigated by the engine's existing per-candidate random draw +
  a pool-sizing discipline (entitled shared pack pool ≥ ~5× per-attempt draw).

## Data model — `modules/19-billing`

All three tables carry `tenant_id` + RLS: a company reads its OWN rows
read-only; super-admin via `SET LOCAL ROLE assessiq_system` reads/writes all
(same pattern as `/api/admin/super/*`).

1. **`tenant_plans`** — one row per company. `tenant_id` PK,
   `tier` ENUM(`free`,`pro`,`enterprise`,`internal`),
   `included_credits` INT NULL (NULL ⇒ unlimited, for `internal`),
   `cycle_start` TIMESTAMPTZ, `status`, `notes`, `created_at`, `updated_at`.
   Auto-created `free` (default N) when a company is provisioned (hook into the
   `createCompany` orchestration in `apps/api/src/routes/admin-super.ts` after
   `activateTenant`). Existing-tenant backfill migration: `platform` &
   `wipro-soc` → `internal`; other existing tenants → `free` default N.
2. **`billing_events`** — append-only ledger. `id`, `tenant_id`, `attempt_id`,
   `event_type='assessment_graded'`, `occurred_at`,
   **`UNIQUE(tenant_id, attempt_id)`**. No UPDATE/DELETE (module-14 audit
   invariant). Idempotent by the constraint.
3. **`tenant_entitlements`** (B) — `tenant_id`, `scope_type`(`domain`|`pack`),
   `scope_id`, `granted_by`, `granted_at`, `status`,
   `UNIQUE(tenant_id, scope_type, scope_id)`. Grant/revoke super-admin-only.

**Usage math (no mutable counter):** `used = COUNT(billing_events WHERE
tenant_id=?)`; `remaining = included_credits - used` (NULL ⇒ unlimited);
`overage = max(0, used - included_credits)`. Self-reconciling.

## A — metering flow, enforcement, UX

- **Hook:** in the SAME DB transaction as the `… → graded` grade-commit
  (`07-ai-grading` admin grade path / `05-lifecycle` state machine), call
  `billing.recordGradedAttempt(tenantId, attemptId)` →
  `INSERT INTO billing_events … ON CONFLICT (tenant_id, attempt_id) DO NOTHING`.
  Mirrors the project-wide `auditInTx` same-transaction rule. Grade rollback ⇒
  billing row rolls back (atomic, never orphaned). UNIQUE conflict is the
  intended no-op; ANY OTHER db error must fail loud (a graded attempt with no
  billing row is a revenue leak — same philosophy as the audit invariant).
- **Soft enforcement:** no gate anywhere. Company admin sees a usage banner
  (Dashboard + Assessments): green `<80%`, amber `80–100%`, red `over` with
  plain-language "contact your platform operator" copy. `internal`/unlimited
  never shows overage (events still recorded for analytics).
- **Super-admin:** Platform list gains a Usage column (`used / included` +
  overage badge); per-company billing drawer (tier, included, used, overage,
  `cycle_start`, recent events, CSV export); change tier + set custom
  `included_credits` (audited via `auditInTx`).
- **Endpoints:** `GET /api/billing/usage` (company admin, own tenant, RO);
  extend `GET /api/admin/super/tenants` with per-row usage;
  `GET /api/admin/super/tenants/:id/billing`;
  `PATCH /api/admin/super/tenants/:id/plan`. Existing auth chains
  (company = tenant admin; super = `superAdminOnly`).

## B — generation gating & content entitlement

- **Re-gate generation:** `Generate Questions` nav + routes
  (`/admin/generate-wizard`, `/admin/generation-attempts`) + generate API
  endpoints → `super_admin` only (same mechanism as the Platform page +
  `superAdminOnly` NavEntry flag). Removed from company-admin sidebar.
- **Shared library + grants:** super-admin generates into the existing
  blueprint/question-bank library. Super-admin entitlements UI (Platform-page
  tab or per-company drawer) → `POST/DELETE
  /api/admin/super/tenants/:id/entitlements` (audited).
- **Server-authoritative enforcement:** assessment-publish path (`05-lifecycle`)
  validates every referenced pack/domain `scope_id` ∈ active
  `tenant_entitlements` for the tenant → else `403 NOT_ENTITLED`. UI picker
  filters to entitled scopes (convenience only; server is authoritative).
  `company-side GET /api/billing/entitlements` (own tenant, RO) drives the picker.
- **Burn mitigation:** existing per-candidate random draw (no new draw code) +
  pool-sizing discipline + a warning when an entitled pack's pool is too thin
  for its per-attempt draw.
- **Existing-tenant backfill (high-risk):** before B2 ships, backfill
  `tenant_entitlements` for every existing tenant from the domains/packs it
  already has live questions in, + a verification query. `internal` tier
  bypasses the entitlement check entirely (safety net).

## C — help-guide refresh

Audit `modules/10-admin-dashboard/src/pages/admin-guide.tsx` + `16-help-system`
YAML drawer content; add, in plain-operator language (consistent with the
2026-05-17 `admin.platform` rewrite): company-admin "Your plan & usage" + "Where
your questions come from"; super-admin platform/plan/entitlement guidance. Pure
content, no logic. Ships last.

## Phasing (one spec, phased build; each phase = own commit→deploy→verify)

1. **A1** — ✅ **SHIPPED 2026-05-17 (commit `111dd77`).** `19-billing`
   module: `tenant_plans` + `billing_events` (2 of 3 tables — `tenant_entitlements`
   is B1 per spec) + RLS + migrations `0078/0079/0080` (applied to prod,
   recorded in `schema_migrations` w/ sha256) + `createCompany` provisioning
   hook (ordered after `tenant.created` audit) + existing-tenant plan backfill
   (e2e-walkthrough + foxfiber → free/25; platform + wipro-soc → internal/NULL)
   + `recordGradedAttempt` same-tx grade hook in `07-ai-grading/admin-accept.ts`
   + `GET /api/billing/usage`. **Default free N = 25** (operator-confirmed).
   Adversarial gate: Sonnet ACCEPT + Opus ACCEPT (10 vectors; GLM leg blocked
   by source-exfil guard → Opus-takeover per documented ladder). 25/25 tests.
2. **A2** — ✅ **SHIPPED 2026-05-17 (commit `66ea0ff`).** Super-admin: per-row
   usage column + overage chip on the Platform list (best-effort — never
   500s the list), billing drawer (tier/included/used/remaining/overage/
   cycle_start + last-50 events + CSV export), `PATCH
   /api/admin/super/tenants/:id/plan` (tenant_plans UPDATE via a two-role
   same-tx: `assessiq_system` for the lock+UPDATE since `tenant_plans` has
   no UPDATE RLS policy, then `assessiq_app`+`app.current_tenant` for
   `auditInTx` per audit.ts's contract & the `updateAiGenerateMode`
   precedent), `GET …/billing`, `GET …/billing/export.csv`.
   `tenant.plan_updated` added to module-14 ACTION_CATALOG. Company-admin:
   fail-silent `UsageBanner` (green/amber/red) on Dashboard + Assessments +
   "Your plan & usage" card on the Billing page (legacy grading-limit
   content untouched). Validation: tier∈{free,pro,enterprise,internal},
   credits null|int≥0, internal⇒null (omitted credits coerced), finite⇒
   credits. No migration (A1 tables). Adversarial: Sonnet review (revise,
   5 findings) + Opus adjudication — A (auditInTx-under-wrong-role) & B
   (internal coercion) fixed, C rejected (gate parity w/ ai-generate-mode),
   D deferred (repo-wide :tenantId UUID-guard sweep), E fixed. 31 billing
   tests + admin-dashboard unit; all typechecks clean.
3. **B1** — re-gate generation to super-admin; entitlement grant/revoke
   endpoints + super-admin entitlements UI; existing-tenant entitlement backfill.
4. **B2** — publish-time entitlement enforcement + filtered picker.
   **Authorization boundary → Sonnet+Opus adversarial gate before push.**
5. **C** — help-guide + drawer content refresh.

Order is strict: **B2 must not ship before B1's backfill** or existing
assessments 403 at publish.

## Testing (proportionate — minimal floor on load-bearing paths)

Idempotency (double-grade → one `billing_event`); same-tx rollback (grade fails
→ no billing row); usage math incl. NULL=unlimited + overage; entitlement
enforcement (not-entitled publish → 403, entitled → ok); backfill correctness
(existing tenants keep working). Adversarial gate (Sonnet+Opus) on **A1 and B2
only** — the two load-bearing seams.

## Explicitly NOT in scope (deferred)

Payment/invoicing integration (overage surfaced + CSV only); recurring/monthly
credit cycles (`cycle_start` reserves the option); seat limits; credit expiry;
gen-credit metering; per-company generated pools (chose shared library);
self-serve company plan upgrade.

## Risks

- **Existing-tenant entitlement backfill (B1)** — highest risk; an un-backfilled
  in-use pack 403s a live tenant's assessments at publish. Mitigation: derive
  grants from existing live question scopes + verification query before B2;
  `internal` tier bypasses the check.
- Soft enforcement = revenue depends on out-of-band invoicing discipline
  (accepted trade-off; the CSV-exportable ledger supports it).
