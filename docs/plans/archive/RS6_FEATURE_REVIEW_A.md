# RS6 feature review, part A: PT1, FR7, FR9, FR15, FR19

Date: 2026-10-03. Read-only review, no code change. Method: plan section 6 (`docs/plans/REVIEW_FIX_PLAN_2026-10-02.md`). Rule A: no delete is proposed. Rule B: each item is compared with the newer feature.

All line numbers refer to the work tree on 2026-10-03 (HEAD 3911f8b). Prices in PT1 are a proposal only. The owner decides.

---

## PT1. Plan tiers (define them)

### First purpose

- The monetization spec (`docs/superpowers/specs/2026-05-17-platform-monetization-entitlement-design.md`) locks these decisions: one credit is one attempt that reaches `graded`; tiers are `free` / `pro` / `enterprise` / `internal`; enforcement is soft; payment, seats, credit expiry and recurring cycles are "deferred, not rejected".
- The spec phases are A1 (`111dd77`), A2 (`66ea0ff`), B1 (`2ba822d`, `9f073a5`), B2 (`5c80aaa`). All four are live.
- The old plan `docs/plans/archive/assessiq-skill-plan.md:22,92` names module 21 "Stripe Connect + metering" for a marketplace. Task D3 (`docs/ROADMAP.md:66`) names Razorpay. The provider is not decided.
- The owner decided on 2026-10-02 that the product has plan tiers (`PROJECT_BRAIN.md:110`, plan RO1).

### What operates today

(a) What the code can already meter or enforce per tenant.

| Mechanism | Meters or enforces | Behaviour | Source |
|---|---|---|---|
| `tenant_plans` row | tier (`free`/`pro`/`enterprise`/`internal`), `included_credits`, `status`, `cycle_start` | Stored, shown. Default 25 credits (`DEFAULT_FREE_CREDITS`). | `modules/19-billing/src/service.ts:49`, migration `0078_tenant_plans.sql`, type `types.ts:6` |
| `billing_events` ledger | One credit per attempt that reaches `graded` | Written in the same transaction as the grade. Append-only. | `modules/09-scoring/src/finalize.ts:118`, `0079_billing_events.sql` |
| Usage status | ok (below 80%), warn (80% or more), over (100% or more), unlimited | Soft. Nothing blocks. Banner and plan card only. | `service.ts:98-125`, `modules/10-admin-dashboard/src/components/UsageBanner.tsx`, `pages/billing.tsx:250-335` |
| Entitlements | Which packs or domains a tenant may publish | Hard. `403 NOT_ENTITLED` at publish. `internal` tier bypasses. Fail-closed when no plan row. | `service.ts:546-590`; callers `modules/05-assessment-lifecycle/src/service.ts:1048,1344` |
| Licence check before clone | Source pack must be licensed before clone-on-use | Hard | `service.ts:608`, caller `modules/04-question-bank/src/clone.ts` |
| Super-admin plan edit | Change tier and `included_credits`; audited | Works | `apps/api/src/routes/admin-super.ts:913` |
| Super-admin entitlement grant and revoke | Per-tenant scope grants; audited | Works | `admin-super.ts:970,1024`; `service.ts:314,391` |
| Super-admin billing view and CSV | Usage per tenant; events export | Works | `admin-super.ts:858,878`; `service.ts:208,232,271`; `pages/platform/BillingDrawer.tsx` |
| Company routes | `/api/billing/usage`, `/entitlements`, `/available-sets` | Read-only | `modules/19-billing/src/routes.ts:45,58,73` |
| Question generation | Super admin only | Hard (role gate, not a tier) | spec section B1; `modules/04-question-bank/src/routes.ts` |
| AI evaluation | Super admin only, from the platform queue | Hard (role gate, not a tier) | `docs/05-ai-pipeline.md:1295` |
| `tenant_settings.features` JSONB | Feature flags | Column exists, default `{}`. I found no code that reads it for a gate. | `modules/02-tenancy/migrations/0001_tenants.sql:31` |
| `tenant_settings.ai_grading_enabled`, `ai_model_tier` | AI switch and model tier | Stored, never read (see FR7) | `0001_tenants.sql:29-30` |

Gaps found in the code:

