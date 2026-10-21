# AssessIQ — Project Brain

> **Read this first in every Claude Code session.** This is the single source of truth for orientation. Module-level details live in `modules/<n>-<name>/SKILL.md`. Cross-cutting concerns live in `docs/`.

---

## What AssessIQ is

A scenario-driven, tier-based, hybrid-graded **role-readiness assessment platform** for technical teams. The first real use is a university aptitude pilot; every other domain (DevOps, Cloud Architects, Identity, IR, etc.) plugs in as additional question packs against the same engine.

**Three product surfaces:**
1. **Standalone web app** — `https://assessiq.in`
2. **Embeddable widget** — iframe with signed JWT, drops into any host application
3. **REST API + webhooks** — for back-end integrations (Workday, ServiceNow, custom HRMS)

## Non-negotiable design principles

1. **Multi-tenant from day one.** Every table has `tenant_id`. Each customer is one tenant.
2. **Domain-agnostic core.** No `if domain === "soc"` anywhere. Domain lives in question packs (data), not code.
3. **Graduated scoring, never binary.** Subjective answers land in 0/25/50/75/100 bands, never raw "73%".
4. **Auditable AI.** Every AI grade stores anchors, band, justification, error class, model, prompt version. Admin override never replaces the AI verdict — it sits beside it.
5. **AI grading runs as the admin, not as a product.** Phase 1 uses Claude Code CLI on the VPS under the admin's Max subscription. Only the platform super admin starts an AI evaluation. It is synchronous and triggered only by a click — never a cron, webhook, or candidate event. Phase 2 (paid budget) switches to API-key auth via the Agent SDK. **Never** wire ambient/background AI calls under Max-OAuth — that crosses the ToS line. See `docs/05-ai-pipeline.md`.
6. **Help is a first-class module.** Every UI element with a `help_id` has tooltip + drawer content. Authoring is centralized.

## Tech stack (committed)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS + Fastify | Matches IntelWatch ETIP; one mental model |
| DB | PostgreSQL 16 + RLS | Tenant isolation enforced at row level |
| Cache / queue | Redis 7 + BullMQ | Sessions, rate limits. BullMQ runs non-AI jobs only (email, webhooks, reminders, scheduled jobs). No AI call runs on a queue |
| AI runtime | **Phase 1:** Claude Code CLI on VPS (Max subscription, admin-in-the-loop, sync-on-click). **Phase 2 (designed, switchable via `AI_PIPELINE_MODE`):** Claude Agent SDK (TypeScript) via `ANTHROPIC_API_KEY` | Phase 1: $0 API cost, admin-in-the-loop ToS compliance. Phase 2: unlocks async + non-admin triggers. See `docs/05-ai-pipeline.md`. |
| AI models | Sonnet 4.6 (primary), Haiku 4.5 (anchors), Opus 4.7 (escalation) | Multi-tier pipeline by stakes |
| Frontend | React 19 + Vite 8 + TypeScript | Fast iteration, embeds cleanly in iframe |
| Styling | Tailwind + design-token CSS vars | Theming per tenant; UI template plugs in here |
| Auth (admin) | Google sign-in or email one-time code. TOTP MFA is optional for tenant admins now (to be enabled later; owner decision 2026-10-02) and always required for `super_admin`; `super_admin` role for cross-tenant ops (`d59ade4`) | Phase 1 |
| Auth (extensible) | OIDC, SAML, magic-link, email+password | Phase 2, admin-toggleable per tenant |
| Hosting | Hostinger VPS, Docker Compose, Caddy reverse proxy behind Cloudflare | Reuses your IntelWatch infra playbook |
| Domain | `assessiq.in` (canonical since 2026-05-22; `assessiq.automateedge.cloud` 301-redirects) | Brand domain |

## Module map

```
00-core                Config, env, logging, base types, error handling
01-auth                Google SSO + TOTP, magic link, embed JWT, API keys, sessions
02-tenancy             Tenant CRUD, isolation, RLS policies, settings
03-users               User model, roles (admin/reviewer/candidate; reviewer role removed 2026-10-03 (RV60; legacy DB value kept)), invites
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
19-billing             Usage metering (one credit per graded attempt), tenant plans, entitlements
20-data-rights         DPDP/GDPR data-subject rights: admin-mediated access export, erasure, retention cron
```

## Build phases

