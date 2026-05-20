# AssessIQ — Project Brain

> **Read this first in every Claude Code session.** This is the single source of truth for orientation. Module-level details live in `modules/<n>-<name>/SKILL.md`. Cross-cutting concerns live in `docs/`.

---

## What AssessIQ is

A scenario-driven, tier-based, hybrid-graded **role-readiness assessment platform** for technical teams. SOC pack ships first; every other domain (DevOps, Cloud Architects, Identity, IR, etc.) plugs in as additional question packs against the same engine.

**Three product surfaces:**
1. **Standalone web app** — `https://assessiq.automateedge.cloud`
2. **Embeddable widget** — iframe with signed JWT, drops into any host application
3. **REST API + webhooks** — for back-end integrations (Workday, ServiceNow, custom HRMS)

## Non-negotiable design principles

1. **Multi-tenant from day one.** Every table has `tenant_id`. SOC team is `tenant: wipro-soc`.
2. **Domain-agnostic core.** No `if domain === "soc"` anywhere. Domain lives in question packs (data), not code.
3. **Graduated scoring, never binary.** Subjective answers land in 0/25/50/75/100 bands, never raw "73%".
4. **Auditable AI.** Every AI grade stores anchors, band, justification, error class, model, prompt version. Admin override never replaces the AI verdict — it sits beside it.
5. **AI grading runs as the admin, not as a product.** Phase 1 uses Claude Code CLI on the VPS under the admin's Max subscription, synchronous and triggered only by an admin click — never a cron, webhook, or candidate event. Phase 2 (paid budget) switches to API-key auth via the Agent SDK. **Never** wire ambient/background AI calls under Max-OAuth — that crosses the ToS line. See `docs/05-ai-pipeline.md`.
6. **Help is a first-class module.** Every UI element with a `help_id` has tooltip + drawer content. Authoring is centralized.

## Tech stack (committed)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS + Fastify | Matches IntelWatch ETIP; one mental model |
| DB | PostgreSQL 16 + RLS | Tenant isolation enforced at row level |
| Cache / queue | Redis 7 + BullMQ | Sessions, rate limits, async grading jobs |
| AI runtime | **Phase 1:** Claude Code CLI on VPS (Max subscription, admin-in-the-loop, sync-on-click). **Phase 2 (designed, switchable via `AI_PIPELINE_MODE`):** Claude Agent SDK (TypeScript) via `ANTHROPIC_API_KEY` | Phase 1: $0 API cost, admin-in-the-loop ToS compliance. Phase 2: unlocks async + non-admin triggers. See `docs/05-ai-pipeline.md`. |
| AI models | Sonnet 4.6 (primary), Haiku 4.5 (anchors), Opus 4.7 (escalation) | Multi-tier pipeline by stakes |
| Frontend | React 18 + Vite + TypeScript | Fast iteration, embeds cleanly in iframe |
| Styling | Tailwind + design-token CSS vars | Theming per tenant; UI template plugs in here |
| Auth (admin) | Google SSO (OIDC) + TOTP MFA mandatory; `super_admin` role for cross-tenant ops (`d59ade4`) | Phase 1 |
| Auth (extensible) | OIDC, SAML, magic-link, email+password | Phase 2, admin-toggleable per tenant |
| Hosting | Hostinger VPS, Docker Compose, nginx + Let's Encrypt | Reuses your IntelWatch infra playbook |
| Domain | `assessiq.automateedge.cloud` | Existing site, subdomain |

## Module map