- Usage is a lifetime count, not a monthly count. `countBillingEvents` is `COUNT(*) ... WHERE tenant_id = $1` with no date window (`modules/19-billing/src/repository.ts:70-77,148`). `cycle_start` is stored and never used in the count. A monthly plan cannot work until this changes.
- No code branches on the tier name except `internal` (bypass in `assertPublishEntitled`, banner in `assessments.tsx:929`). Webhooks, API keys, embed, audit viewer, certificates and bulk invite are open to every tenant.
- One credit is one graded attempt. A pure MCQ attempt costs one credit, the same as an attempt with five AI-evaluated answers. The pricing page says "evaluation load" drives price (`pricing.astro:307-310`). The meter cannot show that.
- Tier names differ: DB `free/pro/enterprise` against page `Starter/Growth/Enterprise`. No mapping exists.
- `modules/19-billing/SKILL.md` is stale. It says `tenant_entitlements` is "DEFERRED (Phase B)" and lists only one route. Migrations 0081 and 0082 and three routes exist.
- The terms page promises automatic renewal and fees due in advance (`apps/marketing/src/pages/terms.astro:183-186`). Nothing in the code collects money or renews.

(b) Every promise on the pricing page (`apps/marketing/src/pages/pricing.astro:80-143`).

| Tier | Promise | Can the product keep it today? |
|---|---|---|
| All | Price "Custom / Talk to us" (`:85,108,132`) | Yes. No numbers shown. `TODO(pricing)` at `:79,256`. |
| Starter | Skills tests (MCQ, scenario, short-answer) | Yes |
| Starter | Licensed question packs | Yes (entitlements) |
| Starter | Option shuffle and question randomisation | Yes (per-student shuffle, live 2026-10-01) |
| Starter | Admin dashboard and attempt logs | Yes |
| Starter | CSV student import and results export | Yes (`modules/03-users/src/import.ts`, `modules/15-analytics/src/results-export.ts`) |
| Starter | Email support | Operational, not code |
| Growth | AI-assisted evaluation run by AssessIQ evaluators | Yes (platform queue, SP9). Capacity is one person. |
| Growth | Bulk invite with resend | Yes |
| Growth | Cohort and skill-gap analytics | Partly. Cohort page exists but shows wrong data (plan RV14). |
| Growth | Signed webhooks | Not in a usable way. Code exists, but there is no screen, 0 endpoints in production, and fan-out only from `audit()` (plan FR2). A customer cannot set it up. |
| Growth | Certificates with public verification | Yes (module 18) |
| Growth | Priority email support | Operational |
| Enterprise | Dedicated account manager, custom contract | Operational |
| Enterprise | Roadmap: proctoring, SSO, integrations "(Coming soon)" | Labelled as not built. Honest. |
| Terms section 7 | Auto-renew, fees in advance, GST | No billing code exists. Contract and invoice work is manual. |

(c) Proposed tier definition (PROPOSAL, for the owner to change).

Keep the three marketing names. Map them to the existing `tier` column so no schema change is needed: Starter = `free`, Growth = `pro`, Enterprise = `enterprise`. Show the display name in the UI. Keep `internal` for owner tenants. Rename the DB value only if the owner wants it.

| Row | Starter | Growth | Enterprise | Existing mechanism | Missing |
|---|---|---|---|---|---|
| Included credits | 100 per month (pilot: 25 total) | 1,000 per month | Custom | `included_credits` | Monthly window (`cycle_start`) |
| Overage | Not allowed after 120% (soft warning before) | Billed per credit | Contract | status `over` | Hard cap option; invoice export exists (CSV) |
| Question types (MCQ, numeric, sections) | Yes | Yes | Yes | Always on | None |
| Licensed packs | 2 packs | All platform packs | All plus private pack | `tenant_entitlements` | Pack count limit |
| AI-assisted evaluation | 20 AI-evaluated answers per month | 500 per month | Custom | FR7 budget idea; platform queue | Separate meter for AI answers (or a second event type in `billing_events`) |
| Bulk invite, reminders | 200 candidates per drive | Unlimited | Unlimited | Live | Per-drive cap |
| Results CSV | Yes | Yes | Yes | Live | None |
| Cohort analytics | Basic | Full | Full | Cohort page | Fix RV14 |
| Certificates | No | Yes | Yes | Module 18 | Tier gate (read `tier`) |
| Webhooks | No | Yes | Yes | Module 13 | Screen (FR2), tier gate, real events |
| API keys | No | No | Yes | Module 01 routes | Screen (FR3), tier gate |
| Embed (iframe) | No | No | Yes | Module 12 | Fix RV43, tier gate (FR4) |
| Audit viewer and export | No | No | Yes | Write side live | Register routes (FR1) |
| Own email sender, white-label | No | No | Yes | FR15 pieces | See FR15 |
| Support | Email | Priority email | Account manager | Ops | None |

