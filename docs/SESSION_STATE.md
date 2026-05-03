# Session — 2026-05-03 (Phase 3 Operate Kickoff Plan)

**Headline:** Pure-docs session — `docs/plans/PHASE_3_KICKOFF.md` authored end-to-end mirroring the Phase 2 plan format. Three Haiku discovery agents fed a 22-decision orchestrator-default synthesis covering modules 13-notifications, 14-audit-log, 15-analytics. Cross-PR coordination notes for the in-flight Phase 2 G2.A 1.b window pinned. PROJECT_BRAIN.md decision log gained a Phase 3 dependency-order entry.
**Commits:** `9ee5347 — docs(plans): phase 3 kickoff plan` (3 files, +640/−241 — `docs/plans/PHASE_3_KICKOFF.md` new 572 lines, `docs/SESSION_STATE.md` overwrite, `PROJECT_BRAIN.md` § Decision log +1 line). On `origin/main`.
**Tests:** skipped (pure docs).
**Next:** Conditional fork — (A) if Phase 2 G2.A Session 1.b lands first (window α — real `claude-code-vps` runtime body): open Phase 2 G2.B Sessions 2 + 3 (`08-rubric-engine` + `09-scoring`) in parallel per the existing Phase 2 plan, then G3.C blocks on G2.B Session 3 merge. (B) if G2.A 1.b stalls: open Phase 3 G3.A (`14-audit-log` — load-bearing, codex:rescue mandatory) and G3.B (`13-notifications` real SMTP) in parallel — both are Phase 2-AI-runtime-independent. The user may want to overrule P3.D9 (SMTP=AWS SES default; Sendgrid swap is mechanical) before either G3.A or G3.B opens — non-blocking but cleaner if decided up-front.
**Open questions:** see § Carry-forwards.

---

## What shipped (this commit)

`docs/plans/PHASE_3_KICKOFF.md` — full kickoff plan, ~530 lines, structured to mirror `docs/plans/PHASE_2_KICKOFF.md` exactly:

| Section | Content |
|---|---|
| Header | Phase scope (13/14/15), Outcome (audit-log live, real SMTP + webhooks + in-app, reports/exports/MV), Window (Week 9–10) |
| Discovery summary | Repo state at Phase 3 start (G2.A 1.a shipped, 1.b in flight, G2.B/G2.C unshipped, Phase 3 modules scaffold-only with one exception — 13's email-stub from Phase 0 G0.C-5); Module contracts extracted with line cites; Allowed APIs (audit() helper, GRANT enforcement, webhook signature, BullMQ pattern, redaction, MV refresh); Anti-patterns (no UPDATE/DELETE on audit_log, no silent .catch on audit, no PDF export, no public leaderboard, no claude imports, etc.) |
| Decisions captured | D1–D8 verbatim restatements (still load-bearing) + 14 new orchestrator-defaults P3.D9–P3.D22. Only soft-escalate is P3.D9 (SMTP provider) |
| User-blocking questions | None hard-block; one soft-escalate (P3.D9) |
| Session plan | G3.A → ‖ G3.B (parallel) → G3.C → G3.D (week 10, non-blocking sweep). Each session block has What-to-implement / Documentation references / Verification checklist / Anti-pattern guards / DoD per CLAUDE.md rule #9 |
| Final phase verification | 16 drills (manual smoke, append-only enforcement, cross-tenant isolation, webhook signature/retry/4xx-permanent, audit-fanout, capability gate, archive, MV refresh, cost telemetry, in-app polling, email send, VPS additive audit, doc drift sweep, codex:rescue final pass) |
| Routing summary | Skill-routing matrix per session including codex:rescue mandatory/recommended/skip judgments |
| Appendix A | Full immutable action catalog (35 dot-namespaced actions) — public contract for SIEM integrations |
| Appendix B | G3.A migration order operational recipe (8 numbered steps from S3 bucket provision through smoke verification) |
| Status | Plan v1.0, dependencies, next action |

`PROJECT_BRAIN.md` § Decision log — new row appended (after the 2026-05-02 Phase 2 entry):

> "Phase 3 module dependency order: G3.A (14-audit-log — load-bearing per CLAUDE.md, codex:rescue mandatory; helper API + table + GRANT enforcement + S3 archive + 9 critical wired sites) ‖ G3.B (13-notifications — real SMTP swap-in for Phase 0 stub, webhook delivery, in-app short-poll, audit-fanout) → G3.C (15-analytics — depends on Phase 2 G2.B 09-scoring `attempt_scores` + 14's `audit_log`; ships `attempt_summary_mv` eagerly, reports/exports/cost-empty-shape) → G3.D (week 10, non-blocking — cross-module audit-write sweep across remaining 26 catalog entries via parallel Sonnet dispatch). 22 decisions captured: D1–D8 verbatim restatements still load-bearing; P3.D9–P3.D22 new orchestrator-defaults. P3.D9 (SMTP=AWS SES) is the only soft-escalate; user may swap to Sendgrid mechanically."

## Discovery agent findings (consolidated highlights)

**Cluster A — `13-notifications`:** Phase 0 stub (`email-stub.ts`) interface preserved across `sendInvitationEmail` + `sendAssessmentInvitationEmail`; 4 existing callers across 03-users + 05-assessment-lifecycle. Webhook signature contract pinned host-facing in `docs/03-api-contract.md:319-322`; retry schedule literal `[1m, 5m, 30m, 2h, 12h]` per `docs/03-api-contract.md:324`. SMTP_URL env var declared but provider unselected (P3.D9 default = AWS SES). `email_log` listed in module map but schema missing from data-model.md → Phase 3 G3.B migration `0055_email_log.sql` adds it. `tenants.smtp_config` JSONB column exists from Phase 1 G1.B-3 but always-NULL today.

**Cluster B — `14-audit-log`:** Module is **load-bearing** per CLAUDE.md (verified — line 30). Schema exists in `docs/02-data-model.md:618-634` (BIGSERIAL PK, tenant_id NOT NULL, actor_kind enum, before/after JSONB, ip+ua); zero call sites today. Append-only enforcement ships in same migration as CREATE TABLE (P3.D10 → REVOKE UPDATE/DELETE/TRUNCATE). `tenant_settings.audit_retention_years` is a NEW column, also Phase 3 migration. Daily archive job to S3 cold storage (P3.D11 — single bucket `s3://assessiq-audit-archive`, tenant-prefixed, lifecycle to Glacier at 90d). Action catalog (35 actions) is permanent once shipped — public contract for SIEM. Cross-module wiring split: G3.A wires 9 critical sites; G3.D follow-up wires the remaining 26.

**Cluster C — `15-analytics`:** Read-only contract; owns ZERO writable tables. Phase 3 ships ONE materialized view (`attempt_summary_mv` per P3.D18) eagerly — 50K-attempt threshold becomes a deploy-time non-event. Cross-module overlap with 09-scoring resolved (P3.D15): 09 owns the per-attempt + per-cohort math primitives; 15 wraps them into report shells + adds topic heatmap + cost telemetry + exports + dashboard tiles. Public-facing leaderboard stays Phase 4-deferred per restated DPDP frame (P3.D13). Cost telemetry (`gradingCostByMonth`) returns honest empties in `claude-code-vps` mode and lights up automatically when `anthropic-api` ships (P3.D21). TimescaleDB hypertable migration deferred to Phase 4 with 50K-attempt-sustained-30-days trigger (P3.D22).

## Decision posture

22 decisions in the plan:

- **D1–D8** — verbatim restatements of `docs/05-ai-pipeline.md` § Decisions captured. Still load-bearing for every Phase 3 file even though Phase 3 is a non-AI lane (D2 lint applies, D8 compliance frame anchors P3.D11's `grading.override` audit invariant).
- **P3.D9** — SMTP provider = AWS SES (default). **Soft escalate.** Sendgrid alternative; swap is mechanical.
- **P3.D10** — Append-only enforcement in same migration as CREATE TABLE.
- **P3.D11** — Cold-storage S3 strategy: single bucket `s3://assessiq-audit-archive`, tenant-prefixed, lifecycle to Glacier at 90d.
- **P3.D12** — Webhook retry = literal `[1m, 5m, 30m, 2h, 12h]` (NOT BullMQ exponential — preserves host-facing contract).
- **P3.D13** — In-app delivery = short-poll 60s. WebSocket/SSE deferred. Public leaderboard restated Phase 4-deferred.
- **P3.D14** — All 7 email templates ship in Phase 3 G3.B; legacy stub interface preserved via shims.
- **P3.D15** — `queueSummary` + `homeKpis` are service-layer (called by 07/10 handlers); 15 owns no duplicate routes for them.
- **P3.D16** — SIEM forwarding via webhook fan-out is in-scope; subscribing to `audit.*` requires fresh-MFA + attestation (capability gate).
- **P3.D17** — Audit exports = CSV (default) + JSONL. PDF Phase 4-deferred.
- **P3.D18** — `attempt_summary_mv` ships eagerly (G3.C migration); CONCURRENTLY refresh nightly at 02:00 UTC.
- **P3.D19** — Analytics exports = CSV + JSONL. PDF Phase 4-deferred. Per-endpoint shape pinned.
- **P3.D20** — Audit-write sweep split: G3.A wires 9 critical sites; G3.D (week 10, non-blocking) wires remaining 26.
- **P3.D21** — `gradingCostByMonth` returns `[]` in claude-code-vps mode with explanatory message; lights up in anthropic-api mode automatically.
- **P3.D22** — TimescaleDB hypertable Phase 4-deferred; trigger = 50K attempts sustained over 30 days.

## Cross-PR coordination notes

The plan codifies parallel-window coordination for two cases:

1. **G3.A ‖ G2.A 1.b (window α):** the `grading.override` audit() call lands in `modules/07-ai-grading/src/handlers/admin-override.ts`. If G2.A 1.b has merged when G3.A opens, G3.A patches admin-override.ts. If 1.b hasn't merged, G2.A 1.b's DoD absorbs the audit wiring instead. G3.A's session block calls this out explicitly.
2. **G3.A ‖ G3.B:** the `webhook.created` and `webhook.deleted` audit() calls land in 13-notifications' webhook CRUD handlers (which don't exist until G3.B ships them). G3.A ships the calls as inline patches that G3.B's PR absorbs after rebase.

## Out of this session's scope (explicit)

- Any code (plan-only authoring).
- Touching `modules/13-notifications/`, `modules/14-audit-log/`, `modules/15-analytics/` implementation.
- `modules/07-ai-grading/` (window α territory; G2.A 1.b in flight).
- `modules/04-question-bank`, `05-assessment-lifecycle`, `06-attempt-engine`, `11-candidate-ui`, `16-help-system`, `00-core`, `01-auth`, `02-tenancy`, `03-users`, `17-ui-system` — all already shipped through Phase 1; the plan cites their contracts but does not modify them.
- `docs/05-ai-pipeline.md` — window α may touch; this session does not.
- VPS / deploy operations — pure docs, no shared infra contact per CLAUDE.md rule #8.

## Adversarial review

Skipped per the user's brief — pure planning doc; no code, no migrations, no security-adjacent surface, no load-bearing path edits. CLAUDE.md "scale rigor to change magnitude" applies. The plan itself prescribes `codex:rescue` mandatory for G3.A Session 1 and judgment-call for G3.B/G3.C/G3.D when those sessions execute.

## Carry-forwards / open items

| Item | Owner | Notes |
|---|---|---|
| User decision on P3.D9 SMTP provider (AWS SES default vs Sendgrid alternative) | next session opener | Non-blocking but cleaner if decided up-front; swap is mechanical (different driver import + different `tenants.smtp_config.provider` enum default). |
| AWS account access for S3 audit-archive bucket provisioning | user | P3.D11 mandates single bucket `s3://assessiq-audit-archive` (region likely `ap-south-1` for India residency per `docs/01-architecture-overview.md:158`). One-time `tools/provision-audit-archive-bucket.sh` runs during G3.A deploy; the user must have AWS CLI access + IAM perms. |
| Phase 2 G2.A Session 1.b (window α) | parallel session | Real `claude-code-vps` runtime body — spawn `claude -p`, parse stream-json, extract tool-use, compute skillSha, score math. 3 open design questions per the prior handoff (stream-json tool-name namespacing, skill-frontmatter parsing strategy, Stage 3 escalation trigger alignment). codex:rescue mandatory before push. **Independent of Phase 3 — Phase 3 modules are non-AI lanes.** |
| Phase 2 G2.B Session 3 (`09-scoring`) | sequential | Blocks Phase 3 G3.C — `attempt_summary_mv` joins `attempt_scores`. If G2.B Session 3 stalls, G3.C waits. G3.A + G3.B can ship in parallel without 09-scoring. |
| Production E2E candidate-flow drill | future session | Carried from prior handoff (2026-05-03 G2.A 1.a session-state). Manual browser/email steps. Not implementation. |
| nginx webmanifest MIME redeploy | next frontend session | Carried from prior handoff. `07ab6f2` updated nginx.conf but rebuild + container recreate has not happened. Browsers tolerate via content sniffing; correctness gap. |
| `gradings.tenant_id` ON DELETE behavior | Phase 2 design | Carried; NO ACTION currently (default). Decide explicitly before tenant-deletion UX. |
| OG card domain placeholder + copy + stacked subtagline | next branding/marketing pass | Carried from brand-kit handoff. |
| Modal primitive in `@assessiq/ui-system`, Monaco KqlEditor, AttemptTimer `onDriftCheck`, autosave revision-inflation | Phase 2 UI | Carried from prior take-route handoff. |
| `modules/03-users/migrations/020_users.sql` numbering convention drift | future cleanup | Carried; rename to `0020_users.sql` next time module 03 sees a migration. |

---

## Agent utilization

- **Opus 4.7 (1M)**: orchestration, Phase 0 warm-start parallel reads (PROJECT_BRAIN + 01-architecture-overview + SESSION_STATE + RCA_LOG + Phase 0/1/2 kickoff plans + the three Phase 3 module SKILL.md + 02-data-model + 03-api-contract + 11-observability + email-stub.ts), goal + plan statement, Haiku dispatch prompts authoring, synthesis pass after agents returned (DAG + 22-decision table + four session blocks G3.A/G3.B/G3.C/G3.D + final-phase verification + routing summary + two appendices), final ~530-line plan write, PROJECT_BRAIN.md decision log append, SESSION_STATE handoff overwrite, this footer.
- **Sonnet**: n/a — this session was plan-authoring, not implementation. Sonnet is for mechanical writes against a specified contract; the plan itself IS the contract specification, owned by Opus.
- **Haiku**: 3 parallel Explore agents — Cluster A (`13-notifications` discovery — public surface + tables + webhook contract + observability + tenancy + 10 GAPs), Cluster B (`14-audit-log` discovery — public surface + load-bearing schema + append-only invariants + action catalog + cross-module write sites + retention + admin viewer + observability boundary + 10 GAPs), Cluster C (`15-analytics` discovery — public surface + read tables + cross-module overlap with 09 + endpoints + DPDP frame + performance + cost telemetry + exports + 22 GAPs). All three reported in parallel; total ~3500 words of citation-rich source material consolidated into the plan's Discovery summary section without paraphrasing.
- **codex:rescue**: n/a — judgment-skip per CLAUDE.md "scale rigor to change magnitude" rule. Pure planning doc, no security/auth/classifier surface, no load-bearing-path code edits. The plan itself prescribes mandatory codex:rescue for G3.A Session 1 (load-bearing 14-audit-log) and judgment-call for G3.B (recommended on SMTP credential + webhook signature flows).