```
00-core                Config, env, logging, base types, error handling
01-auth                Google SSO + TOTP, magic link, embed JWT, API keys, sessions
02-tenancy             Tenant CRUD, isolation, RLS policies, settings
03-users               User model, roles (admin/reviewer/candidate), invites
04-question-bank       Packs, levels, questions, versioning, tags
05-assessment-lifecycle Cycles, invitations, schedules, state machine
06-attempt-engine      Taking the assessment, timer, autosave, integrity hooks
07-ai-grading          Claude Agent SDK pipeline, prompts, queue
08-rubric-engine       Anchor extraction, band classification, scoring rubric DSL
09-scoring             Aggregation, archetype, leaderboard
10-admin-dashboard     Admin web UI (tenant scope)
11-candidate-ui        Candidate-facing assessment UI
12-embed-sdk           Iframe embed + JS snippet + postMessage protocol
13-notifications       Email, webhooks, in-app
14-audit-log           Append-only audit trail (HR-grade)
15-analytics           Reports, exports, dashboards
16-help-system         Tooltip framework, help content store, contextual drawer
17-ui-system           Design tokens, component library, theming primitives
18-certification       Course-completion certificates: HMAC-signed credential rows, public verify URL, admin issue/revoke
```

## Build phases

| Phase | Modules | Outcome |
|---|---|---|
| **Phase 0** — Foundation (Week 1–2) | 00, 01, 02, 03, 17 | Auth + tenancy + UI kit working |
| **Phase 1** — Author & take (Week 3–5) | 04, 05, 06, 11, 16 | SOC pack authored, candidates can take assessments end-to-end with help system. **Closure audit CLOSED (2026-05-03, `2c9af6b`):** All 5 drills PASSED. D1 step 9 confirmed live after `d681ec5` fix; D4 autosave+timer accepted PASSED (Option A pragmatic — mechanics verified live during G1.D ship). Finding C (`tenantName:""` → Zod `.min(1)` crash) fixed 2026-05-11 in `05-lifecycle:691-708`: real `tenant.name` fetched in `withTenant` tx; throws `TENANT_NAME_MISSING` on null/empty. RCA logged. |
| **Phase 2** — Grade & report (Week 6–8) | 07, 08, 09, 10 | ✅ shipped; type-sharded generation (Stage 1, 5 type skills) live (`f449203`); Stage 3.0 per-tenant `ai_generate_mode` plumbing shipped (`80e713a`); Stage 3.1 default flip to `sharded` pending G1/G2/G4 criteria — see `docs/design/2026-05-10-stage-3-promotion-rollout.md`. `super_admin` role + Stage 3 watch cron live (`d59ade4`, `05ea435`). |
| **Phase 3** — Operate (Week 9–10) | 13, 14, 15 | ✅ G3.A audit-log (`43c0e45`) + G3.B notifications (`cae6d37`) + email i18n (`7a20ee2`) + G3.C analytics (`ce041e3`) shipped; G3.D atomic `auditInTx` sweep ✅ COMPLETE (2026-05-14): 03-users `057de7d`, 05-lifecycle `08d4b19`, 04-question-bank `eff0ba2`, 07-ai-grading, 09-scoring, 16-help-system, 18-certification, 01-auth+02-tenancy+12-embed-sdk+13-notifications `dad0d9a`. 06-attempt-engine correctly excluded (all candidate-facing); 13-notifications/in-app correctly excluded (system/user paths); 10-admin-dashboard has no backend service layer. |
| **Phase 4** — Embed (Week 11–12) | 12 | ✅ shipped (`b20858b`, 2026-05-03); iframe + JWT embed + session minting + admin surface live; consumer integration guide at `docs/09-integration-guide.md`. |
| **Phase 5** — Credentialize (post-MVP, 6–10 sessions) | 18-certification | ✅ shipped (Sessions 1–10, 2026-05-11 → 2026-05-14): HMAC signing, public verify, PDF, OG meta, LinkedIn PNG, auto-issue trigger, admin UI, LinkedIn share button. Out of scope for Phase 1 of cert: LinkedIn "Add to Profile" API, employer/recruiter portal, fraud detection beyond HMAC + revocation. Plan: `docs/CERTIFICATION_PLAN_GENERIC.md`. |

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Multi-tenant from day one | Embeddability and future client deployments require it; retrofit cost is high |
| 2026-04-29 | Google SSO + TOTP for v1 | User constraint; admin-toggleable extensions in v2 |
| 2026-04-29 | **Phase 1 grading uses Claude Code CLI on VPS under admin's Max subscription** (sync-on-click, single-admin-in-the-loop, no Agent SDK, no `ANTHROPIC_API_KEY`). Phase 2 swap to paid Anthropic API stays designed but deferred. | $0 budget for AI APIs. Anthropic ToS forbids Max-auth in *products* but allows the subscriber to script their *own* use; admin-in-the-loop preserves that line. Supersedes the earlier "Agent SDK + API key" plan from the same date. See `docs/05-ai-pipeline.md`. |
| 2026-04-29 | Hostinger VPS + Docker Compose | Reuses IntelWatch ETIP playbook; AWS migration deferred until traffic warrants it |
| 2026-04-29 | Subdomain on automateedge.cloud | Existing infra; white-label capability via tenant-level domain mapping in v2 |
| 2026-04-29 | Help system as separate module | First-class concern, not bolt-on; centralized authoring + i18n-ready |
| 2026-04-30 | UI template at `modules/17-ui-system/AssessIQ_UI_Template/` adopted as the brand base; canonical guideline distilled to `docs/10-branding-guideline.md` | Reuse over redesign; the editorial typography (Newsreader serif + Geist sans + JetBrains Mono), OKLCH palette around hue 258, density-via-`--u` mechanic, and pill-button + editorial-card idioms are intentional and reusable. Future pages inherit from this guideline. Folder renamed from `AccessIQ_UI_Template` to `AssessIQ_UI_Template` 2026-05-13 when the v1.1 kit dropped. Rename commit: `9c03797`. |
| 2026-05-01 | **Phase 1 `attempt.status` enum confirmed:** `draft → in_progress → submitted → pending_admin_grading → graded → released`; `auto_submitted` and `cancelled` are terminals. Value `grading` is reserved for Phase 2 async worker. | Resolves ambiguity between data-model.md:368 and ai-pipeline.md. Supersedes api-contract.md:217 which erroneously had `status:'grading'` for Phase 1. See PHASE_1_KICKOFF.md D2-D3. |
| 2026-05-01 | **`help_content` RLS uses `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid`** — standard RLS fails-closed on global-default rows. RLS linter updated to accept this variant for nullable `tenant_id` columns. | See PHASE_1_KICKOFF.md D11. |
| 2026-05-01 | **Phase 1 module dependency order:** 04 (standalone) → 05 (needs 04) → 06+11 (parallel, need 05); 16 (parallel from 17, day 1). Tooltip primitive ships in 16's first PR. | Kickoff plan G1.A/G1.B/G1.C groupings. Docs: `docs/plans/PHASE_1_KICKOFF.md`. Commit: `7573f68`. |
| 2026-05-02 | **Phase 2 module dependency order:** 07 (single session, codex:rescue mandatory — load-bearing classifier; ships D2 lint sentinel as load-bearing-with-rescue-gate file) → 08+09 (parallel, depend on 07's `gradings` row contract) → 10 (admin dashboard + Phase 2 17-ui-system primitives). 18 decisions captured at orchestrator-default; D1–D8 are verbatim restatements of `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) and remain load-bearing. | Kickoff plan G2.A/G2.B/G2.C groupings. Docs: `docs/plans/PHASE_2_KICKOFF.md`. Commit: `53a881e`. |
| 2026-05-11 | **Phase 5 (Credentialize) scoped as a post-MVP sidecar.** New module `18-certification` (not yet scaffolded). Tamper-evident certificate model: snapshotted `Certificate` row with HMAC-SHA256 `signed_hash`, public `credential_id` slug (`PREFIX-YYYY-MM-XXXXXX`), `UNIQUE(user_id, enrollment_id)` for idempotence, tier upgrades only go up (never downgrade an issued cert even on state regression). PDF + QR → public verify page; LinkedIn share; admin revoke with reason. Estimated 6–10 sessions. | Additive feature, doesn't block MVP. Self-contained plan handed off as project-agnostic blueprint. Doc: `docs/CERTIFICATION_PLAN_GENERIC.md`. Commit: `033f993`. |
| 2026-05-03 | **Phase 3 module dependency order:** G3.A (`14-audit-log` — load-bearing per CLAUDE.md, codex:rescue mandatory; helper API + table + GRANT enforcement + S3 archive + 9 critical wired sites) ‖ G3.B (`13-notifications` — real SMTP swap-in for Phase 0 stub, webhook delivery, in-app short-poll, audit-fanout) → G3.C (`15-analytics` — depends on Phase 2 G2.B 09-scoring `attempt_scores` + 14's `audit_log`; ships `attempt_summary_mv` eagerly, reports/exports/cost-empty-shape) → G3.D (week 10, non-blocking — cross-module audit-write sweep across remaining 26 catalog entries via parallel Sonnet dispatch). 22 decisions captured: D1–D8 verbatim restatements still load-bearing; P3.D9–P3.D22 new orchestrator-defaults. P3.D9 (SMTP=AWS SES) is the only soft-escalate; user may swap to Sendgrid mechanically. | Kickoff plan G3.A/G3.B/G3.C/G3.D groupings. Docs: `docs/plans/PHASE_3_KICKOFF.md`. Commit: `9ee5347`. |
| 2026-05-03 | **Phase 4 (12-embed-sdk) locked 13 design decisions before implementation.** Key: candidate-take-only scope (D1); 8h embed session in `aiq_embed_sess` cookie (D6); SameSite=None;Secure cross-origin cookies (D7); CSP `frame-ancestors` per-tenant override (D8); 24h key-rotation grace window (D4); SDK old-version → 426 + 6-month deprecation policy (D12); DPDP `privacy_disclosed` column gate (D13). Full decision set: `modules/12-embed-sdk/SKILL.md`. Commits: `b7dfaa9` (decisions pre-flight), `b20858b` (implementation). | Pre-flight pin before implementation to prevent mid-session ambiguity on security-adjacent choices. Phase 4 was the only build phase with no corresponding decision-log entry; pinning decisions in SKILL.md alone makes them invisible to Phase 0 reads. |
| 2026-05-08 | **Dev-only E2E session minter hardened.** `tools/dev-mint-session.ts` gated behind `NODE_ENV !== 'production'` compile-time check + `DEV_MINT_ENABLED` env gate + brute-force allowlist. Four escalation vectors (token-forgery, brute-force) closed by `bd0ceb0` after `codex:rescue` adversarial pass on `b3710ae`. | `b3710ae` exposed a `/api/dev/mint-session` route with no production guard; adversarial flag required immediate hardening before deploy. |
| 2026-05-09 | **Type-sharded generation (Stage 1) shipped** — five type-specialist skills (`generate-{mcq,log-analysis,scenario,kql,subjective}`) fan out in parallel within one `singleFlight` mutex; structural Zod validation at MCP `submit_questions` boundary (Stage 1.5e); eval baseline 75/75. Commit: `f449203`. Design: `docs/design/2026-05-09-type-sharded-generation.md`. | Omnibus skill ran all types in one subprocess (~3 min); type shards target ≤90 s. Domain isolation improves schema conformance and per-type quality measurability. No-ambient-AI invariant preserved. |
| 2026-05-10 | **Stage 3.0 per-tenant `ai_generate_mode` locked (Option A).** `tenant_settings.ai_generate_mode` ENUM (`omnibus`\|`sharded`) column; super-admin UI toggle; `assessiq-stage3-watch` cron polls every 4 h and auto-promotes tenants meeting G1 criteria. Commits: `80e713a` (column + handler), `05ea435` (cron), `d59ade4` (`super_admin` role). Design + §8 decisions: `docs/design/2026-05-10-stage-3-promotion-rollout.md`. Stage 3.1 (flip `sharded` to default) gated on G1/G2/G4. | Option B (global env-var flip + auto-rollback cron) rejected — per-tenant column gives blast-radius containment; one pilot tenant regression doesn't affect all tenants. |
| 2026-05-11 | **Phase 5 Sessions 1–2 shipped: scaffold + HMAC signing + `credential_id` + `issueCertificate`.** Scaffold (`2835680`); crypto core (`c356160`); adversarial revisions + re-gate closure (`19d722c`, `35f067a`). 79/79 tests. R1–R7 adversarial findings addressed (CRITICAL millisecond-drift, TOCTOU tier-upgrade, homoglyph CHARSET). RLS-bypass for public verify locked as **Option 3**: public-tenant GUC policy (`SET LOCAL ROLE assessiq_system`) per SKILL.md D7. Session 3 next: `/verify/:credentialId` + OG image. | HMAC signing is security-adjacent; `codex:rescue` adversarial gate mandatory. Millisecond-drift (R1) would have broken 100% of certificates at verify — CRITICAL; RCA logged. |
| 2026-05-14 | **UI Kit v1.1 fully adopted** — all 14 phases of `docs/plans/UI_KIT_V1_1_PORT.md` shipped. Every page uses count `Chip` + serif h1 (aiq-font-serif, weight 400, −0.02em) + lede paragraph; `Spinner` replaces all "Loading…" text; `--aiq-color-bg-raised` is the standard surface. `@axe-core/playwright` a11y gate added for unauthenticated pages. Visual regression + Lighthouse deferred to Phase 15. | Gradual port (14 focused sessions) over lift-and-shift prevented regressions in load-bearing paths. Reduced-motion covered globally via `tokens.css` `prefers-reduced-motion` block — no per-component override needed except `useCountUp.ts` (JS-driven animation). Port plan: `85d5d4b`; tokens live: `b95df19`; plan closure: `ae672d4`. |
| 2026-05-13 | **Rate-limit bypass predicate must mirror `requireAuth`'s `MFA_REQUIRED` logic exactly.** When `MFA_REQUIRED=false`, the TOTP gate is dormant in both paths (auth gate and rate-limit bypass predicate). Prior to `007f1f7`, the bypass required `totpVerified===true` unconditionally — in production with `MFA_REQUIRED=false`, the bypass never fired and every admin login flow 429'd itself. Adversarially reviewed: Sonnet+GLM both ACCEPT on 8 attack vectors. Commit: `007f1f7`. Ref: `docs/04-auth-flows.md § Admin/reviewer IP rate-limit bypass`. | Security invariant: if the two gate code paths diverge on `MFA_REQUIRED` semantics, one environment's config silently breaks auth while passing all tests. Future changes to either `requireAuth` or the bypass predicate must keep them in sync. |
| 2026-05-13 | **Candidate portal auth: passwordless magic-link (Option A), 30-day fixed session, POST-verify via SPA intermediary.** Chose magic-link over SSO (requires per-tenant admin config) and password (adds credential management for low-use cert portfolio). Session is 30-day fixed-window (not sliding 8h). Verify endpoint is POST not GET — email-crawler GET-prefetch would burn the single-use token; SPA at `/candidate/login/verify` executes the POST via JS. Constant-time 200ms anti-enumeration floor; Redis per-(IP,email) rate-limit fails-closed on Redis outage. Adversarially reviewed: Sonnet+GLM round 1 REJECT (cross-tenant lookup via BYPASSRLS) → round 2 ACCEPT. Commit: `e93675d`. | Lowest-friction auth for candidates who only need access to a cert portfolio. The GET-burn hazard is a non-obvious protocol constraint that must survive future email-template changes — any link in a candidate email pointing to a verify-type endpoint must use the SPA-intermediary pattern. |
| 2026-05-13 | **Stage 3.1 promotion gate uses stage-aware progressive criteria (operator sign-off 2026-05-13).** 3.1=3-of-5 clean (pilot); 3.2=rolling-4-of-5; 3.3=4-of-5 or 5-consec; 3.4=5-consec over 7 days. All stages: avg `chunks_failed ≤ 1.0`, no double-chunk failures. Rolling window starts post-D1+D2 deploy (`5d05d15`). Commits: `997e2b5` (rolling-4-of-5 revision), `5391797` (stage-aware supersession). Design: `docs/design/2026-05-10-stage-3-promotion-rollout.md §2`. | Per-chunk failure rate ~15–20% even after 3 SKILL.md tightening rounds. Pinning Stage 3.1 at 4-of-5 imposes production reliability cost without the pilot benefit — a single-tenant pilot can absorb sub-95% reliability with 24h watch. Progressive gates absorb inherent smoke-campaign variance. Supersedes the single-threshold criterion in the Stage 3.0 entry. |
| 2026-05-13 | **`audit_log` rows for admin-override do NOT copy `gradings.override_reason` (PII policy).** Free-text admin justification is preserved only in the immutable `gradings` row; auditors pivot via `audit_log.entity_id → gradings.id`. Three defense layers: inline policy comment at `admin-override.ts:118–135`; `docs/11-observability.md §29.1`; static regression guard in `audit-writes.test.ts` asserting `override_reason` absent from the `auditInTx` call block. Retention note: any future `gradings` purge sweep must use a window ≥ `audit_log` retention or override audit rows will outlive their justification chain. Commit: `b5aa332`. | Audit table is REVOKE-protected and broadly indexed for compliance queries that run without need-to-know of PII. Forensic chain intact via entity_id pivot; PII boundary clean. |
| 2026-05-14 | **G3.D invariant: every admin-mutating service function writes exactly one `audit_log` row inside the same Postgres transaction via `auditInTx` — never fire-and-forget, never a separate transaction.** Sweep covered all 26 catalog entries across 01-auth, 02-tenancy, 03-users, 04-question-bank, 05-lifecycle, 07-ai-grading, 09-scoring, 12-embed-sdk, 13-notifications, 16-help-system, 18-certification. Commits: `eff0ba2`, `08d4b19`, `057de7d`, `15c7728`, `dad0d9a`; sweep closed `15ed2d3`. | A graded attempt without an audit row is the worst-case compliance hole. Fire-and-forget audit calls were the pre-G3.D pattern; a separate-transaction audit could silently drop on DB contention without rolling back the business operation. The Working Agreements section cites the rule; this entry records the *why* for future sessions. |
| 2026-05-14 | **Phase 15 quality gates: Lighthouse CI (advisory, ≥0.90, 5 unauthenticated routes) + Playwright visual regression (Docker-only baseline, Linux CI only).** Lighthouse routes: `/admin/login`, `/candidate/login`, `/take/expired`, `/take/error`, `/this-is-not-a-page`. Runs as advisory PR check (not required status check) — promote to required after auth-seeded coverage is added. Visual baselines are NOT committed; must be generated inside `mcr.microsoft.com/playwright:v1.59.1-jammy` to be byte-identical on CI. Commits: `f34f9bd` (Lighthouse CI), `10f1540` (Playwright visual regression). | Advisory status allows incremental hardening without blocking PRs. Docker-only baseline prevents host-OS font/rendering drift from causing false CI failures. Auth-seeded Lighthouse and visual coverage deferred until Playwright session fixtures exist. |
| 2026-05-20 | **Mobile Kit Port M0–M6 SHIPPED in one day.** Seven phases (M0 foundation, M1 magic-link landing, M2a AttemptPage chrome, M2b per-Q-type sizing, M3 Submitted, M4 CandidateShell nav + Activity, M5 admin graceful-degrade, M6 docs/handoff) covering the entire candidate-facing surface for phones. **Visual-only port; no new routes, no flow changes, no API changes, no auth-semantics changes.** Same DOM both viewports throughout — mobile is a CSS-only delta keyed on M0's `data-viewport="mobile"`, plus a lazy `<Drawer>` mount for the take-flow question navigator (M2a) and a controlled-state overflow menu in CandidateShell (M4). Admin remains desktop-only with a graceful-degrade interstitial (M5); login/MFA routes excluded so admins can resolve auth challenges on the go; per-session `sessionStorage` override available. KQL question type kept the existing plain-textarea answer + a mobile-only caveat tip — Monaco/desktop-required interstitial deferred to a future M2b' when Phase 2 KQL editor lands. CandidateShell scope expansion (adding inline NavLinks for the two existing candidate routes) was explicitly user-approved via AskUserQuestion. Four new help-system entries added (navigator.toggle, kql.mobile_tip, shell.nav.mobile_menu, mobile_continue_anyway), each catch-up-committed through the `0011_seed_help_content.sql` drift gate. Commits: `b6e8f1c` M0, `eaa849b` M1, `fb1c701` M2a, `4d4b20c`+`bc4f366` M2b, `4393cbb` M3, `a385f94`+`4ee9e5a` M4, `7fede89`+`672283f` M5. Plan + status header: `docs/plans/MOBILE_KIT_PORT.md`. Visual contract: `docs/10-branding-guideline.md § 15`. API surface: `docs/08-ui-system.md § Mobile`. | Phased one-by-one over a single day rather than one-shot; each phase shipped with same-PR docs + a handoff + a help-seed catch-up where needed. North-star rule throughout: *functionality drives UI; UI never drives functionality* — the mobile kit is a palette of idioms, not a product spec. M4 was the only phase that added net-new functionality (shell-level nav between the two existing candidate routes) — surfaced as a product decision via AskUserQuestion before implementing, justified by the existing route inventory. |

## Working agreements (for Claude Code sessions)

- Always read this `PROJECT_BRAIN.md` first.
- For module work, also read that module's `SKILL.md` plus its declared dependencies.
- Schema changes require updating `docs/02-data-model.md` in the same PR.
- API changes require updating `docs/03-api-contract.md` in the same PR.
- New UI elements require a `help_id` and content entry in `16-help-system`.
- Every AI prompt is versioned in `modules/07-ai-grading/prompts/` and referenced by hash in grading records.
- **Every admin-mutating service function must write one `audit_log` row inside the same Postgres transaction via `auditInTx`** — never fire-and-forget, never in a separate transaction. Established by G3.D sweep (commits `eff0ba2`, `08d4b19`, `057de7d`).

## Where to look for what

| If you need to know... | Read |
|---|---|
| The big picture | `docs/01-architecture-overview.md` |
| What's in the database | `docs/02-data-model.md` |
| What endpoint to call | `docs/03-api-contract.md` |
| How auth works | `docs/04-auth-flows.md` |
| How AI grading works | `docs/05-ai-pipeline.md` |
| How to deploy | `docs/06-deployment.md` |
| How to add tooltip/help text | `docs/07-help-system.md` |
| How to theme / build UI | `docs/08-ui-system.md` |
| Brand visuals — typography, palette, screen-layout templates, component idioms (read before designing any new page) | `docs/10-branding-guideline.md` |
| How a host app embeds AssessIQ | `docs/09-integration-guide.md` |
| What a specific module does | `modules/<n>-<name>/SKILL.md` |
| How to conduct an assessment end-to-end (L1→L3) | `/admin/guide` (live admin UI) and this table row |
| Create and manage a question pack | `/admin/question-bank` (list) → `/admin/question-bank/:id` (detail with levels + questions) |
| Set up an assessment cycle and invite candidates | `/admin/assessments` (list) → `/admin/assessments/:id` (detail with invite picker) |
| View cohort or individual reports | `/admin/reports` (landing) → `/admin/reports/cohort/:id` or `/admin/reports/individual/:userId` |
| What candidates see during their assessment | `/take/<token>` (magic-link landing) and `/take/attempt/<id>` (question runner). Help drawer: `modules/11-candidate-ui/src/components/CandidateHelp.tsx` |
| Type-sharded question generation design | `docs/design/2026-05-09-type-sharded-generation.md` |
| Stage 3 promotion rollout decisions | `docs/design/2026-05-10-stage-3-promotion-rollout.md` |
| Credentialing plan + module 18 spec | `docs/CERTIFICATION_PLAN_GENERIC.md` + `docs/14-credentialing.md` |