Missing building blocks, in order: (1) monthly credit window; (2) one `tierAllows(tenantId, feature)` helper in `19-billing` that reads `tenant_plans.tier`; (3) a second meter for AI-evaluated answers; (4) tier-gate calls at the route of each gated feature; (5) display-name map; (6) payment flow.

(d) Open owner decisions with a recommended option. All prices are a proposal and not validated against the market.

| # | Decision | Options | Recommendation and reason |
|---|---|---|---|
| 1 | Tier contents | The table in (c); or fewer tiers | Use the table in (c). It keeps each dormant feature in one tier (Rule A) and uses existing mechanisms. |
| 2 | Credit meaning | One per graded attempt (today); one per attempt plus a separate AI meter | Keep one per attempt. Add the AI meter as a second event type. The cost to you is the AI evaluation, so the meter must see it. |
| 3 | Monthly or total credits | Lifetime (today); monthly; per drive | Monthly for Growth and Enterprise. Per-drive pack for campus drives (they buy in bursts). |
| 4 | Prices in INR | Range for review | Starter: Rs 0 for the pilot, then about Rs 2,000 to 5,000 per month. Growth: about Rs 10,000 to 25,000 per month, or Rs 10 to 30 per extra credit. Campus drive pack: about Rs 25 to 60 per candidate. Enterprise: annual contract with a minimum. Reason: Indian placement tools charge per candidate and campus buyers have small budgets. Check against competitor price lists before you publish. |
| 5 | Payment provider | Razorpay; Stripe | Razorpay. It supports INR, UPI, GST invoices and e-mandate for recurring fees. Stripe availability for Indian businesses is limited; the owner must check the current status. Start with manual invoices and Razorpay payment links. Add subscriptions later. |
| 6 | Terms section 7 text | Keep auto-renew; change to "by order" | Change to "by order or contract" until a payment flow exists. It is untrue customer text today. |
| 7 | Free or trial tier | `free` as 25-credit trial; none | Keep a 25-credit trial. It exists (`DEFAULT_FREE_CREDITS`) and lets a buyer try the product. |

### Overlap with newer feature

- Overlaps FR7 (AI budget), FR2 (webhooks), FR3 (API keys), FR4 (embed), FR1 (audit viewer), FR15 (tenant SMTP), FR9 (paid AI mode), as listed in the plan.
- Older and newer meters: `tenant_grading_budgets` (Phase 2, USD) and `billing_events` (May 2026, credits). The newer one is live and the older one has no writer. See FR7.
- Marketing names (Starter/Growth/Enterprise) against DB names (free/pro/enterprise): same idea, two vocabularies.

### Result

**Improve** (define and finish). The metering base is sound and live. The missing parts are the tier definition, a monthly window, tier gates and a payment flow.

### Follow-up tasks

| Id | Task | Size | Modules | Load-bearing? | Waits for |
|---|---|---|---|---|---|
| FU-A1 | Write the tier table into `docs/plans/` and `modules/19-billing/SKILL.md` (also fix the stale SKILL text) | S | docs only | No | Decision 1 |
| FU-A2 | Monthly credit window: count `billing_events` since the current cycle start; roll `cycle_start` | M | 19-billing | No (billing is in the grade path, so careful review) | Decision 3 |
| FU-A3 | `tierAllows(tenantId, feature)` helper and a display-name map | S | 19-billing, 10-admin-dashboard | No | Decision 1 |
| FU-A4 | Second meter for AI-evaluated answers | M | 19-billing, 07-ai-grading (call site) | Yes (07) | Decision 2 |
| FU-A5 | Tier gates at routes for webhooks, API keys, embed, certificates, audit viewer | M | 13, 01, 12, 18, 14 | Yes (01, 14) | FR1-FR4 reviews |
| FU-A6 | Fix terms section 7 text and pricing page to match the real state | S | apps/marketing | No | Decision 6 |
| FU-A7 | Payment flow with Razorpay payment links and GST invoice export | L | 19-billing, apps/api | Possibly (new secrets) | Decisions 4, 5 (KYC) |
| FU-A8 | Fill real prices on the pricing page (clear the `TODO(pricing)`) | S | apps/marketing | No | Decision 4 |

