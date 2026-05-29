# AssessIQ — Skill Development Plan (consolidated, final)

**Version:** v3 (consolidated 2026-05-28)
**Supersedes:** v1 (original 16-module proposal) + v2 (post-review revision) + standalone review document. This file is the single source of truth.
**Repo location:** `assessiq-skill-plan.md` at repo root.

**Position in work order.** This plan sits **behind** the in-flight grading-completion fix (`docs/design/grading-completion-fix-plan.md` — Bug A/B). It is **independent of** the global-competitiveness roadmap (`docs/design/global-competitiveness-roadmap.md`, committed `dac8370`), which runs on its own cadence. Finish grading-completion first. Start Tier A modules below only when their binding constraint surfaces.

**Status of all prerequisites:** ✅ complete (see §10).

---

## 1. Executive summary

AssessIQ has shipped Phases 0–5 (modules 00–18 live, 19-billing exists, mobile kit ported, canonical domain on `assessiq.in`, Phase 15 quality gates added). The product is in **steady-state operation + targeted feature additions** — not greenfield module construction.

The original plan proposed 16 new modules with batch SKILL.md authoring. That framing was stale: it pre-spec'd modules that may not ship for months and assumed MVP-era construction velocity. This consolidated plan:

- Tiers each remaining feature by risk class (Tier A / B / C).
- Writes full SKILL.md only for **5 high-risk treatments** (4 new modules + 1 in-place runtime swap). Tier B ships as standard PRs with no separate SKILL.md. Tier C folds into existing parent modules.
- Renumbers all new modules to start at **20** (the original plan collided with shipped `18-certification` and `19-billing`).
- Adds 3 modules absent from the original: `20-data-rights` (DPDP/GDPR), `21-billing-extensions` (Stripe Connect + metering), `22-search-discovery` (FTS).
- Folds 6 enhancement modules into parents.
- Resolves 3 critical conflicts with `CLAUDE.md` rules (numbering collision, runtime invariant, shared-VPS additive-only).

**Net new SKILL.md files at full detail:** 4 (down from 16).
**Total estimated sessions:** 60–82 (down from 74–101 in the original).
**First session to schedule:** `20-data-rights`, after grading-completion fix ships.

---

## 2. Maturity-stage framing — why this approach

Pre-writing 16 SKILL.md files in a planning sprint is the wrong mode at this stage:

- **Pre-written specs go stale.** A SKILL.md written today for a module built in 6 months will conflict with intervening RCA learnings, library upgrades, and product pivots.
- **Greenfield-construction and maintenance-plus-features are different modes.** The original SKILL.md investment (for modules 00-18) paid off because there were dozens of uncertain decisions across modules being built in rapid succession. That workload is over.
- **Claude Code reads context dynamically.** Existing code, `PROJECT_BRAIN.md`, `docs/`, and shipped module `SKILL.md` files give enough orientation for incremental PR work. Adding 16 new spec documents to read upfront is pure overhead.
- **This plan is a roadmap / backlog, not a queue of files to pre-write.** SKILL.md for each Tier A module is written at the start of that module's first build session — not during plan authoring.

---

## 3. Tier matrix

| Tier | Treatment | Modules |
|---|---|---|
| **A — Full SKILL.md, decisions pinned before code, `codex:rescue` adversarial review** | Security / compliance / irreversible / load-bearing. | `20-data-rights`, `30-public-marketplace`, `31-white-label-config`, `32-anti-cheat-integrity`, `07-ai-grading` OpenRouter runtime swap (in-place, not new module) |
| **B — PR-scope spec in commit body + same-PR docs (no separate SKILL.md)** | Medium-risk additive features. Decisions captured in the PR review loop. | `21-billing-extensions`, `22-search-discovery`, `23-live-simulation-engine`, `24-kql-playground`, `25-duckdb-investigation-sandbox`, `26-ai-question-generator-bridge`, `27-attack-scenario-authoring`, `28-team-assessment-mode`, `29-cohort-benchmarking` |
| **C — Fold into existing module's SKILL.md as Phase 2 entry (no new folder)** | Pure enhancements with no new architecture. | tool-emulation-skin → `17-ui-system`, question-versioning → `04-question-bank`, manager-review-panel → `10-admin-dashboard`, certification-engine-v2 → `18-certification`, ai-cost-optimizer → `07-ai-grading`, observability-stack → `00-core` + per-module |

**Distribution:** 5 Tier A treatments (4 new modules + 1 in-place change), 9 Tier B features, 6 Tier C folds.

---