| Phase | Modules | Outcome |
|---|---|---|
| **Phase 0** — Foundation (Week 1–2) | 00, 01, 02, 03, 17 | Auth + tenancy + UI kit working |
| **Phase 1** — Author & take (Week 3–5) | 04, 05, 06, 11, 16 | SOC pack authored, candidates can take assessments end-to-end with help system. **Closure audit CLOSED (2026-05-03, `2c9af6b`):** All 5 drills PASSED. D1 step 9 confirmed live after `d681ec5` fix; D4 autosave+timer accepted PASSED (Option A pragmatic — mechanics verified live during G1.D ship). Finding C (`tenantName:""` → Zod `.min(1)` crash) fixed 2026-05-11 in `05-lifecycle:691-708`: real `tenant.name` fetched in `withTenant` tx; throws `TENANT_NAME_MISSING` on null/empty. RCA logged. |
| **Phase 2** — Grade & report (Week 6–8) | 07, 08, 09, 10 | ✅ shipped; type-sharded generation (Stage 1, 5 type skills) live (`f449203`); Stage 3.0 per-tenant `ai_generate_mode` plumbing shipped (`80e713a`); Stage 3.1 default flip to `sharded` pending G1/G2/G4 criteria — see `docs/design/2026-05-10-stage-3-promotion-rollout.md`. `super_admin` role + Stage 3 watch cron live (`d59ade4`, `05ea435`). |
| **Phase 3** — Operate (Week 9–10) | 13, 14, 15 | ✅ G3.A audit-log (`43c0e45`) + G3.B notifications (`cae6d37`) + email i18n (`7a20ee2`) + G3.C analytics (`ce041e3`) shipped; G3.D atomic `auditInTx` sweep ✅ COMPLETE (2026-05-14): 03-users `057de7d`, 05-lifecycle `08d4b19`, 04-question-bank `eff0ba2`, 07-ai-grading, 09-scoring, 16-help-system, 18-certification, 01-auth+02-tenancy+12-embed-sdk+13-notifications `dad0d9a`. 06-attempt-engine correctly excluded (all candidate-facing); 13-notifications/in-app correctly excluded (system/user paths); 10-admin-dashboard has no backend service layer. |
| **Phase 4** — Embed (Week 11–12) | 12 | ✅ shipped (`b20858b`, 2026-05-03); iframe + JWT embed + session minting + admin surface live; consumer integration guide at `docs/09-integration-guide.md`. |
| **Phase 5** — Credentialize (post-MVP, 6–10 sessions) | 18-certification | ✅ shipped (Sessions 1–10, 2026-05-11 → 2026-05-14): HMAC signing, public verify, PDF, OG meta, LinkedIn PNG, auto-issue trigger, admin UI, LinkedIn share button. Out of scope for Phase 1 of cert: LinkedIn "Add to Profile" API, employer/recruiter portal, fraud detection beyond HMAC + revocation. Plan: `docs/plans/archive/CERTIFICATION_PLAN_GENERIC.md`. |
| **Pilot hardening** (2026-10-01 → 2026-10-02) | pilot batches 1–8; SP1–SP4, SP7, SP9–SP11 | Live for the university aptitude pilot. Batches: readiness (invites, email and webhook hardening, release on last accept; `docs/plans/archive/PILOT_READINESS_BATCH.md`), 3–4 (question types, sections, reminders, load hardening; `PILOT_BATCHES_3_4.md`), 5 (high-stakes vote, eval gate; `PILOT_BATCH_5.md`), 6 (CI green, dependency bumps; `PILOT_BATCH_6.md`), 7 (eval golden set, NODE_ENV required; `PILOT_BATCH_7.md`), 8 (SEO dates, IndexNow, ordering type; `PILOT_BATCH_8.md`). Scoring and result release: students see only complete scores, and only the platform super admin runs AI evaluation (`docs/plans/archive/SCORING_RESULT_RELEASE.md`). Batch 2 detail is in `docs/SESSION_STATE.md`. |

## Decision log