### Owner decision needed

Yes: tier contents, credit meaning, prices, provider, terms text. See (d).

**Decided 2026-10-03 (all recommended options):** Tiers as in (c): Starter (DB free), Growth (pro), Enterprise, plus internal. One credit per graded attempt stays, with a second meter for AI evaluation. Monthly credits for Growth and Enterprise; a per-drive pack for campus drives. INR ranges are a PROPOSAL ONLY and are NOT published; the pricing page keeps "contact sales" until the owner checks the market. Razorpay: manual invoices and payment links first, subscriptions later. Terms section 7 now reads "renew only by a new order or as your contract states" (DONE and LIVE 2026-10-03, `e11cb5b`). Keep the 25-credit trial.

---

## FR7. Tenant AI grading budget and AI settings

### First purpose

- Phase 2 decision D6 (`docs/plans/archive/PHASE_2_KICKOFF.md:76,116,131`): a USD budget per tenant, read before each API call. Designed for the `anthropic-api` runtime. Not used in Phase 1.
- Migration `modules/07-ai-grading/migrations/0041_tenant_grading_budgets.sql:1-20` states the reason: "so module 10 billing UI has a stable target" and the future runtime can read a populated row. First commit `7eea75b` (2026-05-03).
- `tenant_settings.ai_grading_enabled` and `ai_model_tier` come from Phase 0 (`modules/02-tenancy/migrations/0001_tenants.sql:29-30`). The AI pipeline doc says `premium` always escalates and routes to the API (`docs/05-ai-pipeline.md:350,560`).

### What operates today

- Table `tenant_grading_budgets`: 0 rows in production, no writer anywhere (plan section 8). Only reader: `findTenantBudget` (`modules/07-ai-grading/src/repository.ts:337`).
- Handler `handleAdminBudget` (`handlers/admin-budget.ts:41`) returns the default shape 0/0/null/80 when no row exists. Route `GET /api/admin/settings/billing` (`routes.ts:546`, admin only).
- Second search for a caller: no front-end code calls `/api/admin/settings/billing`. `apps/web/src/App.tsx:97-98` redirects that URL to `/admin/settings`. Only the handler test calls the handler (`__tests__/handlers.test.ts:1125`).
- The Settings card for the budget is gone. `billing.tsx:350-362` keeps the help container `admin.settings.billing.budget`, but it now shows "Questions about your plan" text. The register row says "Settings card"; that card no longer shows a budget.
- `ai_grading_enabled` and `ai_model_tier`: written by `updateTenantSettings` (`modules/02-tenancy/src/repository.ts:129-136`). I found no reader in the grading code (second search by type name `TenantSettings` also shows none). They have no effect.
- Live replacement: `19-billing` credits (`service.ts:98-132`), soft limit, with banner and plan card.

### Overlap with newer feature

- `19-billing` credits and entitlements (live): same purpose "limit usage per tenant", different unit (credits against USD).
- Plan tiers (PT1). AI is now run by the super admin, so tenants do not spend AI money today.
- FR9: the USD budget only has a use when the API runtime exists and tenants pay for it.

### Result

**Merge into plan tiers (PT1).** Keep the table and route. Define "included AI-evaluated answers" as a plan limit in `19-billing`, as the plan suggests. Use `ai_model_tier` as the model choice when the API runtime exists (FR9). Keep the USD budget table for the day when API mode records real cost. Park `ai_grading_enabled` as a per-tenant AI switch that the super admin can use to pause a tenant.

### Follow-up tasks

| Id | Task | Size | Modules | Load-bearing? | Waits for |
|---|---|---|---|---|---|
| FU-A9 | Add "AI-evaluated answers included" to the tier table. Show used and included in the plan card. Same work as FU-A4. | M | 19-billing, 10-admin-dashboard | Yes (07 call site) | PT1 decision 2 |
| FU-A10 | Mark `tenant_grading_budgets`, the handler and the route "parked, API mode only" in `docs/05-ai-pipeline.md` and the module SKILL. Add a comment at `routes.ts:538`. | S | docs, 07 (comment only) | Yes (07, comment only) | None |
| FU-A11 | Decide whether `ai_grading_enabled` pauses AI for a tenant in the platform queue (super-admin view). Wire it only after the decision. | S | 07, 02 | Yes | Owner |