## 4. Critical issues resolved from the original plan

### 4.1 Numbering collision with shipped code (FIXED)

The original plan's "Module 18 — live-simulation-engine" and "Module 19 — kql-playground" collided with existing `18-certification` (HMAC-signed credential module shipped 2026-05-11 → 2026-05-14) and `19-billing`. **All new modules renumbered to start at 20.** Full renumber map in §5.

### 4.2 Runtime invariant violation (FIXED via fold)

Original M32 (ai-cost-optimizer) proposed LiteLLM + OpenRouter multi-provider routing as a sibling to `07-ai-grading`. That crosses `CLAUDE.md` hard rule #2 — `@anthropic-ai/claude-agent-sdk` is allowed only in `modules/07-ai-grading/runtimes/anthropic-api.ts` behind `AI_PIPELINE_MODE=anthropic-api`. **Folded into `07-ai-grading` as a new runtime mode** `AI_PIPELINE_MODE=openrouter` with its own runtime file `modules/07-ai-grading/runtimes/openrouter.ts`. Hard rule #2 honored — Anthropic SDK stays gated to its own runtime file.

### 4.3 Shared-VPS additive-only violation (FIXED via fold + discovery prereq)

Original M33 (observability-stack) proposed standing up Prometheus + Jaeger + Grafana sidecars. The VPS is shared with A11yOS / AccessBridge / `automateedge.cloud` per `CLAUDE.md` rule #8. **Folded into `00-core` bootstrap + per-module instrumentation.** Prerequisite: enumerate existing OTel collectors on the VPS before scaffolding — export to existing infra rather than stand up a parallel stack.

---

## 5. Renumber map (original → final)

