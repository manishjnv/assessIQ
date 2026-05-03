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
| AI runtime | Claude Agent SDK (TypeScript) | Same agent loop as Claude Code, production-licensed via API key |
| AI models | Sonnet 4.6 (primary), Haiku 4.5 (anchors), Opus 4.7 (escalation) | Multi-tier pipeline by stakes |
| Frontend | React 18 + Vite + TypeScript | Fast iteration, embeds cleanly in iframe |
| Styling | Tailwind + design-token CSS vars | Theming per tenant; UI template plugs in here |
| Auth (admin) | Google SSO (OIDC) + TOTP MFA mandatory | Phase 1 |
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
```

## Build phases

| Phase | Modules | Outcome |
|---|---|---|
| **Phase 0** — Foundation (Week 1–2) | 00, 01, 02, 03, 17 | Auth + tenancy + UI kit working |
| **Phase 1** — Author & take (Week 3–5) | 04, 05, 06, 11, 16 | SOC pack authored, candidates can take assessments end-to-end with help system. **Closure audit PARTIAL (2026-05-03):** Drills 2+3(steps 1-4)+5 PASS; Drill 1 fails at invite (Finding C: `05-lifecycle:749` `tenantName:""` × `13-notifications` Zod `.min(1)`); Drills 3(step 5)+4 BLOCKED. Fix: fetch `tenant.name` from DB in `inviteUsers` before email call. Re-audit required. |
| **Phase 2** — Grade & report (Week 6–8) | 07, 08, 09, 10 | AI grading live, admin dashboard, archetype output |
| **Phase 3** — Operate (Week 9–10) | 13, 14, 15 | Notifications, audit log, analytics |
| **Phase 4** — Embed (Week 11–12) | 12 | iframe + JWT embed working in a host app |

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Multi-tenant from day one | Embeddability and future client deployments require it; retrofit cost is high |
| 2026-04-29 | Google SSO + TOTP for v1 | User constraint; admin-toggleable extensions in v2 |
| 2026-04-29 | **Phase 1 grading uses Claude Code CLI on VPS under admin's Max subscription** (sync-on-click, single-admin-in-the-loop, no Agent SDK, no `ANTHROPIC_API_KEY`). Phase 2 swap to paid Anthropic API stays designed but deferred. | $0 budget for AI APIs. Anthropic ToS forbids Max-auth in *products* but allows the subscriber to script their *own* use; admin-in-the-loop preserves that line. Supersedes the earlier "Agent SDK + API key" plan from the same date. See `docs/05-ai-pipeline.md`. |
| 2026-04-29 | Hostinger VPS + Docker Compose | Reuses IntelWatch ETIP playbook; AWS migration deferred until traffic warrants it |
| 2026-04-29 | Subdomain on automateedge.cloud | Existing infra; white-label capability via tenant-level domain mapping in v2 |
| 2026-04-29 | Help system as separate module | First-class concern, not bolt-on; centralized authoring + i18n-ready |
| 2026-04-30 | UI template at `modules/17-ui-system/AccessIQ_UI_Template/` adopted as the brand base; canonical guideline distilled to `docs/10-branding-guideline.md` | Reuse over redesign; the editorial typography (Newsreader serif + Geist sans + JetBrains Mono), OKLCH palette around hue 258, density-via-`--u` mechanic, and pill-button + editorial-card idioms are intentional and reusable. Future pages inherit from this guideline. |
| 2026-05-01 | **Phase 1 `attempt.status` enum confirmed:** `draft → in_progress → submitted → pending_admin_grading → graded → released`; `auto_submitted` and `cancelled` are terminals. Value `grading` is reserved for Phase 2 async worker. | Resolves ambiguity between data-model.md:368 and ai-pipeline.md. Supersedes api-contract.md:217 which erroneously had `status:'grading'` for Phase 1. See PHASE_1_KICKOFF.md D2-D3. |
| 2026-05-01 | **`help_content` RLS uses `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::uuid`** — standard RLS fails-closed on global-default rows. RLS linter updated to accept this variant for nullable `tenant_id` columns. | See PHASE_1_KICKOFF.md D11. |
| 2026-05-01 | **Phase 1 module dependency order:** 04 (standalone) → 05 (needs 04) → 06+11 (parallel, need 05); 16 (parallel from 17, day 1). Tooltip primitive ships in 16's first PR. | Kickoff plan G1.A/G1.B/G1.C groupings. Docs: `docs/plans/PHASE_1_KICKOFF.md`. |
| 2026-05-02 | **Phase 2 module dependency order:** 07 (single session, codex:rescue mandatory — load-bearing classifier; ships D2 lint sentinel as load-bearing-with-rescue-gate file) → 08+09 (parallel, depend on 07's `gradings` row contract) → 10 (admin dashboard + Phase 2 17-ui-system primitives). 18 decisions captured at orchestrator-default; D1–D8 are verbatim restatements of `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) and remain load-bearing. | Kickoff plan G2.A/G2.B/G2.C groupings. Docs: `docs/plans/PHASE_2_KICKOFF.md`. |
| 2026-05-03 | **Phase 3 module dependency order:** G3.A (`14-audit-log` — load-bearing per CLAUDE.md, codex:rescue mandatory; helper API + table + GRANT enforcement + S3 archive + 9 critical wired sites) ‖ G3.B (`13-notifications` — real SMTP swap-in for Phase 0 stub, webhook delivery, in-app short-poll, audit-fanout) → G3.C (`15-analytics` — depends on Phase 2 G2.B 09-scoring `attempt_scores` + 14's `audit_log`; ships `attempt_summary_mv` eagerly, reports/exports/cost-empty-shape) → G3.D (week 10, non-blocking — cross-module audit-write sweep across remaining 26 catalog entries via parallel Sonnet dispatch). 22 decisions captured: D1–D8 verbatim restatements still load-bearing; P3.D9–P3.D22 new orchestrator-defaults. P3.D9 (SMTP=AWS SES) is the only soft-escalate; user may swap to Sendgrid mechanically. | Kickoff plan G3.A/G3.B/G3.C/G3.D groupings. Docs: `docs/plans/PHASE_3_KICKOFF.md`. |

## Working agreements (for Claude Code sessions)

- Always read this `PROJECT_BRAIN.md` first.
- For module work, also read that module's `SKILL.md` plus its declared dependencies.
- Schema changes require updating `docs/02-data-model.md` in the same PR.
- API changes require updating `docs/03-api-contract.md` in the same PR.
- New UI elements require a `help_id` and content entry in `16-help-system`.
- Every AI prompt is versioned in `modules/07-ai-grading/prompts/` and referenced by hash in grading records.

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