### Owner decision needed

Yes, but it is the same decision as PT1 decision 2 (credit meaning) and FU-A11 (use of the pause switch).

**Decided 2026-10-03:** The `ai_grading_enabled` pause switch is part of the AI meter (with PT1-2).

---

## FR9. Paid AI mode (`anthropic-api` runtime stub)

### First purpose

- Phase 2 design: a runtime that calls the Anthropic API with a budgeted key, for tenants that pay. `modules/07-ai-grading/src/runtimes/anthropic-api.ts:1-20` says the real code lands when `AI_PIPELINE_MODE=anthropic-api` is flipped, gated by the D6 budget, `codex:rescue` and eval re-baselining. First commit `7eea75b` (2026-05-03).
- Decision log `PROJECT_BRAIN.md:85` (2026-04-29): "Phase 2 swap to paid Anthropic API stays designed but deferred." Rule 5 at `PROJECT_BRAIN.md:22`: Phase 2 (paid budget) uses API-key auth.
- Owner decision OD2: switch to an API key when paid plans start or volume grows (`docs/05-ai-pipeline.md:1296`).

### What operates today

- Config accepts the value: `modules/00-core/src/config.ts:106-108`. `ANTHROPIC_API_KEY` is required in API mode and forbidden in VPS mode (`config.ts:251-268`).
- Runtime selector routes to the stubs (`modules/07-ai-grading/src/runtime-selector.ts:39-58`). `anthropic-api.ts` throws `RUNTIME_NOT_IMPLEMENTED` (503). `open-weights.ts` is also a stub (same first commit).
- Grade, rerun and generate handlers refuse any mode except `claude-code-vps` (`handlers/admin-grade.ts:348`, `admin-rerun.ts:156`, `admin-generate.ts:404`). So setting the switch today would stop all AI work.
- Production value: `AI_PIPELINE_MODE=claude-code-vps` (plan section 8).
- Cost report: route `GET /api/admin/reports/cost-by-month` exists (`modules/15-analytics/src/routes.ts:187`). The service returns `[]` in VPS mode (`service.ts:135-142`). The query reads `grading_jobs` (`repository.ts:565-600`). No migration creates `grading_jobs` (`grep` in `modules/*/migrations` finds none). Second search for a caller (`cost-by-month`, `gradingCostByMonth`): only the route and a comment in `apps/api/src/server.ts:231`. No front-end caller.
- Help key `admin.reports.cost.empty_in_claude_code_vps_mode` (`modules/16-help-system/content/en/admin.yml:589`) says per-call cost is not shown. This text is correct today.
- Tier 2 grading (SP5 least-AI) and the two-model vote (E2) already reduce AI calls in VPS mode.

### Overlap with newer feature

- PT1 plan tiers: the first real reason to run API mode is paying tenants.
- FR7 budget: the budget gate is part of API mode.
- SP8 background grading and the `AI_PIPELINE_MODE` switch for who may trigger AI (`docs/05-ai-pipeline.md:1343`, `docs/ROADMAP.md:178`, task I5). The switch has no task that builds API mode.
- Rule 1 and 2 of the project `CLAUDE.md` still hold: the Agent SDK may appear only in `anthropic-api.ts`.

### Result

**Park.** Keep all stubs, the config checks and the cost route. Mark each doc "not built". Revisit with PT1. Entry condition: the first paying tenant that needs AI evaluation faster than one person can do it, or an owner decision on BYOK (a tenant key, listed at `docs/05-ai-pipeline.md:1325`).

### Follow-up tasks

| Id | Task | Size | Modules | Load-bearing? | Waits for |
|---|---|---|---|---|---|
| FU-A12 | Add "not built" banners in `docs/05-ai-pipeline.md` section D1/D6 and in the comments of `anthropic-api.ts`, `open-weights.ts`, `15-analytics` cost query. Comment-only change. | S | docs, 07 and 15 (comments) | Yes (07, comments only) | None |
| FU-A13 | Write a one-page design for API mode: key handling, budget gate (FR7), cost table (`grading_jobs` or `gradings` columns), eval re-baseline, `codex:rescue` gate. Design only. | M | docs | No (design) | PT1 tiers, OD2 |
| FU-A14 | Build `anthropic-api` runtime and the cost report (the real work) | L | 07, 15, 00-core | Yes (07, 00) | FU-A13, OD2, owner key |