| Original # | Original name | Final # | Tier | Notes |
|---|---|---|---|---|
| 18 | live-simulation-engine | **23** | B | Collided with shipped `18-certification` |
| 19 | kql-playground | **24** | B | Collided with shipped `19-billing` |
| 20 | duckdb-investigation-sandbox | **25** | B | |
| 21 | tool-emulation-skin | — | C | Folded into `17-ui-system` Phase 2 |
| 22 | ai-question-generator-bridge | **26** | B | Promote to A if question pipeline becomes binding constraint |
| 23 | attack-scenario-authoring | **27** | B | |
| 24 | question-versioning | — | C | Folded into `04-question-bank` Phase 2 |
| 25 | team-assessment-mode | **28** | B | |
| 26 | cohort-benchmarking | **29** | B | |
| 27 | manager-review-panel | — | C | Folded into `10-admin-dashboard` sub-route |
| 28 | certification-engine-v2 | — | C | Folded into `18-certification` Phase 2 (already on 18's deferred roadmap) |
| 29 | public-assessment-marketplace | **30** | A | |
| 30 | white-label-config | **31** | A | |
| 31 | anti-cheat-integrity | **32** | A | |
| 32 | ai-cost-optimizer | — | C | Folded into `07-ai-grading` (Tier A as in-place runtime swap) |
| 33 | observability-stack | — | C | Folded into `00-core` + per-module |
| — *(new)* | data-rights | **20** | A | DPDP / GDPR compliance (overdue for shipped product) |
| — *(new)* | billing-extensions | **21** | B | Stripe Connect + usage metering — blocks marketplace paid launch |
| — *(new)* | search-discovery | **22** | B | Postgres FTS / Meilisearch — blocks marketplace + Q-bank scaling |

---

## 6. Tier A module specs

Full specs for each Tier A treatment. These are **candidate decisions** to anchor the first build session — the actual SKILL.md is written during that session, may revise these, and lives at `modules/<n>-<name>/SKILL.md`.

### 6.1 Module 20 — data-rights *(NEW)*

**One-liner:** DPDP Act 2023 + GDPR compliance — candidate data export, deletion, consent management, retention enforcement.

**Folder:** `modules/20-data-rights/`

**Dependencies:** `02-tenancy`, `03-users`, `06-attempt-engine`, `13-notifications`, `14-audit-log`.

**Pre-coding decisions (D1–D7):**

- **D1 — Export format.** JSON bundle with related-table joins (attempts, gradings, notifications, audit-log entries scoped to user). Signed download URL, 24h TTL.
- **D2 — Deletion model.** Pseudonymization for `users` / `attempts` (replace identifiers with `deleted_user_<hash>`) so `14-audit-log` immutability is preserved. Hard delete on `attempt_responses` free-text content.
  - **PII inventory on candidate user rows:** `display_name`, `email` only. Candidates do not log in and have no profile beyond invitation data — no `phone`, no DOB, no address, no resume upload.
  - **Tombstone values:** `display_name → 'deleted_user_<hash>'`, `email → 'deleted+<hash>@erased.local'`.
  - **`attempt_events`:** `ip` and `metadata` JSONB redacted via `14-audit-log/src/redact.ts` patterns.
  - **Certificates:** `display_name` snapshot stays verbatim — mutating it breaks the HMAC signature (per `18-certification` D4). Erasure removes the candidate's UI access to the cert; public `/verify/:credentialId` still resolves for recruiters.
- **D3 — Consent log.** `consent_events` table: `(user_id, consent_type, granted_at, ip, ua, lawful_basis)`. Per-purpose consent (assessment, marketing, benchmarking). Default deny on all. **Captured at the magic-link invitation-accept page before attempt-start** — that is the only candidate-facing surface that runs before grading begins. No ongoing in-product consent UI for candidates; withdrawal flows through the magic-link DSR page (see D5).
- **D4 — Retention policy.** Per-tenant `tenant_settings.retention_days` (default 730 = 2 years for HR-grade). Nightly purge cron. Audit row written on every purge.
- **D5 — SAR workflow.** **Magic-link-token DSR page** (`/dsr/:token`, HMAC-signed single-purpose token, 7-day TTL) reached via a footer link in every notification email. The page hosts export-request, consent-withdraw, and erasure-request — single surface, no candidate login. Admin can also initiate from the admin DSR queue. 30-day SLA per DPDP. Email notification on completion with signed download URL. (Candidates do not log in to AssessIQ, so a session-authenticated portal is not on the table; the token-page model is the entire candidate-facing surface for this module.)
- **D6 — Cross-border data handling.** Tenant-level `data_residency` flag (`in` / `eu` / `us`). For now, refuse SAR/export if residency mismatch with current hosting region.
- **D7 — Audit pivot on pseudonymized rows.** Forensic chain stays intact via `audit_log.entity_id` even after pseudonymization. Document in `docs/11-observability.md`.

**Out of scope:** Right-to-explanation for AI grading (Phase 2; needs `07-ai-grading` justification surfacing). Cookie consent UI for `assessiq.in` marketing pages (separate workstream). Candidate-facing profile management UI — there is no candidate login; rectification (`display_name` / `email` corrections) is admin-mediated only. DSR for non-candidate roles (admin, reviewer, super_admin) — those users sign employment-style agreements separately and are low-volume / manual.

**New help_ids:**
- `data_rights.export.start` — "Download a complete copy of your data"
- `data_rights.deletion.confirm` — "This action cannot be undone. Your grades are preserved without your name."
- `data_rights.consent.benchmarking` — "Allow your anonymized scores to inform industry benchmarks"

**Estimated sessions:** 3–5 (revised down from 4–6 — no candidate-portal scaffolding; single magic-link DSR page replaces a multi-page candidate dashboard).

| S | Scope |
|---|---|
| 1 | D7 audit of `audit_log` `before` / `after` JSONB for embedded PII across `01-auth`, `02-tenancy`, `07-ai-grading`, `13-notifications`; migrations 0097 (`consent_events`), 0098 (`users.erased_at`), 0099 (`tenant_settings.retention_days`); one-shot backfill of the Phase 4 `privacy_disclosed` column into `consent_events`. |
| 2 | Export service (admin-initiated + magic-link token issuance) + BullMQ ZIP-build worker + S3 signed URL + email wiring via `13-notifications`. |
| 3 | Magic-link DSR page (`/dsr/:token`) — export-request, consent-withdraw, erasure-request all on one server-rendered surface; HMAC token issuance + constant-time verification. |
| 4 | Admin DSR queue UI in `10-admin-dashboard` + identity-verification flow + super_admin-only `POST /api/admin/users/:id/erase` route. |
| 5 | Retention purge cron + per-tenant `retention_days` wired into admin settings UI + consent-ledger read surface on `/dsr/:token`. |

**`codex:rescue` gate:** mandatory on **S1** (the historical-row backfill is an exception to `14-audit-log` append-only — needs adversarial sign-off) and on **S3** (token-issuance + verification crypto surface is auth-adjacent). S2, S4, S5 follow the standard Phase 3 Opus diff-critique gate without `codex:rescue` unless their diffs land in `02-tenancy` or `14-audit-log`.

---

### 6.2 Module 30 — public-assessment-marketplace

**One-liner:** Tenant-publishable assessment packs discoverable by other tenants, with pricing tiers (free, paid, licensed), preview sampling, and revenue-share accounting.

**Folder:** `modules/30-public-marketplace/`

**Dependencies:** `04-question-bank`, `02-tenancy`, `05-assessment-lifecycle`, `10-admin-dashboard`, `13-notifications`, `14-audit-log`, **`21-billing-extensions`** (hard dependency for paid tier).

**Pre-coding decisions (D1–D10):**

- **D1 — "Publish to marketplace."** Tenant marks a question pack `marketplace_listed = true`. Public listing page at `/marketplace/:pack-slug`.
- **D2 — Pricing tiers.** `free` (any tenant can clone), `paid` (one-time fee in `marketplace_listings.price_usd`), `licensed` (recurring — Phase 1 contact-form only, Phase 2 Stripe Connect via `21-billing-extensions`).
- **D3 — Payment processing.** Phase 1: contact-publisher flow. Phase 2: Stripe Connect via `21-billing-extensions`. Do not launch paid tier without `21` shipped.
- **D4 — Pack cloning mechanics.** Cloned pack is a full deep copy into buyer's tenant schema. Publisher keeps original. Buyer can modify their copy.
- **D5 — Revenue share.** Out of scope for Phase 1 in-app. Track `marketplace_transactions` rows for future accounting.
- **D6 — Preview.** Admin configures `preview_question_count` (default 3). Preview questions watermarked in UI.
- **D7 — Quality control.** Super_admin reviews listings; states `draft | under_review | approved | rejected`.
- **D8 — Delisting.** Publisher or super_admin can delist. Tenants who already cloned keep their copy.
- **D9 — Listing review SLA (NEW vs original spec).** Super_admin must approve/reject within 3 business days. Publish state machine includes auto-escalation if breached. Without an SLA the marketplace dies of latency.
- **D10 — Cross-border listing (NEW).** Listings tagged with `data_residency`. Tenants from incompatible regions can preview but not clone until residency matches.

**Out of scope:** In-app payment (Phase 1), pack rating/review system, cross-pack bundles.

**New help_ids:**
- `marketplace.preview` — "Preview N sample questions before requesting access"
- `marketplace.clone` — "This pack will be copied into your workspace — you can modify it freely"
- `marketplace.contact` — "Contact the publisher to purchase access to this pack"
- `marketplace.sla` — Admin: "Listings are reviewed within 3 business days"

**Estimated sessions:** 6–8.
**`codex:rescue` gate:** mandatory (cross-tenant data flow, billing-adjacent).

---

### 6.3 Module 31 — white-label-config

**One-liner:** Per-tenant custom domain (DNS CNAME), logo, colour palette, email sender configuration, and login-page branding for managed-service / reseller deployments.

**Folder:** `modules/31-white-label-config/`

**Dependencies:** `02-tenancy`, `01-auth`, `13-notifications`, `17-ui-system`, `10-admin-dashboard`.

**Pre-coding decisions (D1–D7):**

- **D1 — Custom domain mechanics.** Tenant adds CNAME `assessiq.theirdomain.com → assessiq.in`. AssessIQ detects host header, loads tenant config. Cloudflare AOP protects origin.
- **D2 — TLS for custom domains.** Cloudflare SaaS (custom hostnames). **Costs $0.10/active hostname/month** — capture as visible OpEx in the decision so it isn't hidden.
- **D3 — Logo hosting.** Object storage under `tenant-assets/<tenant-id>/logo.[png|svg]`. Max 200KB, served via CDN.
- **D4 — Colour palette override.** Tenant provides `primary_hue` (OKLCH hue 0–360). AssessIQ generates full OKLCH palette from it at request time. Full custom palette is Phase 2.
- **D5 — Email sender.** Tenant provides `from_name` and `from_domain`. Verify domain ownership via DNS TXT record before activating. **DPDP cross-border note:** Indian-tenant candidate emails through US-region SES may breach data-residency expectations. Either move SES region or require tenant-owned SMTP from day one for Indian tenants. Decision required before scaffolding.
- **D6 — Login page branding.** Custom logo + background colour on `/login`. "Powered by AssessIQ" attribution shown unless tenant has Enterprise tier with attribution removal.
- **D7 — Subdomain isolation for cookies.** Custom domain gets its own `__Host-` prefixed session cookie. No shared cookie with `assessiq.in`.

**Out of scope:** Custom API base URLs per tenant, complete CSS override (only palette + logo), tenant-managed TLS certificates.

**New help_ids:**
- `white_label.cname` — "Add this CNAME record to your DNS to activate your custom domain"
- `white_label.email_verify` — "Add this TXT record to your DNS to verify email sender ownership"
- `white_label.attribution` — "The 'Powered by AssessIQ' badge can be removed on Enterprise tier"

**Estimated sessions:** 6–8 (DNS/Cloudflare work adds ops complexity).
**`codex:rescue` gate:** mandatory (auth-adjacent cookie domain handling, DNS).

---

### 6.4 Module 32 — anti-cheat-integrity

**One-liner:** Tab-focus tracking, copy-paste detection, time-anomaly flagging, optional webcam-proctoring hooks — produces an `integrity_score` for enterprise hiring use.

**Folder:** `modules/32-anti-cheat-integrity/`

**Dependencies:** `06-attempt-engine`, `07-ai-grading`, `10-admin-dashboard`, `14-audit-log`, `05-assessment-lifecycle`.

**Pre-coding decisions (D1–D8):**

- **D1 — Events tracked.** Tab blur/focus, clipboard paste (occurrence only, no content), idle periods >60s, answer submission speed anomalies (<10% of median time).
- **D2 — Storage.** `attempt_integrity_events` table: `(attempt_id, event_type, occurred_at, metadata JSONB)`. No audio, no video, no keylogging.
- **D3 — Privacy disclosure.** Disclosed **before invitation acceptance**, not just before attempt start. DPDP consent-before-collection rule. `integrity_disclosure_accepted` boolean on attempt row.
- **D4 — Webcam integration.** Hooks only in Phase 1 (`proctoring_provider` config field calling out to third-party API). Vendor shortlist: ProctorU, Honorlock (US), Mercer Mettl, TestInvite (India). Even if Phase 1 picks one vendor, capture alternatives so it's not one-vendor lock-in.
- **D5 — Integrity score calculation.** Weighted sum: tab_blur_count (−5 per event, max −25), paste_count (−10 per event, max −30), speed_anomaly (−20 each). `integrity_score = 100 - penalties`, floored at 0.
- **D6 — Visibility.** Not shown to candidate. Shown to admin and reviewer.
- **D7 — Activation.** Only when `assessment_cycles.integrity_enabled = true`. Off by default.
- **D8 — Override.** Admin can override flag via same dispute mechanism as grade disputes. Override with reason is audited.

**Out of scope:** Keystroke biometrics, screen recording, AI gaze tracking, biometric data storage.

**New help_ids:**
- `integrity.disclosure` — "This assessment monitors tab switches and paste events. No personal data is captured."
- `integrity.admin_flag` — Admin: "This attempt has integrity flags — review before releasing results"

**Estimated sessions:** 4–5.
**`codex:rescue` gate:** mandatory (privacy / DPDP-adjacent).

---

### 6.5 Module 07-ai-grading OpenRouter runtime swap *(in-place, not new module)*

**Scope:** Add a new runtime file `modules/07-ai-grading/runtimes/openrouter.ts` gated behind `AI_PIPELINE_MODE=openrouter`. Three pipeline modes coexist:
- `claude-code-cli` — Phase 1 (current, untouched by this swap)
- `anthropic-api` — Phase 2 original design (legacy path)
- `openrouter` — Phase 2 refined design (this swap)

**4-tier model matrix:**

| Tier | Use case | Model | OpenRouter slug |
|---|---|---|---|
| 1 — Cheap/bulk | Anchor extraction, MCQ grading, integrity classification | DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` |
| 2 — Primary | Subjective grading, band classification, rubric application | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` |
| 3 — Code-specific | KQL / SQL / DuckDB evaluation (modules 24, 25) | Qwen3 Coder | `qwen/qwen3-coder` |
| 4 — Review/escalation | Dispute resolution, cross-provider verification | Anthropic Sonnet 4.6 | `anthropic/claude-sonnet-4.6` |

**Why this combination beats Anthropic-only:**

1. **Cross-provider review is architecturally stronger.** A reviewer from a different model family has uncorrelated biases with the primary. Old Sonnet-primary + Opus-reviewer was vulnerable to same-vendor blind spots.
2. **Cost profile drops ~70–85%** on the AI line at comparable grading quality. (Sonnet 4.6: ~$3/Mtok input. DeepSeek V4 Pro: ~$0.27/Mtok input.)
3. **Qwen3 Coder's 1M context window is genuinely new capability** — log-analysis questions can include the full log in-prompt rather than excerpts.
4. **No Opus tier needed.** Sonnet 4.6 as the "from-another-family" reviewer is strict enough; Opus was over-spec'd for the dispute volume this product will see.

**Prerequisites before flipping `AI_PIPELINE_MODE=openrouter` in production:**

1. Prompts ported and committed for DeepSeek + Qwen (Anthropic-flavored prompts may underperform without rewriting — budget 1–2 sessions per prompt).
2. Eval harness baselined — **hard gate: ≥95% band-agreement** with current Sonnet primary on the eval corpus, measured per question type. Types that fail the gate stay on Sonnet via per-task routing (`ModelRouter.route(task)`); partial routing instead of forced full swap.
3. Per-tenant rollout column `tenant_settings.ai_pipeline_mode` — same pattern as `ai_generate_mode` from the 2026-05-10 Stage 3.0 decision. Never global env-var flip. Pilot tenant first with 24h watch cron.
4. **Shadow-mode period — required only after first paying tenant.** Pre-launch (current state: prod holds seed data only), shadow shadows nothing — eval-harness parity is sufficient. Once paying tenants are live, run a 2-week window with DeepSeek as live grader AND Sonnet as shadow no-op grader on every job; auto-rollback if >5% band divergence.
5. **Cross-provider review disagreement rate** as continuous quality signal. <15% in healthy steady state; sustained >15% on any tenant triggers super_admin review + per-tenant rollback option.
6. Cost dashboard wired (folded ai-cost-optimizer concerns observable, not asserted).
7. `OPENROUTER_API_KEY` env scoped to AssessIQ; rate-limit guard in runtime; secondary key configured for failover.

**Decision log entry to add to `PROJECT_BRAIN.md` when this swap ships:**

```markdown
| 2026-MM-DD | **Phase 2 multi-provider routing locked: DeepSeek V4 Flash (anchors) + DeepSeek V4 Pro (primary) + Qwen3 Coder (code-specific) + Sonnet 4.6 (review).** Cross-provider review replaces Opus escalation. New runtime `modules/07-ai-grading/runtimes/openrouter.ts` gated behind `AI_PIPELINE_MODE=openrouter`. Three pipeline modes: `claude-code-cli` (Phase 1), `anthropic-api` (legacy Phase 2), `openrouter` (current Phase 2). Phase 1 runtime unchanged. | Cost optimization (~70–85% reduction at comparable quality) + uncorrelated-bias review. Eval re-baselining required before flipping any tenant. |
```

**Estimated sessions:** 3–5 for the runtime swap (excluding prompt port + eval re-baseline, which are per-prompt).
**`codex:rescue` gate:** mandatory (load-bearing classifier; multi-provider routing introduces new failure modes).

---

## 7. Tier B briefs (PR-scope — no separate SKILL.md)

For each: decisions captured in the PR commit body + same-PR docs update. Brief candidate descriptions only — full decisions are made at build time, not pre-spec'd here.

- **`21-billing-extensions`** — Stripe Connect for marketplace payments, usage metering (assessments-taken counter for tiered pricing), Indian GST + EU VAT handling. **Hard dependency for `30-public-marketplace` paid launch.** Dependencies: `19-billing`, `02-tenancy`. ~5–7 sessions.
- **`22-search-discovery`** — Postgres FTS for question bank (≤500 questions); promote to Meilisearch / Typesense when scale exceeds. Indexes: questions, scenarios, marketplace listings. Dependencies: `04-question-bank`. ~3–5 sessions.
- **`23-live-simulation-engine`** — Real-time alert / ticket / SIEM event stream replayed during a timed attempt. Scenario script JSON array of `{ t, type, payload }` events; client-driven replay; event log captured to `sim_event_log` JSONB on `attempt_responses`. Consider `requestAnimationFrame` + Web Worker timing reference for drift mitigation on long sims. Dependencies: `04`, `05`, `06`, `08`, `11`, `13`. ~6–8 sessions.
- **`24-kql-playground`** — Monaco editor + KQL grammar via `kusto-language-service` + mock dataset injection via question metadata. Drop the "real-time AI interpretation" option from the original D3 — grading is admin-sync anyway, so AI runs fine when triggered. Dependencies: `04`, `06`, `08`, `11`, `17`. ~4–6 sessions.
- **`25-duckdb-investigation-sandbox`** — DuckDB WASM with synthetic Parquet datasets via signed URLs; structured-finding form for answer capture; shares Monaco editor with `24-kql-playground`. Dependencies: `04`, `06`, `08`, `11`, `24`. ~5–7 sessions.
- **`26-ai-question-generator-bridge`** — HTTP webhook + HMAC + translator from the external AI Question Generator portal. Consider Unix domain socket as transport (both apps on same VPS). Deduplication via `question_import_hashes`. **Promote to Tier A if question pipeline becomes the binding constraint for pack expansion.** Dependencies: `04`, `02`, `14`, `13`. ~4–5 sessions.
- **`27-attack-scenario-authoring`** — MITRE ATT&CK technique tagging, kill-chain stage sequencing, scenario-to-pack linkage. Snapshot STIX bundle at commit time (`prompts/mitre-attack-snapshot.json`) rather than runtime fetch. Dependencies: `04`, `10`, `17`. ~4–5 sessions.
- **`28-team-assessment-mode`** — L1→L2→L3 escalation, asynchronous handoff (24h default `tier_timeout_hours`), chain-coherence rubric dimension. Read-only upward visibility (L2 sees L1, L3 sees L1+L2, never downward). Dependencies: `05`, `06`, `07`, `09`, `11`, `13`. ~6–8 sessions.
- **`29-cohort-benchmarking`** — Percentile ranking from `attempt_scores`, opt-in inter-tenant benchmarks (`tenant_settings.benchmark_opt_in`, default off), minimum 10-candidate cohort floor, nightly materialized-view refresh. Dependencies: `09`, `10`, `11`, `15`. ~3–4 sessions.

---

## 8. Tier C folds (no new module — extend the parent in its next session)

Captured here so they aren't forgotten:

- **tool-emulation-skin → `17-ui-system` Phase 2** — CSS theme variants via `data-skin="sentinel"` attribute on attempt root. No service layer, no schema, no auth. Skin CSS lazy-loaded. Trademark/IP risk note in 17's SKILL.md: functional similarity, not asset copy.
- **question-versioning → `04-question-bank` Phase 2** — Event-sourced `question_pack_versions` table; JSON Patch (RFC 6902) diff format; version pinning via `assessment_cycles.pinned_pack_version` FK; rollback creates new version (never mutates history).
- **manager-review-panel → `10-admin-dashboard` sub-route** — `requireRole('reviewer')` middleware. Features: `reviewer_note` free text, structured flag (`shortlist | hold | reject`), `grade_dispute` row creation. `reviewer` role already exists in `03-users`.
- **certification-engine-v2 → `18-certification` Phase 2** — LinkedIn "Add to Profile" OAuth (`w_member_social` scope), employer/recruiter portal at `/recruiter`, fraud heuristics (`verification_count` + `verification_ips[]` anomaly detection). Already on `18-certification`'s deferred roadmap per the 2026-05-11 PROJECT_BRAIN entry.
- **ai-cost-optimizer → `07-ai-grading`** — Covered by the Tier A in-place OpenRouter swap above (§6.5).
- **observability-stack → `00-core` + per-module instrumentation** — Before scaffolding: **enumerate existing OTel collectors on shared VPS per `CLAUDE.md` rule #8**. Export to existing infra if present; do not stand up parallel Prometheus/Jaeger stack unprompted. OTel SDK init in `00-core/telemetry.ts`; span-decorator pattern for per-module instrumentation; `tenant_id` label on custom metrics; zero PII in span attributes (`candidate_id` allowed; `email`, `name`, `answer_text` never).

---

## 9. Build order (binding-constraint priority)

| Order | Module | Tier | When | Binding constraint |
|---|---|---|---|---|
| 0 | grading-completion fix | (existing) | NOW | Already in flight; finishes before this plan starts |
| 1 | `20-data-rights` | A | Next | DPDP exposure grows per candidate row; overdue for shipped product |
| 2 | `32-anti-cheat-integrity` | A | When enterprise sales conversation surfaces | Enterprise hiring gate |
| 3 | `07-ai-grading` OpenRouter swap | A (in-place) | When AI OpEx becomes the cost driver OR Anthropic availability degrades | Cost / vendor-risk |
| 4 | `26-ai-question-generator-bridge` | B (→A) | When manual question authoring blocks pack expansion | Question pipeline throughput |
| 5 | `21-billing-extensions` | B | Before any marketplace paid-tier launch | Money-flow prerequisite |
| 6 | `30-public-marketplace` | A | When first external publisher signs up | Cross-tenant pack distribution |
| 7 | `22-search-discovery` | B | When Q-bank exceeds ~500 questions OR marketplace launches | Discoverability cliff |
| 8 | `31-white-label-config` | A | When first enterprise reseller deal closes | Enterprise / reseller revenue |
| 9–13 | Tier B remaining (23, 24, 25, 27, 28, 29) | B | As demo / customer demand surfaces | Product demand |
| Anytime | Tier C folds | C | Inside the parent module's next session | None — incremental work |

**Do not pre-author SKILL.md for any item past row 1.** Write SKILL.md when that module's session starts.

---

## 10. Status of required prerequisites

All prerequisite actions executed 2026-05-28:

| # | Action | Status |
|---|---|---|
| 1 | Renumber modules (collisions with shipped 18/19) | ✅ Done — see §5 |
| 2 | Resolve M32 runtime invariant violation | ✅ Done — folded into `07-ai-grading` as in-place OpenRouter runtime mode (§6.5). CLAUDE.md hard rule #2 honored. |
| 3 | Resolve M33 shared-VPS violation | ✅ Done — folded into `00-core` + per-module; enumeration prerequisite captured in §8. |
| 4 | Add three missing modules (data-rights, billing-extensions, search-discovery) | ✅ Done — §6.1, §7 |
| 5 | Fold six enhancement modules | ✅ Done — §8 |
| 6 | Update PROJECT_BRAIN.md module map (incrementally — not pre-listed) | ✅ Acknowledged as incremental — see §11 working agreement |
| 7 | Remove `{docs,modules,infra}/` shadow directory | ✅ Done — `rmdir` executed 2026-05-28; verified absent |

The plan is ready to execute.

---

## 11. Working agreements

All existing `PROJECT_BRAIN.md` working agreements apply. Additional rules specific to this plan:

1. **No batch SKILL.md authoring.** Each Tier A module's SKILL.md is written at the start of that module's first build session — not in a planning sprint.
2. **`PROJECT_BRAIN.md` module map updated incrementally.** Each module's entry is added in the same commit that scaffolds the module. Do not pre-list modules 20–32 in the map.
3. **Tier A modules require `codex:rescue` adversarial review before push.** Per `CLAUDE.md` rules for security/compliance/load-bearing code.
4. **Tier B modules ship via standard PR workflow.** Decisions captured in commit body + same-PR docs. No separate SKILL.md file.
5. **Tier C work folds into parent modules.** No new folders. Update the parent's SKILL.md in the same PR.
6. **Schema changes update `docs/02-data-model.md` in the same PR.** API changes update `docs/03-api-contract.md` in the same PR. New `help_id` values require a seed entry in the help content migration in the same session.
7. **New modules are additive — must not require changes to modules 00–18** other than adding `help_id` seeds and migration columns. If a core-module change is required, flag as a breaking dependency and review first.

---

## 12. What is deliberately NOT in this plan

- A discovery / pre-spec sprint. The first session is `20-data-rights` build, not "plan the next 10 modules in detail."
- Pre-written SKILL.md files for any module beyond row 1 in §9. Premature specs go stale.
- Module entries in `PROJECT_BRAIN.md` for unbuilt modules. The map mirrors reality.
- Full per-decision specs for Tier B (`21`–`29` except `20`). Decisions are made at build time, captured in the PR commit body.
- Speculative roadmap features beyond the 13 modules listed here. The original v1 plan's "future Phase 2" items not folded into existing modules are out of scope for this plan and would belong in a separate strategic doc if revisited.

---

## 13. Glossary / pointers

- **Tier A:** Full SKILL.md, decisions pinned before code, `codex:rescue` gate.
- **Tier B:** PR-scope spec in commit body, no separate SKILL.md, decisions at build time.
- **Tier C:** Fold into existing parent module's Phase 2 entry.
- **Binding constraint:** The reason a module must be built next — e.g., "DPDP exposure grows per candidate row" for `20-data-rights`, "enterprise hiring gate" for `32-anti-cheat-integrity`.
- **Per-tenant rollout column:** Pattern established by 2026-05-10 Stage 3.0 decision — risky changes ship behind a `tenant_settings.<feature>_mode` column, never via a global env-var flip.
- **Shadow mode:** Dual-running primary and reference for accuracy comparison. Only meaningful with live production volume; pre-launch eval-harness parity is the substitute.

**Sources referenced:**
- `PROJECT_BRAIN.md` (root) — decision log, module map, tech stack
- `CLAUDE.md` (root) — project-overlay rules and load-bearing path lists
- `docs/05-ai-pipeline.md` — AI grading runtime modes
- `docs/06-deployment.md` — shared VPS conventions
- `docs/design/grading-completion-fix-plan.md` — in-flight work that precedes this plan
- `docs/design/global-competitiveness-roadmap.md` — independent strategic doc