Decisions from 2026-10 on: `docs/DECISIONS.md` (append-only: date, decision, source). Decisions of 2026-05 (phase plans, hardening choices): `docs/archive/PROJECT_BRAIN-decisions-2026-05.md`. The rows below are the founding choices and Rules A and B.

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Multi-tenant from day one | Embeddability and future client deployments require it; retrofit cost is high |
| 2026-04-29 | Google SSO + TOTP for v1 | User constraint; admin-toggleable extensions in v2 |
| 2026-04-29 | **Phase 1 grading uses Claude Code CLI on VPS under admin's Max subscription** (sync-on-click, single-admin-in-the-loop, no Agent SDK, no `ANTHROPIC_API_KEY`). Phase 2 swap to paid Anthropic API stays designed but deferred. | $0 budget for AI APIs. Anthropic ToS forbids Max-auth in *products* but allows the subscriber to script their *own* use; admin-in-the-loop preserves that line. Supersedes the earlier "Agent SDK + API key" plan from the same date. See `docs/05-ai-pipeline.md`. |
| 2026-04-29 | Hostinger VPS + Docker Compose | Reuses IntelWatch ETIP playbook; AWS migration deferred until traffic warrants it |
| 2026-04-29 | Subdomain on automateedge.cloud | Existing infra; white-label capability via tenant-level domain mapping in v2 |
| 2026-04-29 | Help system as separate module | First-class concern, not bolt-on; centralized authoring + i18n-ready |
| 2026-04-30 | UI template at `modules/17-ui-system/AssessIQ_UI_Template/` adopted as the brand base; canonical guideline distilled to `docs/10-branding-guideline.md` | Reuse over redesign; the editorial typography (Newsreader serif + Geist sans + JetBrains Mono), OKLCH palette around hue 258, density-via-`--u` mechanic, and pill-button + editorial-card idioms are intentional and reusable. Future pages inherit from this guideline. Folder renamed from `AccessIQ_UI_Template` to `AssessIQ_UI_Template` 2026-05-13 when the v1.1 kit dropped. Rename commit: `9c03797`. |
| 2026-10-02 | **Rule A — dormant or stale features are never deleted because they are unused.** Review first: purpose, what operates now, a better option, a merge with a newer feature. Result: revive, merge, improve or park. A delete needs written research, an item that is absolutely useless for a professional product, and owner approval. | Prevents loss of working design. |
| 2026-10-02 | **Rule B — before any new task, find the similar older task or feature.** Compare both. Implement the better or the combined version. Note "old task or feature checked" in the handoff (the `**Old task or feature checked:**` line of the CLAUDE.md session-state template). | Prevents duplicate features. |

## Working agreements (for Claude Code sessions)

- Always read this `PROJECT_BRAIN.md` first.
- For module work, also read that module's `SKILL.md` plus its declared dependencies.
- Schema changes require updating `docs/02-data-model.md` in the same PR.
- API changes require updating `docs/03-api-contract.md` in the same PR.
- New UI elements require a `help_id` and content entry in `16-help-system`.
- AI prompts are skills stored on the production server only (not in git since 2026-10-01). The sha256 of each skill is recorded on every grading row.
- **Rule A — keep dormant features, review them.** Never delete a dormant or stale feature because it is unused. Review it first: its purpose, what operates now, a better option, a merge with a newer feature. The result is revive, merge, improve or park. A delete needs written research, an item that is absolutely useless for a professional product, and owner approval.
- **Rule B — check the old task first.** Before any new task, find the similar older task or feature. Compare both. Implement the better or the combined version. Note "old task or feature checked" in the handoff: fill the `**Old task or feature checked:**` line of the session-state template in CLAUDE.md (added 2026-10-16, RV79).
- **Every admin-mutating service function must write one `audit_log` row inside the same Postgres transaction via `auditInTx`** — never fire-and-forget, never in a separate transaction. Established by G3.D sweep (commits `eff0ba2`, `08d4b19`, `057de7d`).

## Where to look for what

| If you need to know... | Read |
|---|---|
| What is open (status board first) | `docs/ROADMAP.md` |
| Plans and specs, open and archived | `docs/plans/README.md` |
| The big picture | `docs/01-architecture-overview.md` |
| What's in the database | `docs/02-data-model.md` |
| What endpoint to call | `docs/03-api-contract.md` |
| How auth works | `docs/04-auth-flows.md` |
| How AI grading works | `docs/05-ai-pipeline.md` |
| How to deploy | `docs/06-deployment.md` |
| How to add tooltip/help text | `docs/07-help-system.md` |
| How to theme / build UI | `docs/08-ui-system.md` |
| Observability, logs, metrics | `docs/11-observability.md` |
| Test coverage map | `docs/12-test-coverage.md` |
| Email system (SMTP, templates, queue) | `docs/13-email-system.md` |
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
| Credentialing plan + module 18 spec | `docs/plans/archive/CERTIFICATION_PLAN_GENERIC.md` + `docs/14-credentialing.md` |

## Pending task list (2026-10-01)
Full list of open tasks, each with the reason it is needed: `docs/ROADMAP.md`. It is a snapshot from a cross-repo review; check each item before starting.