### Owner decision needed

Yes. OD2 (when to move to an API key) and whether BYOK is a tier feature.

**Decided 2026-10-03:** Park the API key. BYOK is an Enterprise feature.

---

## FR15. Per-tenant email sender (tenant SMTP and white-label)

### First purpose

- Phase 1 decision #12 (`modules/05-assessment-lifecycle/SKILL.md`): each tenant sends from its own mail server. Migration `modules/02-tenancy/migrations/0004_tenants_smtp_config.sql:1-30` adds `tenants.smtp_config` JSONB. It says "a future module-13 SMTP driver can read them". First commit `4fecadb` (2026-05-02).
- Phase 3 added `resolveTransport(tenantSmtpConfig)` and `resolveFromAddress(...)` (`modules/13-notifications/src/email/transport.ts:56,76`). Its comment says per-tenant native drivers are Phase 4.
- White-label: old plan module 31 (`docs/plans/archive/assessiq-skill-plan.md:47`), item I4 (`docs/ROADMAP.md:177`): "when the first enterprise reseller deal closes".

### What operates today

- Column `tenants.smtp_config`: no writer, no value (plan register; `smtp_config` grep in `modules/02-tenancy/src` and `modules/13-notifications/src` finds only comments and docs).
- The two send paths call `resolveTransport()` with no argument (`modules/13-notifications/src/email/index.ts:109,193`). Line 109 says "Phase 3: platform-level only". `contact.ts:90` does the same. So the per-tenant branch never runs.
- Two shapes disagree. The migration describes `{host, port, secure, user, password_enc, from_address, from_name}` (`0004...sql:12-20`; `docs/02-data-model.md:51`). The code schema is `{provider, smtp_url, from_address, from_name, reply_to, template_overrides}` (`modules/13-notifications/src/types.ts:195-203`). The code shape stores a full URL with a password in plain text. The migration shape was to encrypt the password. This is a security point for the future design.
- Production sender: platform address `connect@assessiq.in` through Brevo, 300 per day on the free plan (plan section 8; `docs/ROADMAP.md:29`). Code side of capacity is done: retry for about 45 hours, sign-in codes first.
- Branding: `tenants.branding` JSONB (`0001_tenants.sql:17`) and type `TenantBranding` (`modules/02-tenancy/src/types.ts:3`). Plan RV15 mentions per-tenant theme fixtures. No sender or theme reads a tenant value for candidates today (not traced beyond the type and column).

### Overlap with newer feature

- Brevo shared daily limit and the email queue split (A5, R7, SP4). These are platform answers to capacity.
- A tenant sender would move the volume to the tenant's own limit. This helps large drives and keeps the platform reputation safe (a tenant that sends spam would hurt only its own domain).
- White-label (old module 31, item I4): not in the newer roadmap.
- Candidate trust: an email from the tenant's own domain is easier for a student to recognise.

### Result

**Park now, then revive as an Enterprise tier feature together with white-label** (the review lead's idea holds). Reason: no customer asks for it yet, and the credential design needs care. Do not store a plain SMTP URL with a password.

### Follow-up tasks

| Id | Task | Size | Modules | Load-bearing? | Waits for |
|---|---|---|---|---|---|
| FU-A15 | Write a design: one shape for `smtp_config`, password encrypted with the master key (reuse the AES helper after RV77 merge), SPF/DKIM check step, test-send button, fallback to the platform sender on error | M | docs | No (design) | None |
| FU-A16 | Record the shape conflict in `docs/02-data-model.md` and `docs/13-email-system.md` (facts only) | S | docs | No | None |
| FU-A17 | Build tenant sender: super-admin screen to set it, pass tenant config into the send path, per-tenant daily counter | L | 13, 02, 10, apps/api | Yes (02, secrets) | PT1 tier decision, FU-A15 |
| FU-A18 | Add a roadmap row for white-label (it vanished from the newer lists) | S | docs | No | Owner (I4) |

### Owner decision needed

Yes. Is a tenant sender and white-label an Enterprise feature, and when does the first request make it urgent (I4)?

**Decided 2026-10-03:** Tenant sender and white-label are an Enterprise feature. Parked until the first request.

---

## FR19. Question import by CSV

### First purpose

- Phase 1 question bank. `modules/04-question-bank/SKILL.md:13,40,72-74,157,169-170`: bulk import and export of questions. Decisions #4 and #13: "Phase 1 ships JSON-only. CSV deferred to Phase 2 once admin team has used JSON in practice", and a browser upload widget in Phase 2. First commit of the service `f0b5ad9` (2026-05-01).
- Help key `admin.questions.import.format` (`modules/16-help-system/content/en/admin.yml:152-176`) says "CSV import is planned. Convert spreadsheets to JSON first."

### What operates today

- `bulkImport(tenantId, buffer, format, userId)` accepts `"json" | "csv"` in its type but throws for CSV (`modules/04-question-bank/src/service.ts:1244-1255`, message "csv deferred to phase 2 - use json").
- Route `POST /api/admin/questions/import` (`modules/04-question-bank/src/routes.ts:648`), super-admin only since the B1 lockdown (`routes.ts:650`). It always passes `"json"` (`routes.ts:660`).
- Second search by route string `questions/import` and by name `bulkImport` / `importPack`: the callers are the route, the CLI `tools/aiq-import-pack.ts:39` and tests. No admin screen and no front-end function calls it. So authors have no UI for import at all, JSON or CSV.
- The CLI uses JSON files. The aptitude pack came from `docs/exam-content/aptitude-questions-v2.json` and migration `0109_seed_platform_aptitude_pack.sql`. So the real workflow today is JSON by CLI or SQL.
- A CSV parser already exists for candidates: `parseCandidateCsv` in `modules/03-users/src/import.ts:99` (limits 1000 rows, 512 KB; quoted-field handling; invisible-character cleanup at line 26) with the screen `modules/10-admin-dashboard/src/components/CandidateCsvImport.tsx`. This works in production.
- Who authors: only the super admin authors platform packs (owner rule, content model). Tenants license and clone. So the user of a question import is the owner, not a customer.

### Overlap with newer feature

- JSON import and `tools/aiq-import-pack.ts` (the live path).
- AI generation (`07-ai-grading` generate, super admin only): a second way to get questions in bulk.
- Candidate CSV import (works): a ready CSV parser and a screen pattern to reuse.
- The help text promises "CSV import is planned". That promise is acceptable text, but the owner might want to see it changed or kept.

### Result

**Park.** The author is one person (the owner), and JSON by CLI works. Revive only if the owner wants to write questions in a spreadsheet, or if a customer tier can bring its own questions (a possible Enterprise feature "private pack"). If revived, reuse the candidate CSV parser. Question content has nested fields (MCQ options, rubric), so CSV needs a column design per type. That is the real work.

### Follow-up tasks

| Id | Task | Size | Modules | Load-bearing? | Waits for |
|---|---|---|---|---|---|
| FU-A19 | Mark CSV import "parked" in `modules/04-question-bank/SKILL.md` and keep the help text accurate | S | docs, 16 (text only if wanted) | No | None |
| FU-A20 | Design a CSV column layout per question type (MCQ first), with the candidate CSV parser and the formula-injection guard from RV77 | M | docs | No (design) | Owner wants spreadsheet authoring |
| FU-A21 | Build the CSV branch of `bulkImport` and a super-admin import screen (JSON and CSV) | M | 04, 10, 16 (help id) | No | FU-A20 |

### Owner decision needed

Yes, a small one: will you or a tenant author questions in a spreadsheet? If no, FR19 stays parked.

**Decided 2026-10-03:** No. CSV question authoring stays parked.

---

## Summary table

| Item | Result | Follow-up task ids | Owner decision |
|---|---|---|---|
| PT1 Plan tiers | Improve (define and finish) | FU-A1 to FU-A8 | Tier contents, credit meaning, INR prices, Razorpay or Stripe, terms text |
| FR7 Tenant AI budget | Merge into plan tiers | FU-A9 to FU-A11 | Same as PT1 decision 2; use of the AI pause switch |
| FR9 Paid AI mode | Park | FU-A12 to FU-A14 | OD2 (when to use an API key); BYOK as a tier feature |
| FR15 Tenant SMTP and white-label | Park, revive as Enterprise feature | FU-A15 to FU-A18 | Enterprise feature or not; I4 trigger |
| FR19 CSV question import | Park | FU-A19 to FU-A21 | Spreadsheet authoring wanted or not |
