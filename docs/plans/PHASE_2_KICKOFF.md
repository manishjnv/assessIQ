# Phase 2 — Grade & Report Kickoff Plan

> **Generated:** 2026-05-02 by Opus 4.7 after parallel doc-discovery sweeps (3 Haiku Explore agents, one per module cluster).
> **Phase scope:** Modules `07-ai-grading`, `08-rubric-engine`, `09-scoring`, `10-admin-dashboard`.
> **Outcome:** AI grading live. Admin clicks "Grade" on a Phase 1 `pending_admin_grading` attempt; Phase 1 runtime spawns Claude Code on the VPS, returns a structured proposal (anchors + band + justification + score); admin reviews, accepts/overrides/re-runs; `gradings` row commits; `09-scoring` aggregates per-question grades into `attempt_scores` with archetype label + behavioral signals; `10-admin-dashboard` ships the queue + proposal-review + override + cohort/results UI surfaces. Phase 2 grading-on-API-key (`anthropic-api` runtime) stays designed-but-deferred per `docs/05-ai-pipeline.md` D1; the same skills, scoring math, and eval harness flip on a single `AI_PIPELINE_MODE` env var when a tenant lands paid grading credits.
> **Window:** Week 6–8 per `PROJECT_BRAIN.md` § Build phases.

This plan is the source of truth for Phase 2 across multiple VS Code sessions. Every session reads this doc as part of its Phase 0 warm-start (`CLAUDE.md` § Phase 0 reading list — Phase 2 sessions inherit the same warm-start, swapping in this file).

---

## Discovery summary (consolidated)

Three Haiku discovery agents reported on 2026-05-02 against `07`, `08+09`, and `10 + cross-cuts`. Consolidated facts below; line citations preserved so future sessions can verify without re-reading the agents' output.

### Repo state at Phase 2 start

- **Phase 0 fully shipped** (G0.A core scaffold + G0.B-2 02-tenancy + G0.B-3 17-ui-system + G0.C-4 01-auth + G0.C-5 03-users + admin login screen).
- **Phase 1 G1.A through G1.C shipped:** `04-question-bank` (G1.A-1 + activate-all side-quest), `16-help-system` + Tooltip primitive (G1.A-2), `05-assessment-lifecycle` + `13-notifications` SMTP (G1.B-3), `06-attempt-engine` + `apps/worker` BullMQ scheduler (G1.C-4a + 4b boundary cron) all on `main`. Latest commits at the time of authoring: `2675e2f` (apps/worker), `05e5505` (handoff), `4c7d28d` (activate-all), `545c74a` (G1.C handoff), `4b86753` (06-attempt-engine ship).
- **Phase 1 G1.D in flight** (`11-candidate-ui` scaffolding — separate parallel session window α). Phase 2 G2.A can open *as soon as G1.D's `submitAttempt` → `/done` placeholder lands or in parallel against the Phase 1 admin endpoints already shipped*; G1.D and G2.A do not share code paths (G1.D is candidate-side `/take/*`; G2 is admin-side `/admin/*` + grading runtime).
- **No Phase 2 module has any code yet.** All four module directories contain a `SKILL.md` only (verified 2026-05-02 via Glob). Implementation is fully greenfield for this phase.
- **AI runtime: zero existing code.** `modules/07-ai-grading/runtimes/`, `handlers/`, `stages/`, `eval/`, `ci/lint-no-ambient-claude.ts` do NOT exist. The lint that gates the load-bearing path lands in **G2.A Session 1's first commit** as a sentinel; subsequent edits to it are `codex:rescue`-gated per `CLAUDE.md` § Load-bearing paths.
- **`AI_PIPELINE_MODE` env var: not yet declared.** `modules/00-core/src/config.ts` does NOT yet validate the enum. G2.A Session 1 adds the Zod rule (D1 in `docs/05-ai-pipeline.md`) before any runtime code lands; the API container picks it up on the same deploy.

### Module contracts (extracted, not invented)

- **`07-ai-grading` — depends on `00-core`, `01-auth`, `02-tenancy`, `04-question-bank`, `06-attempt-engine`, `13-notifications`, `14-audit-log` (deferred Phase 3).** Owns `gradings` (live in `docs/02-data-model.md:509–530` per Cluster A discovery — Phase 2 adds `prompt_version_sha`, `prompt_version_label`, `model` columns NOT NULL), `grading_jobs` (Phase 2 ONLY, `docs/02-data-model.md:493–507`), `prompt_versions` (Phase 2 ONLY, `docs/02-data-model.md:482–491` — designed but `claude-code-vps` mode reads from `~/.claude/skills/`, not this table; the table lights up only when `AI_PIPELINE_MODE=anthropic-api` ships), `tenant_grading_budgets` (Phase 2 ONLY, designed in `docs/05-ai-pipeline.md` D6, `:721–730`). Public surface: `gradeSubjective(input) → SubjectiveGrading`, single static dispatch through `modules/07-ai-grading/index.ts` (per D1) into a runtime — Phase 2 ships only `runtimes/claude-code-vps.ts`. HTTP surface (`docs/03-api-contract.md` § Admin — Grading & review): `POST /admin/attempts/:id/grade` (proposal trigger, Phase 1 runtime), `POST /admin/attempts/:id/accept` (commit grading row — endpoint name confirmed via SKILL.md handler skeleton, formal API contract addition is part of Session 1 DoD), `POST /admin/attempts/:id/release`, `POST /admin/gradings/:id/override` (`requireAuth + requireRole('admin') + freshMfa: true`), `GET /admin/grading-jobs?status=` (Phase 2 placeholder, returns `[]` until `anthropic-api` mode ships), `POST /admin/grading-jobs/:id/retry` (same).
- **`08-rubric-engine` — depends on `00-core`, `04-question-bank`.** Owns no tables; rubric DSL is denormalized as `questions.rubric` JSONB owned by 04 per `docs/02-data-model.md:244` and Phase 1 plan routing summary (`docs/plans/PHASE_1_KICKOFF.md:493`). 08 is a **service-only module** that exposes pure functions: `validateRubric(rubric)`, `sumAnchorScore(anchors, findings)`, `computeReasoningScore(rubric, band)`, `finalScore(rubric, findings, band) → {earned, max}` (per `modules/08-rubric-engine/SKILL.md:43–46`). The Zod `RubricSchema` currently lives in `modules/04-question-bank/src/types.ts` per Phase 1 inline; Session 2 lifts it into `@assessiq/rubric-engine` and re-exports the same type from 04 to preserve consumer imports without churn.
- **`09-scoring` — depends on `00-core`, `02-tenancy`, `04-question-bank`, `06-attempt-engine`, `07-ai-grading`, `08-rubric-engine`.** Owns `attempt_scores` (Phase 2 first migration — schema sketched at `docs/02-data-model.md:531–541`: `attempt_id PK`, `tenant_id`, `total_earned`, `total_max`, `auto_pct`, `pending_review`, `archetype`, `archetype_signals` JSONB, `computed_at`). Catalog of archetype labels (extensible per tenant, but Phase 2 ships eight built-ins): `methodical_diligent`, `confident_correct`, `confident_wrong`, `cautious_uncertain`, `last_minute_rusher`, `even_pacer`, `pattern_matcher`, `deep_reasoner` (per `modules/09-scoring/SKILL.md:32–39`). Public surface: `computeAttemptScore(attemptId) → AttemptScore`, `recomputeOnOverride(attemptId)`, `cohortStats(assessmentId)`, `leaderboard(assessmentId, {topN})`, `deriveArchetype(scoreData, eventData) → {archetype, signals}`. **No AI calls** — archetype computation is deterministic signal aggregation over `attempt_events` rows (the behavioral signals captured in Phase 1 G1.C per Phase 1 plan decision #14: `tab_blur`/`tab_focus`, `copy`/`paste`, `nav_back`, `time_milestone`, `multi_tab_conflict`, `flag`/`unflag`, `answer_save`).
- **`10-admin-dashboard` — depends on every Phase 0/1/2 module that exposes an admin surface (01, 02, 03, 04, 05, 06, 07, 08, 09, 13, 16).** Owns the entire `/admin/*` SPA route tree — 26 pages declared in `modules/10-admin-dashboard/SKILL.md`, of which Phase 2's MUST-SHIP subset is: `/admin` (dashboard home with grading queue + KPIs), `/admin/attempts/:id` (proposal review + override controls), `/admin/grading-jobs` (Phase 2 stub view, "no jobs yet — Phase 1 mode is sync"), `/admin/reports/cohort/:assessmentId` (cohort archetype distribution + percentiles), `/admin/reports/individual/:userId` (individual progression), `/admin/question-bank/questions/:id` (rubric author UI inline with question editor), `/admin/settings/billing` (budget panel — Phase 2 stub, populated when `anthropic-api` mode ships). Phase 0/1 already shipped `/admin/login`, `/admin/mfa`, `/admin/users` (live in `apps/web/src/pages/admin/`). Other pages declared in the SKILL.md are Phase 3+ deferrals captured in this plan's § Routing summary.

### Allowed APIs (cite-only — do not invent)

- **`AI_PIPELINE_MODE` env var** — `modules/00-core/src/config.ts` Zod schema declares `AI_PIPELINE_MODE: z.enum(['claude-code-vps', 'anthropic-api', 'open-weights']).default('claude-code-vps')`. Conditional rule: `ANTHROPIC_API_KEY` MUST be unset when mode is `claude-code-vps` and MUST be present when mode is `anthropic-api`. Defense-in-depth defined in `docs/05-ai-pipeline.md:546–548` (D1) — restate as Phase 2 invariant in Session 1.
- **`runClaudeCodeGrading` proposal shape** — verbatim from `docs/05-ai-pipeline.md:357–405` § "Implementation skeleton — Phase 1": `{ anchor_hits[], reasoning_band, ai_justification, error_class, escalation: BandFinding|null, score_earned, score_max, skill_versions: {anchors, band, escalate}, status: "proposed" }`. The function NEVER writes to the database; the admin's accept click (handler `handleAdminAccept`) flips the proposal into a real `gradings` row.
- **`gradings` row Phase 2 columns** — `docs/02-data-model.md:509–530` (live since Phase 1 with non-AI rows). Phase 2 migration adds: `prompt_version_sha text NOT NULL` (format `anchors:<8-hex>;band:<8-hex>;escalate:<8-hex|->`), `prompt_version_label text NOT NULL`, `model text NOT NULL` (concatenated identifiers `haiku-4-5;sonnet-4-6;opus-4-7`). Per D4 (`docs/05-ai-pipeline.md:636–659`).
- **Audit log shape** — `/var/log/assessiq/grading-audit.jsonl`, one JSONL line per Claude Code grading run, written by the `PostToolUse` hook in `~/.claude/settings.json` on the VPS. Schema verbatim from `docs/05-ai-pipeline.md:154–162`.
- **MCP tool schema** — `submit_anchors` + `submit_band` exposed by `assessiq-mcp` stdio MCP server registered in `~/.claude/.mcp.json`. Both tools' callbacks echo input back as result; backend reads input from `stream-json` event stream. Verbatim from `docs/05-ai-pipeline.md:88–94, 257–273`.
- **Skill SHA helper** — `skillSha(name)` reads `~/.claude/skills/<name>/SKILL.md`, runs `crypto.createHash('sha256').update(content).digest('hex')`, returns first 8 hex chars (full hash to audit log).
- **Single-flight mutex** — `Map<string, Promise<GradingProposal>>` keyed by `attemptId` in `handlers/admin-grade.ts`. Verbatim code from `docs/05-ai-pipeline.md:760–777` (D7).
- **Eval harness directory** — `modules/07-ai-grading/eval/` with `cases/` (50 hand-graded per type, ≥10 adversarial), `runs/<ISO>/`, `baselines/<YYYY-MM-DD>.json`. Failure thresholds per D5 (`docs/05-ai-pipeline.md:695–699`): hard fail if band-agreement < 85% OR Stage-1 anchor F1 < 0.80 OR any adversarial case where Stage 2 returned band 4. Phase 2 CI runs eval automatically only when `AI_PIPELINE_MODE=anthropic-api` is wired (Phase 1 has no Max OAuth in CI; manual harness only).
- **Behavioral signals available to 09** — Phase 1 emits 12 event types per `modules/06-attempt-engine/EVENTS.md` and Phase 1 plan decision #14: `question_view`, `answer_save`, `flag`/`unflag`, `tab_blur`/`tab_focus`, `copy`/`paste`, `nav_back`, `time_milestone`, `multi_tab_conflict`, `event_volume_capped`. Each event has a Zod payload schema in `modules/06-attempt-engine/src/types.ts` (`EVENT_PAYLOAD_SCHEMAS`).

### Anti-patterns to refuse

- Any `claude` / `anthropic` / `@anthropic-ai/claude-agent-sdk` import outside the two D2 allow-list files (`modules/07-ai-grading/handlers/admin-grade.ts` and `modules/07-ai-grading/runtimes/claude-code-vps.ts`). The lint at `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` enforces this in CI; touching the lint requires `codex:rescue` per `CLAUDE.md`.
- Any cron / scheduler / BullMQ-repeating-job / `setInterval` / webhook handler / candidate route that transitively imports the grading runtime (D2 rejection patterns 3, 5, 6). The Phase 1 `apps/worker` is for non-AI work only — boundary cron in 05-lifecycle, sweepStaleTimers in 06-attempt-engine. The lint rejects any background-worker entrypoint that imports `modules/07-ai-grading/runtimes/*` (D2 rejection 7).
- Any `submitAttempt` modification in `modules/06-attempt-engine` that enqueues an AI grading job. Phase 2 keeps `submitAttempt` exactly as Phase 1 left it — `attempts.status='submitted'`, period. The transition to `pending_admin_grading` happens *only* when an admin opens the attempt detail page in module 10's queue UI (the act of opening the page is the admin "claiming" the attempt). Auto-transition on submit is forbidden — that would put grading on the candidate's submit click rather than the admin's review click, breaking the D8 compliance frame.
- Any `if (domain === "soc")` branch in any of the four Phase 2 modules — domain lives in `question_packs.domain` data, scoring math is domain-agnostic.
- Any RLS-bearing table created without the standard or JOIN-RLS template — `tools/lint-rls-policies.ts` will reject. `gradings`, `grading_jobs`, `attempt_scores`, `tenant_grading_budgets` use the standard `tenant_id`-direct template.
- Any `gradings` row written outside `handleAdminAccept` (Phase 1) or `apps/worker/grading-consumer.ts` (Phase 2 only, gated by `AI_PIPELINE_MODE=anthropic-api`). The "every grade requires an admin click before commit" invariant is enforced at the source — only one writer.
- `JWT.verify(token, secret)` without `algorithms: ["HS256"]` anywhere. Phase 0 G0.C-4 invariant; still applies in Phase 2 — module 10's admin UI uses the same session cookie chain, no embed JWT minting in 10.
- TOTP / fresh-MFA gates skipped on `/admin/gradings/:id/override` — override is a destructive admin action that MUST require fresh MFA per `docs/03-api-contract.md` § Admin — Grading & review. The middleware chain is `requireAuth + requireRole('admin') + requireFreshMfa({maxAge: 5min})`.
- Surfacing `attempt_events.payload` JSONB to candidates or in cross-tenant log lines (Phase 1 invariant — still applies; module 09 reads it for archetype but never echoes back to candidate-facing surfaces).
- Storing skill prompts in Postgres in Phase 2 G2 sessions — they live as files at `~/.claude/skills/<name>/SKILL.md` on the VPS. The `prompt_versions` table is reserved for the future `anthropic-api` runtime, not Phase 2's `claude-code-vps` mode.
- Re-grading an existing `gradings` row by UPDATE — D4 mandates re-grade writes a NEW row, never modifies the old one (auditable-AI invariant). Old rows stay tied to their old SHA forever.
- Importing **anything** from `modules/17-ui-system/AccessIQ_UI_Template/` at runtime in module 10's components. The template is reference design; port idioms by hand into typed components (Phase 0 invariant — still applies).
- Adding a Phase 2 admin endpoint without `requireAuth + requireRole('admin')` middleware (rule #4 multi-tenancy guard).
- Computing archetype via an LLM call (no `claude` invocation in `modules/09-scoring/*` — D2 rejection pattern 1; archetype is deterministic signal math).

---

## Decisions captured (2026-05-02)

Eighteen decisions, in two groups: D1–D8 are restatements of `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" — load-bearing for Phase 2 sessions and quoted here as the canonical pin point; P2.D9–P2.D18 are new resolutions surfacing during the discovery sweep, all confirmed at orchestrator-default.

| # | Decision | Source |
| --- | --- | --- |
| **D1** | **`AI_PIPELINE_MODE` allowed values + per-mode behavior.** Zod-validated env var in `modules/00-core/src/config.ts`. Allowed: `claude-code-vps` (default, Phase 1 runtime, admin's Max OAuth at `~/.claude/`), `anthropic-api` (Phase 2 deferred runtime, paid `ANTHROPIC_API_KEY`), `open-weights` (future on-prem). Conditional rule: `ANTHROPIC_API_KEY` MUST be **unset** in `claude-code-vps` mode (defense-in-depth — if the key is on the box, an attacker plant breaks the compliance frame; absence is the invariant). Single static dispatch in `modules/07-ai-grading/index.ts`. Mode read once at process start; changing it is a deploy event, never a runtime toggle. | `docs/05-ai-pipeline.md:535–564` (verbatim source) |
| **D2** | **Definition of "ambient" + the lint contract.** "Ambient" = any code path that can fire a Claude Code invocation without a fresh, just-now admin click. Positive allow-list (only two source files): `modules/07-ai-grading/handlers/admin-grade.ts` and `modules/07-ai-grading/runtimes/claude-code-vps.ts`. Lint at `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` encodes seven rejection patterns: (1) `claude` CLI invocation outside allow-list; (2) Agent SDK imports outside `runtimes/anthropic-api.ts`; (3) cron/scheduler registrations referencing the grading runtime; (4) BullMQ Worker callbacks referencing the runtime (Phase 2 widens for `apps/worker/grading-consumer.ts` only when `AI_PIPELINE_MODE=anthropic-api`, itself `codex:rescue`-gated); (5) webhook handlers; (6) candidate routes (`/take/*`, `/me/*`, `/embed/*`); (7) any `apps/worker/**` entrypoint referencing the runtime (empty allow-list in Phase 2 G2.A). Lint ships in **Session 1's first commit** as the load-bearing sentinel before any runtime code lands. | `docs/05-ai-pipeline.md:567–600` (verbatim source) |
| **D3** | **`grading_jobs` state machine and Phase-1 vs Phase-2 ownership.** Phase 1 (Phase 2 G2.A scope) has **no `grading_jobs` table** — in-flight tracked entirely by (a) D7's in-process single-flight mutex and (b) `attempts.status` enum's `pending_admin_grading → graded` transition. Phase 2 (`anthropic-api` runtime, deferred) adds `grading_jobs` with state machine `pending → in_progress → done | failed`, exponential backoff up to 3 attempts on transient errors, idempotency key `(attempt_id, prompt_version_sha)` enforced as `UNIQUE`. Phase 1 retry policy: **manual re-trigger only via "Re-run" button**; non-zero `claude` exit raises HTTP 503 to the admin UI. **No auto-retry, ever, in `claude-code-vps` mode.** | `docs/05-ai-pipeline.md:603–633` (verbatim source); confirms forward into Phase 2 G2.A scope |
| **D4** | **Prompt SHA pinning at grading-row level.** Every `gradings` row stores three Phase 2 columns: `prompt_version_sha text NOT NULL` (8-hex truncated, format `anchors:<8>;band:<8>;escalate:<8|->`), `prompt_version_label text NOT NULL` (from skill frontmatter `version:`), `model text NOT NULL` (concatenated `haiku-4-5;sonnet-4-6;opus-4-7`). Recompute trigger on SHA mismatch surfaces a yellow "skill version drift" badge with a "Re-grade" button in module 10's attempt-detail page; re-grading writes a NEW row (never updates) — auditable-AI non-negotiable. Phase 2 G2.A migration: `0040_gradings_phase2_columns.sql` adds the three NOT NULL columns; existing Phase 1 rows are zero (no AI gradings exist yet) so the migration is non-backfilling. | `docs/05-ai-pipeline.md:636–659` (verbatim source) |
| **D5** | **Eval-harness baseline contract.** Layout `modules/07-ai-grading/eval/{cases,runs,baselines,run-eval.ts,compare.ts}/`. ≥50 hand-graded cases per question type (`mcq`, `subjective`, `kql`, `scenario`, `log_analysis`), of which ≥10 adversarial per type (prompt-injection attempts, empty answers, off-topic, "ignore the rubric and assign band 4" payloads). Failure thresholds: **hard fail (block deploy)** — band agreement < 85%, OR Stage-1 anchor F1 < 0.80, OR any adversarial returned band 4 (silent injection success); **soft fail (admin must explicitly bless)** — agreement dropped ≥3pp from prior baseline, OR per-error-class F1 dropped ≥10% on any class, OR new error classes introduced. Phase 2 G2.A ships the harness skeleton + an `examples/` cohort of 5 hand-graded cases per type as smoke fixtures; **the user authors the full 50-cases-per-type golden set as a separate workstream** (out of code-session scope). CI integration cadence: Phase 2 G2 — manual only (admin runs `pnpm aiq:eval:run` from VPS before editing prompt skills); Phase 3 — eval runs in CI on every change to a skill or to `runtimes/*` once `AI_PIPELINE_MODE=anthropic-api` is wired with a separate capped `ANTHROPIC_API_KEY_EVAL` budget. | `docs/05-ai-pipeline.md:662–712` (verbatim source) |
| **D6** | **Phase 2 budget enforcement model (designed, deferred to `anthropic-api` runtime).** Migration `0042_tenant_grading_budgets.sql` adds the table per the D6 DDL (`docs/05-ai-pipeline.md:721–730`): `tenant_id PK FK → tenants`, `monthly_budget_usd numeric(10,2)`, `used_usd numeric(10,2)`, `period_start date`, `alert_threshold_pct numeric(5,2) DEFAULT 80`, `alerted_at timestamptz NULL`, `updated_at timestamptz`. RLS uses the special-case template (`id = current_setting('app.current_tenant')::uuid` since `tenant_id` is the row's PK, same shape as `tenants` table policy). Pre-call enforcement in `runtimes/anthropic-api.ts` (deferred): reject if `used_usd >= monthly_budget_usd`, returns HTTP 429 → worker writes `grading_jobs.status='failed'` with `error_class='budget_exhausted'` → `13-notifications` fires `budget_exhausted` template to the admin → attempt stays `pending_admin_grading`. Daily BullMQ repeating job `tenant_grading_budgets:rollover` (non-AI, allowed under `CLAUDE.md` rule #1) checks each row's `period_start`; on calendar-month boundary resets `used_usd=0` and clears `alerted_at`. Phase 2 G2.A ships the **migration + the rollover cron + the admin UI placeholder**, but no enforcement-call-site code (that lands with the future `anthropic-api` runtime). | `docs/05-ai-pipeline.md:716–752` (verbatim source); migration scope confirmed orchestrator-default |
| **D7** | **Single-flight semantics for Phase 2 G2.A admin grading.** In-process `Map<attemptId, Promise<GradingProposal>>` mutex in `modules/07-ai-grading/handlers/admin-grade.ts`. Same-attempt second click → 409 `grading_in_progress: another click on this attempt is already running`. Different-attempt while busy → 409 `grading_in_progress: another grading is running on this API process`. No queueing, no merging, no auto-retry — the 409 is intentional UX. Single-replica safety: Phase 2 keeps `assessiq-api` single-process; Phase 3+ horizontal scaling (if ever needed) would swap to a Redis-backed `SETNX` mutex with TTL. Idempotency: combined with D3's `(attempt_id, prompt_version_sha)` key, a click on an already-graded attempt at the current skill SHAs returns the existing `gradings` row without re-running. | `docs/05-ai-pipeline.md:756–799` (verbatim source) |
| **D8** | **Anthropic ToS compliance frame (canonical statement, load-bearing).** The compliance-frame block at `docs/05-ai-pipeline.md:24–36` is the canonical argument that the entire Phase 2 G2.A architecture rests on. Restated verbatim: > "Anthropic's consumer ToS allows individual subscribers to script their own use of Claude Code — what it forbids is using Max-subscription auth to power a *product* serving other people. The Phase 1 architecture stays inside that line by enforcing: only the admin (a single human) ever triggers Claude Code; only while the admin is actively at the panel; no cron, scheduler, webhook, or candidate-triggered AI call; one concurrent grading task per admin click; admin must visually confirm or override every proposed grade before it is committed; every Claude Code invocation logged against the admin's identity." Future "small refactors" — move grading into a BullMQ worker, add auto-retry on transient failures, let candidates trigger Stage 1 to surface progress — each individually look reasonable but each one breaks a different leg of the frame. Such refactors must propose moving to `AI_PIPELINE_MODE=anthropic-api` first with a paid `ANTHROPIC_API_KEY` and D6 budget enforcement. | `docs/05-ai-pipeline.md:802–829` (verbatim source) |
| **P2.D9** | **`gradings` Phase 1 ↔ Phase 2 column shape resolution (ambiguity surfaced in Cluster A discovery).** The `gradings` table in `docs/02-data-model.md:509–530` lists `prompt_version_sha`, `prompt_version_label`, `model` as top-row columns without explicit Phase 1 vs Phase 2 distinction. Resolved orchestrator-default: **the three D4 columns ship in Phase 2 G2.A migration `modules/07-ai-grading/migrations/0040_gradings_phase2_columns.sql`** with `NOT NULL` constraints. There are zero existing AI-grading rows in `gradings` (Phase 1 admin-flow is grading-free per Phase 1 plan decision #6 + D8 frame), so the migration is non-backfilling — empty rows on day-zero, every new row written by `handleAdminAccept` is required to populate all three. The `gradings` table itself ALREADY exists in production (created by Phase 0/1 work for the abstract row shape, even though no code wrote to it); G2.A's migration is `ALTER TABLE gradings ADD COLUMN ...` only. | Cluster A gap; orchestrator-default per CLAUDE.md rule #5 doc-detail |
| **P2.D10** | **`POST /admin/attempts/:id/accept` + `POST /admin/attempts/:id/grade` formalization in `docs/03-api-contract.md`.** Cluster A surfaced that the accept endpoint exists in the SKILL.md handler skeleton but is not in the formal API contract. Resolved orchestrator-default: **G2.A Session 1's DoD updates `docs/03-api-contract.md` § "Admin — Grading & review"** to show both Phase 1 endpoints' canonical request/response shape: `POST /admin/attempts/:id/grade` returns `200 { proposal: GradingProposal }` (D1 mode-gated — 503 if mode is `anthropic-api` or `open-weights` until those runtimes ship); `POST /admin/attempts/:id/accept` body `{ edits?: { reasoning_band?, ai_justification?, anchor_hits?, score_earned?, error_class? } }` returns `200 { grading: GradingsRow, attempt: { id, status: "graded" } }`. Override surface stays at `POST /admin/gradings/:id/override` per existing line — request body `{ score_earned, reasoning_band?, ai_justification, reason }` (the `reason` is mandatory, persisted in `gradings.override_reason`, and audited). | Cluster A gap; orchestrator-default |
| **P2.D11** | **Archetype JSON schema (gap from Cluster B — `09-scoring/SKILL.md` left `signals` shape undefined).** Resolved orchestrator-default at the `AttemptScore` shape that `09-scoring` returns and `10-admin-dashboard` consumes: `{ attempt_id, total_earned: number, total_max: number, auto_pct: number, pending_review: boolean, archetype: ArchetypeLabel \| null, archetype_signals: { time_per_question_p50_ms: number, time_per_question_iqr_ms: number, edit_count_total: number, flag_count: number, multi_tab_conflict_count: number, tab_blur_count: number, copy_paste_count: number, reasoning_band_avg: number, reasoning_band_distribution: Record<"0"\|"1"\|"2"\|"3"\|"4", number>, error_class_counts: Record<string, number>, auto_submitted: boolean }, computed_at: string (ISO) }`. The `archetype_signals` JSONB lives on `attempt_scores.archetype_signals`. The `ArchetypeLabel` enum is the eight labels in `modules/09-scoring/SKILL.md:32–39`. Tenant-defined custom archetypes are an explicit Phase 3 deferral. The signals shape is the contract module 10 binds to in its archetype radar / score-detail components and is exported as a TypeScript type from `@assessiq/scoring`. | Cluster B gap; orchestrator-default |
| **P2.D12** | **08-rubric-engine module boundary — service-only, no migrations.** Cluster B surfaced an apparent conflict: `docs/02-data-model.md:25` lists 08 as owning `rubrics` and `anchors` tables, but `08-rubric-engine/SKILL.md` says no migrations and no separate tables. Resolved orchestrator-default: **08 ships zero migrations.** The rubric DSL stays denormalized as `questions.rubric` JSONB owned by 04, exactly as Phase 1 ships it. 08 is a **pure-service helper module** (`@assessiq/rubric-engine`) exposing `validateRubric`, `sumAnchorScore`, `computeReasoningScore`, `finalScore` — Session 2's job is to **lift the existing Zod `RubricSchema` from `modules/04-question-bank/src/types.ts` into 08, re-export from 04 for backwards-compat with no consumer churn**, and ship the four scoring helpers. The `docs/02-data-model.md:25` line gets updated in Session 2's DoD to remove the dead `rubrics`/`anchors` table reference. The split lets 09 + 07 import scoring math from a stable module without coupling to 04's full question-bank surface. | Cluster B contradiction; orchestrator-default per CLAUDE.md rule #5 |
| **P2.D13** | **Leaderboard scope.** Cluster B asked whether the leaderboard is tenant-private or cross-tenant (DPDP / data-residency implication). Resolved orchestrator-default: **leaderboard is tenant-private and admin-only in Phase 2.** `09-scoring.leaderboard(assessmentId, {topN})` is RLS-enforced — returns rows only for the current `app.current_tenant`. Module 10 ships the leaderboard view at `/admin/reports/cohort/:assessmentId` § "Top performers" with anonymization toggle (admin can see real names + emails by default; toggle hides them for screen-share contexts). **Public-facing leaderboards** (across-tenant ranking, candidate-visible) are deferred to Phase 3+ analytics module 15 with explicit DPDP review per `docs/01-architecture-overview.md:158` (data-residency note). | Cluster B gap; orchestrator-default |
| **P2.D14** | **Admin help-content authoring UI scope.** Cluster C surfaced ambiguity: `modules/10-admin-dashboard/SKILL.md` declares `/admin/settings/help-content` as a Phase 2 page, but `modules/16-help-system/SKILL.md` says admin authoring is deferred and today only curl/Postman drive `PATCH /api/admin/help/:key`. Resolved orchestrator-default: **module 10 ships a minimal help-content authoring page in Phase 2 (G2.C Session 4)** — a list view of all `help_content` keys (filtered by audience), inline edit of `short_text` + `long_md` (with markdown preview), version-bump on save, no rich-text editor (Markdown textarea + sanitized preview), import/export JSON via the existing `/api/admin/help/{export,import}` endpoints. WYSIWYG is explicitly deferred to Phase 3+. The Phase 1 16-help-system SKILL.md note "admin authoring deferred" is superseded by this resolution; Session 4's DoD updates 16-help-system/SKILL.md accordingly. | Cluster C ambiguity; orchestrator-default |
| **P2.D15** | **Grading queue endpoint shape.** `GET /admin/dashboard/queue` (referenced in `docs/03-api-contract.md` § Admin — Dashboard & reports per Cluster C). Resolved orchestrator-default request/response: `GET /admin/dashboard/queue?status=pending_admin_grading&limit=50&cursor=<opaque>` returns `{ items: AwaitingReviewItem[], cursor: string \| null }` where `AwaitingReviewItem = { attempt_id, assessment_id, candidate_email, candidate_name, submitted_at, level_name, question_count, has_subjective_questions: boolean, has_existing_proposal: boolean, prompt_version_sha_drift: boolean }`. The `prompt_version_sha_drift` flag is computed server-side per D4 (compares stored `gradings.prompt_version_sha` against current `skillSha()`); Phase 2 G2.A reports `false` for every row since no Phase 1 row has the column populated yet (orchestrator-default: render the badge only when the comparison is meaningful — i.e., after the first AI-graded row exists). The queue lists attempts in `pending_admin_grading` status (Phase 1 stayed at `submitted`; Phase 2 G2.A introduces a `submitted → pending_admin_grading` transition triggered by **the admin opening the attempt-detail page in module 10**, *not* by `submitAttempt`). The transition writer is module 10's attempt-detail loader, not module 06; module 07 reads `pending_admin_grading` rows in the queue endpoint. | Cluster C gap; orchestrator-default |
| **P2.D16** | **Stage 3 escalation diff surfaces both verdicts to admin.** The Phase 1 architecture (`docs/05-ai-pipeline.md:329–331`) says: "If Stage 2 and Stage 3 disagree by ≥ 2 bands → flag `gradings.status='review_needed'`, surface raw both verdicts to admin." Resolved orchestrator-default: **the proposal returned by `runClaudeCodeGrading` always carries the Stage 3 verdict when escalation ran**, surfaced as `proposal.escalation: { band, justification, error_class, confidence } \| null` (already in the canonical proposal shape per `docs/05-ai-pipeline.md:357–405`). Module 10's attempt-detail page renders both Stage-2 and Stage-3 verdicts side-by-side as two AnchorChip + BandPicker cards with a "Reconcile" affordance — admin picks one, justifies in a freetext field, the chosen verdict is written to the `gradings` row, and `gradings.escalation_chosen_stage: '2' \| '3' \| 'manual'` records which (Phase 2 G2.A migration adds this column on `gradings`). Phase 1 plan decision Window D's compliance frame (D8) requires the admin's pick to commit; the AI never auto-reconciles. | Cluster C gap; orchestrator-default + `docs/10-branding-guideline.md:270` |
| **P2.D17** | **New help_ids namespace 10 must seed.** Cluster C enumerated ~12 candidate keys; resolved orchestrator-default at the canonical Phase 2 namespace: `admin.grading.queue.row`, `admin.grading.queue.empty`, `admin.grading.proposal.anchors`, `admin.grading.proposal.band`, `admin.grading.proposal.justification`, `admin.grading.proposal.error_class`, `admin.grading.proposal.escalation`, `admin.grading.accept`, `admin.grading.override.reason`, `admin.grading.rerun`, `admin.grading.rerun.opus`, `admin.grading.skill_drift`, `admin.scoring.attempt.total`, `admin.scoring.attempt.archetype`, `admin.scoring.archetype.disclaimer`, `admin.scoring.cohort.percentiles`, `admin.scoring.leaderboard.privacy`, `admin.rubric.anchor.weight`, `admin.rubric.anchor.synonyms`, `admin.rubric.anchor.required`, `admin.rubric.reasoning.bands`, `admin.rubric.error_classes`, `admin.settings.billing.budget`, `admin.settings.billing.alert_threshold`, `admin.settings.help_content.markdown`. 25 new help_ids total. **G2.C Session 4 ships them in `modules/16-help-system/content/en/admin.yml`** with production-quality copy; the admin authoring UI from P2.D14 lets future tenants override per-tenant. The help-id stability rule (Phase 1 plan decision #10) extends — once seeded, these keys are stable forever. | Cluster C gap; orchestrator-default |
| **P2.D18** | **17-ui-system Phase 2 components ship in G2.C Session 4.** Phase 1 left these explicitly Phase 2: `ScoreRing`, `Sparkline`, `QuestionNavigator` (the latter is Phase 1 G1.D candidate territory but was never shipped — defer further). Cluster C added: `Sidebar`, `NavItem`, `StatCard`, `Table`/`DataTable` (filterable + sortable, server-pagination via opaque cursors), `Modal`, `Drawer` (right-side, similar shell to 16-help's HelpDrawer but with `onClose` semantics), `AnchorChip` (domain composite — chip with hit/miss icon + evidence tooltip), `BandPicker` (domain composite — five radio cards 0/1/2/3/4 with band descriptions), `RubricEditor` (domain composite — anchor list + bands editor + weight totaler), `GradingProposalCard` (domain composite — anchors + band + justification + accept/override/rerun footer). Resolved orchestrator-default: **module 17 ships `ScoreRing`, `Sparkline`, `Sidebar`, `NavItem`, `StatCard`, `Table`, `Modal`, `Drawer` as generic primitives (G2.C Session 4 prerequisite, lands as the Session 4 commit's first batch of files); domain composites (`AnchorChip`, `BandPicker`, `RubricEditor`, `GradingProposalCard`) live in `modules/10-admin-dashboard/src/components/` because they bind to grading-specific types and shouldn't pollute the design-system module.** Storybook stories ship for the 17-ui-system primitives. The two non-shipped Phase 1 candidates (`QuestionNavigator`) defer to Phase 3+ along with the rest of `11-candidate-ui` polish. | Cluster C gap; orchestrator-default |

### User-blocking questions

**None.** All eighteen rows above are confirmed at orchestrator-default. The user is not blocked on any of them; should the user disagree with any P2.D9–P2.D18 default, the relevant session can re-open the decision and update the SKILL.md / module migration accordingly. D1–D8 are pinned in `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" by user confirmation on 2026-05-01 and are load-bearing — they do not re-open without an `AI_PIPELINE_MODE=anthropic-api` migration plan attached.

---

## Session plan

Four sessions across three serial groups: **G2.A** (one session, blocking, codex:rescue mandatory), **G2.B** (two parallel sessions), **G2.C** (one session, requires G2.B's contracts). Each session is a separate VS Code window with a fresh Claude conversation.

```
G2.A ──▶ G2.B (parallel) ──▶ G2.C
S1: 07     ├─ S2: 08         S4: 10
           └─ S3: 09
```

### Group G2.A — AI grading runtime + lint sentinel (single session, blocking, codex:rescue mandatory)

#### Session 1 — `07-ai-grading` (LOAD-BEARING — codex:rescue mandatory before push)

##### What to implement

1. **The lint sentinel — first commit, before any runtime code.** `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` lands as the load-bearing sentinel. Encodes D2's seven rejection patterns over `modules/**`, `apps/**`, `tools/**`, `infra/**`. Implementation: a small TypeScript script using `@typescript-eslint/typescript-estree` (or a simpler regex-and-import-graph walker) that exits non-zero on violation. Wire into `.github/workflows/ci.yml` as a required check. From this commit onward, **modifications to this file require `codex:rescue`** per `CLAUDE.md` § Load-bearing paths — the sentinel itself states this in a top-of-file comment.
2. **`AI_PIPELINE_MODE` Zod rule in `modules/00-core/src/config.ts`.** Add the enum + the conditional `ANTHROPIC_API_KEY` rule per D1: `z.enum(['claude-code-vps', 'anthropic-api', 'open-weights']).default('claude-code-vps')`; the schema's superRefine throws when `mode === 'claude-code-vps' && env.ANTHROPIC_API_KEY != null`, and when `mode === 'anthropic-api' && env.ANTHROPIC_API_KEY == null`. Update `.env.example` and `apps/api/src/server.ts` (no-op import — config is a singleton; existing config-import line is enough).
3. **Migration `modules/07-ai-grading/migrations/0040_gradings_phase2_columns.sql`** — `ALTER TABLE gradings ADD COLUMN prompt_version_sha text NOT NULL`, `prompt_version_label text NOT NULL`, `model text NOT NULL`. Per P2.D9, `gradings` already exists from Phase 0/1 with no AI rows, so non-backfilling. Include a migration-internal sanity assertion: `DO $$ BEGIN IF (SELECT COUNT(*) FROM gradings) > 0 THEN RAISE EXCEPTION 'gradings has rows; refusing non-backfilling NOT NULL ADD COLUMN'; END IF; END $$;`.
4. **Migration `modules/07-ai-grading/migrations/0041_gradings_escalation_chosen.sql`** — `ALTER TABLE gradings ADD COLUMN escalation_chosen_stage text` (nullable; values `'2' | '3' | 'manual' | NULL`). Per P2.D16. Same non-backfilling shape.
5. **Migration `modules/07-ai-grading/migrations/0042_tenant_grading_budgets.sql`** — D6 DDL. Standard RLS template (PK = `tenant_id`, special-case policy `id = current_setting('app.current_tenant', true)::uuid` shape since the row's PK *is* the tenant id; same as `tenants` policy). The migration ships even though enforcement is deferred to `anthropic-api` runtime — the rollover cron (D6) ships in this session and reads the table; module 10's billing UI reads the table.
6. **Module skeleton at `modules/07-ai-grading/src/`:**
   - `types.ts` — Zod schemas for `GradingProposal` (verbatim from `docs/05-ai-pipeline.md:357–405`), `AnchorFinding`, `BandFinding`, `GradingsRow` (mirrors the table), `GradingInput` (consumed from 06's frozen-question + answer payload). Exports `AIGradingError` + 16 error codes.
   - `runtime-selector.ts` — single static dispatch per D1: switch on `config.AI_PIPELINE_MODE`, call into `runtimes/claude-code-vps.ts` for the only runtime that exists; throw `NotImplementedError` for the other two enum values.
   - `runtimes/claude-code-vps.ts` — implementation per `docs/05-ai-pipeline.md:350–432` § "Implementation skeleton — Phase 1": `runClaudeCodeGrading(input) → GradingProposal`, `runSkill({skill, promptVars, allowedTools})` spawning `claude -p ...` with the explicit allowed-tools / disallowed-tools / `stream-json` / max-turns / permission-mode flags, parsing the `stream-json` event stream, extracting `submit_anchors` + `submit_band` tool inputs. `skillSha(name)` reads `~/.claude/skills/<name>/SKILL.md` and returns `crypto.createHash('sha256').update(content).digest('hex').slice(0,8)`.
   - `runtimes/anthropic-api.ts` — **stub only.** Throws `NotImplementedError("Phase 3+: anthropic-api runtime is designed but not yet shipped — see docs/05-ai-pipeline.md D1 + D6")`. The file's mere existence reserves the D2 lint allow-list slot for the Agent SDK import; commenting it out would re-trigger the lint when the runtime ships.
   - `runtimes/open-weights.ts` — same stub shape.
   - `handlers/admin-grade.ts` — implementation per `docs/05-ai-pipeline.md:124–143` and D7. Verifies `req.session.admin === true`, `config.AI_PIPELINE_MODE === 'claude-code-vps'`, admin session activity heartbeat (last activity within 60s — the heartbeat is `req.session.lastActivity`, set on every authenticated request by 01-auth's `sessionLoader` middleware), single-flight mutex (in-process `Map<string, Promise<GradingProposal>>` keyed by `attemptId`). Loads attempt + frozen questions + rubric per question via 06's repository (already exists). Calls `runClaudeCodeGrading(input)`. Returns `{ proposal: GradingProposal }` — does NOT write to DB.
   - `handlers/admin-accept.ts` — implementation per `docs/05-ai-pipeline.md:145–149`. Body validation (Zod): `edits?: { reasoning_band?, ai_justification?, anchor_hits?, score_earned?, error_class? }`. Within a single transaction: writes a `gradings` row per attempt+question, transitions `attempts.status` → `'graded'`. Returns `{ grading: GradingsRow, attempt: { id, status } }`. Idempotent on `(attempt_id, question_id, prompt_version_sha)` — re-call with same edits returns existing row.
   - `handlers/admin-override.ts` — `requireAuth + requireRole('admin') + requireFreshMfa({maxAge: 5 * 60 * 1000})`. Body `{ score_earned, reasoning_band?, ai_justification, reason }`. Writes a NEW `gradings` row with `grader='admin_override'`, `override_of=<original gradings.id>`, `override_reason=$reason`. Per D4, never updates the original row.
   - `handlers/admin-rerun.ts` — `POST /admin/attempts/:id/grade?escalate=opus`. Spawns the `grade-escalate` skill instead of `grade-band`. Same single-flight mutex. Returns the new proposal alongside the prior one for module 10 to render side-by-side.
   - `handlers/admin-queue.ts` — `GET /admin/dashboard/queue` per P2.D15. Reads `attempts WHERE status IN ('submitted','pending_admin_grading')` joined to assessments + users + levels. RLS enforces tenant isolation. Computes `prompt_version_sha_drift` per row (always false in Phase 2 G2 — no AI rows yet).
   - `handlers/admin-attempt-claim.ts` — `GET /admin/attempts/:id` (the page-load handler). Side effect on first read: transitions `submitted → pending_admin_grading` for this attempt within an `UPDATE attempts SET status='pending_admin_grading' WHERE id=$1 AND status='submitted'` (idempotent — second call is a no-op). Returns `{ attempt, answers, frozen_questions, gradings }`. Per P2.D15.
   - `handlers/admin-release.ts` — `POST /admin/attempts/:id/release`. Transitions `attempts.status` → `'released'` (terminal). Triggers `13-notifications.sendResultReleasedEmail` to the candidate. RLS-enforced.
   - `handlers/admin-grading-jobs.ts` — `GET /admin/grading-jobs` and `POST /admin/grading-jobs/:id/retry`. Phase 2 G2.A returns `[]` (no jobs in `claude-code-vps` mode); the endpoint exists for forward-compat with the future `anthropic-api` runtime.
   - `handlers/admin-budget.ts` — `GET /admin/settings/billing` reads `tenant_grading_budgets` for the current tenant (per D6). Returns `{ monthly_budget_usd, used_usd, period_start, alert_threshold_pct }`. Phase 2 G2.A returns "0/0/null/80" if no row exists.
   - `routes.ts` — Fastify plugin. Mounts every handler under `/api/admin/*` with `requireAuth + requireRole('admin')`; override + accept add `requireFreshMfa({maxAge: 5min})`.
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers Postgres + a stub `claude` binary on `$PATH` (the tests do not actually spawn real Claude — they stub the spawn output to return canned `stream-json` event sequences). Cases: D1 mode-conditional (mode=`anthropic-api` returns 503 from the `/grade` endpoint), D2 lint passes against the runtime files + fails against a synthetic violation fixture, D3 single-flight mutex (parallel POST /grade for same attempt → second 409, different attempt while busy → 409), D4 SHA columns populated on accept, D6 budget panel returns the right shape, D7 mutex idempotency on already-graded attempt + same SHAs, P2.D10 accept body validation, P2.D15 queue endpoint shape, P2.D16 escalation_chosen_stage written on override.
7. **Eval harness skeleton at `modules/07-ai-grading/eval/` per D5:**
   - `cases/` directory with 5 hand-graded sample cases per question type (smoke fixtures only — full 50-case golden set is the user's authoring workstream).
   - `runs/.gitkeep`
   - `baselines/.gitkeep`
   - `run-eval.ts` — manual entrypoint (`pnpm aiq:eval:run --mode claude-code-vps`). Iterates cases, runs the grading runtime against each, writes per-case `*.actual.json` to `runs/<ISO>/`, writes a `run.json` manifest (timestamp, mode, prompt_version_shas, summary).
   - `compare.ts` — diffs a run against a baseline.
   - `bless.ts` — `pnpm aiq:eval:bless --run <ISO>` copies a run summary into `baselines/<YYYY-MM-DD>.json` with `signed_by` (admin user id) + `signed_at`.
   - **CI integration: deferred** per D5 (no Max OAuth in CI in `claude-code-vps` mode); `tools/eval-no-ci-guard.ts` ensures the eval runner never fires from a CI environment.
8. **MCP server at `~/.claude/.mcp.json` + `assessiq-mcp` stdio binary.** Out-of-repo on the VPS. Session 1's deploy step ships the binary + MCP config to `/srv/assessiq/mcp/` and registers it in the admin's `~/.claude/.mcp.json`. The two tools (`submit_anchors`, `submit_band`) echo input back as result. Source ships at `tools/assessiq-mcp/` in-repo.
9. **Skills on the VPS at `~/.claude/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md`.** Source-of-truth lives in-repo at `prompts/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md` (added by Session 1) so the SHAs are reproducible from a known commit; the deploy procedure copies them to the VPS path. Per `CLAUDE.md` AssessIQ rule #6: "AI prompts are skills on the VPS, not code. Editing prompts is a deploy event with eval-harness re-baselining, not a normal code change." Session 1 ships the initial three skills; future skill edits go through the eval-bless cycle.
10. **PostToolUse audit hook in `~/.claude/settings.json` on the VPS.** Appends a JSONL line to `/var/log/assessiq/grading-audit.jsonl` per `docs/05-ai-pipeline.md:154–162`. Source-of-truth in-repo at `infra/admin-claude-settings.example.json`; deploy procedure copies to the admin's home dir on the VPS.
11. **`apps/api/src/server.ts` wiring.** Imports + calls `registerGradingRoutes` after the assessment-lifecycle registration. New deps in `apps/api/package.json`: `@assessiq/ai-grading: workspace:*`.
12. **`tools/lint-rls-policies.ts`** — extends `TENANT_RLS_TABLES` to include `gradings` (already there from Phase 0/1) and `tenant_grading_budgets`. The standard tenant_id-direct template applies.

##### Documentation references

- `modules/07-ai-grading/SKILL.md` — public surface.
- `docs/05-ai-pipeline.md` — full pipeline doc; **especially D1–D8** (`:529–829`).
- `docs/02-data-model.md:482–541` — `prompt_versions`, `grading_jobs`, `gradings`, `attempt_scores`.
- `docs/03-api-contract.md:116–136` — Admin grading + dashboard endpoints.
- `CLAUDE.md` rules #1, #2, #8.
- `PROJECT_BRAIN.md` — non-negotiable design principles #4 (auditable AI), #5 (AI runs as admin, not as product).
- D-series decisions D1–D8 in this plan's § Decisions captured.

##### Verification checklist

- [ ] `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` exists, exits 0 against the current tree, exits non-zero against synthetic violation fixtures (one per D2 rejection pattern 1–7). CI runs it as a required check.
- [ ] `pnpm -r typecheck` green across all packages including `@assessiq/ai-grading`.
- [ ] `tools/lint-rls-policies.ts` passes — `gradings` (existing standard policy), `tenant_grading_budgets` (PK-special-case policy) both detected and accepted.
- [ ] `pnpm --filter @assessiq/ai-grading test` green — all testcontainer integration cases pass.
- [ ] `config.AI_PIPELINE_MODE` in `claude-code-vps` mode rejects when `ANTHROPIC_API_KEY` is set; in `anthropic-api` mode rejects when unset.
- [ ] Migration `0040` runs on a clean Phase 1 production DB without backfill — `gradings` row count is verified zero before `ALTER TABLE` adds NOT NULL columns.
- [ ] `POST /api/admin/attempts/:id/grade` against a `submitted` or `pending_admin_grading` attempt returns the proposal shape (canned `claude` mock in tests; real spawn in deploy smoke against the user's hand-authored sample cases).
- [ ] `POST /api/admin/attempts/:id/accept` writes a `gradings` row with the three NOT NULL D4 columns populated; transitions `attempts.status` → `'graded'`.
- [ ] `POST /api/admin/gradings/:id/override` requires fresh MFA; rejects with 401 when `freshMfa: false`; writes a NEW row, never updates the original.
- [ ] D7 single-flight: parallel calls to `/grade` for the same `attempt_id` return 409 on the second; for a different `attempt_id` while the first is in flight return 409 with the global "another grading is running" message.
- [ ] D2 lint: a synthetic file at `apps/worker/src/grading-handler.ts` that imports `runClaudeCodeGrading` causes the lint to fail (rejection pattern 7).
- [ ] D2 lint: a synthetic Fastify route at `modules/06-attempt-engine/src/routes.candidate.ts` that imports the runtime causes the lint to fail (rejection pattern 6).
- [ ] D6: `0042_tenant_grading_budgets.sql` applies; the daily rollover BullMQ job (registered in `apps/worker`) appears in `BullMQ.getRepeatableJobs()`.
- [ ] Eval harness: `pnpm aiq:eval:run --mode claude-code-vps` against the 5 sample cases per type produces `runs/<ISO>/` with per-case actuals + manifest.
- [ ] `grep -r "claude\|@anthropic-ai\|anthropic-api" modules/ apps/ tools/ infra/ | grep -v "modules/07-ai-grading/runtimes/anthropic-api.ts" | grep -v "modules/07-ai-grading/handlers/admin-grade.ts" | grep -v "modules/07-ai-grading/runtimes/claude-code-vps.ts" | grep -v "ci/lint-no-ambient-claude.ts" | grep -v "modules/07-ai-grading/ci/lint-no-ambient-claude" | grep -v "package.json" | grep -v "docs/" | grep -v "CLAUDE.md"` returns zero hits — **the only `claude`/`anthropic` references in source live in the four expected files**.
- [ ] codex:rescue verdict logged in handoff (mandatory per `CLAUDE.md` § Load-bearing paths — module 07 is on the list, lint sentinel ships in the same commit).

##### Anti-pattern guards

- **NEVER** spawn `claude` outside `modules/07-ai-grading/runtimes/claude-code-vps.ts`. The lint enforces it; the runtime trick is "if I add a quick helper that spawns claude in a tools/ script, the lint blocks me — that's the design."
- **NEVER** import `@anthropic-ai/claude-agent-sdk` outside `runtimes/anthropic-api.ts`. Currently a stub; the import lives in the stub's `import` statement so the lint allow-list slot is reserved.
- **NEVER** add a BullMQ repeating job, cron, webhook, or candidate route that imports the grading runtime. D2 rejection patterns 3, 5, 6, 7.
- **NEVER** auto-retry `claude` failures. Phase 2 G2 is admin-click-only; D8 frame requires every grading run to be triggered by a fresh admin click.
- **NEVER** UPDATE an existing `gradings` row. Override + re-grade always INSERT a new row with `override_of` linking back. D4 + D8 invariant.
- **NEVER** skip the heartbeat check on `/grade`. The 60-second activity window is the runtime enforcement of D8's "only while admin actively at panel."
- **NEVER** skip the single-flight mutex (D7). Parallel `claude` subprocesses on the same API process violate the compliance frame's "one concurrent grading task per admin click."
- **NEVER** call `PostToolUse` audit hook from in-repo code — it lives on the VPS in `~/.claude/settings.json` and writes against the admin's identity. The in-repo `infra/admin-claude-settings.example.json` is a deploy artifact only.
- **NEVER** log full proposal content at INFO. Anchor evidence quotes may include candidate PII; only log proposal IDs + skill SHAs at INFO.
- **NEVER** skip the migration assertion on `0040` — if `gradings` ever has rows from a future Phase 2.5 backfill, the migration must fail-fast rather than insert empty NOT NULL strings.

##### DoD

1. **Pre-commit:** Phase 2 deterministic gates pass (tests, secrets-scan, RLS linter, TODO/FIXME count, **the new `lint-no-ambient-claude.ts` sentinel**). **Phase 3:** Opus reviews the diff line-by-line — this is the largest single Phase 2 surface and the most security-sensitive. **codex:rescue mandatory** — `modules/07-ai-grading/**` is on the load-bearing-paths list per `CLAUDE.md`, and the lint file is explicitly load-bearing-with-rescue-gate. Log verdict in handoff.
2. Commit `feat(ai-grading): phase-2 claude-code-vps runtime + lint sentinel + admin handlers + eval harness skeleton`. Noreply env-var pattern.
3. Deploy: enumerate VPS first per `CLAUDE.md` rule #8; apply migrations 0040/0041/0042 in order; rebuild + recreate `assessiq-api` with `--no-deps --force-recreate` (per `docker compose restart != recreate` RCA); copy in-repo `prompts/skills/` to `~/.claude/skills/` on the VPS; copy `tools/assessiq-mcp/` to `/srv/assessiq/mcp/` and register in `~/.claude/.mcp.json`; copy `infra/admin-claude-settings.example.json` to `~/.claude/settings.json`; verify `claude --version` runs as the admin user; smoke-test `POST /api/admin/attempts/:id/grade` against a real `submitted` attempt from Phase 1 G1.D's end-to-end test cohort; verify the JSONL audit file lands at `/var/log/assessiq/grading-audit.jsonl` after the smoke test.
4. Document: `docs/02-data-model.md` flips `gradings` Phase 2 columns + `tenant_grading_budgets` to live; `docs/03-api-contract.md` ships P2.D10 + P2.D15 endpoint formalizations alongside the existing § Admin — Grading + Dashboard tables; `docs/05-ai-pipeline.md` flips § "Implementation skeleton — Phase 1" status to "live (G2.A 2026-MM-DD)"; `docs/06-deployment.md` adds § "Pipeline mode" describing the env var + skill-deploy procedure + MCP server registration; `modules/07-ai-grading/SKILL.md` resolves D1–D8 + P2.D9 + P2.D10 + P2.D15 + P2.D16; `prompts/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md` ships in-repo with frontmatter `version:`, `model:`, `temperature: 0.0`. **Append PROJECT_BRAIN.md § Build phases entry: "Phase 2 G2.A — `07-ai-grading` Claude Code VPS runtime live (2026-MM-DD); lint sentinel load-bearing per CLAUDE.md."**
5. Handoff: SESSION_STATE entry. **codex:rescue verdict line in the agent-utilization footer.**

---

### Group G2.B — Rubric helpers + scoring (parallel after G2.A merges)

#### Session 2 — `08-rubric-engine` (lift + helpers — small, judgment-call rescue)

##### What to implement

1. **No migrations.** Per P2.D12, 08 ships zero migrations; rubric DSL stays denormalized in `questions.rubric` JSONB owned by 04.
2. **`modules/08-rubric-engine/src/`:**
   - `types.ts` — **lift** the existing `RubricSchema` Zod from `modules/04-question-bank/src/types.ts` (current location per Phase 1 plan) into `@assessiq/rubric-engine`. Re-export the same name from 04 for backwards-compat (`export type { Rubric, Anchor } from '@assessiq/rubric-engine'; export { RubricSchema, AnchorSchema } from '@assessiq/rubric-engine';`). Zero consumer churn.
   - `validate.ts` — `validateRubric(rubric: unknown): { valid: boolean, errors: string[] }`. Uses `RubricSchema.safeParse(rubric)`; on success returns `{ valid: true, errors: [] }`; on failure returns `{ valid: false, errors: result.error.issues.map(i => i.message) }`.
   - `score.ts` — `sumAnchorScore(anchors: Anchor[], findings: AnchorFinding[]): number` (sum of `weight` for each `findings.find(f => f.anchor_id === a.id)?.hit === true`); `computeReasoningScore(rubric: Rubric, band: number): number` (exact formula `(band / 4) * rubric.reasoning_weight_total` per `docs/05-ai-pipeline.md:339`); `finalScore(rubric, findings, band) → { earned, max }` (sum of the two + `max = anchor_weight_total + reasoning_weight_total`).
   - `index.ts` — public barrel exposing the four functions + the types.
   - `__tests__/rubric-engine.test.ts` — vitest (no testcontainers needed — pure unit tests). Cases: validate happy path + every Zod-rejection path (anchors empty, weights don't sum to 100, missing band descriptions); sumAnchorScore with all hits / no hits / partial; computeReasoningScore for band 0/1/2/3/4 (verify exact formula); finalScore worked example matches `docs/05-ai-pipeline.md:341–345`.
3. **`modules/04-question-bank/src/types.ts`** — re-export `RubricSchema` + types from `@assessiq/rubric-engine`. Existing inlined definitions removed in favor of the re-export. Verify all existing 04 tests still pass.
4. **Consumer wiring:** module 07's `runtimes/claude-code-vps.ts` imports `finalScore` from `@assessiq/rubric-engine` instead of computing inline. Module 09's `service.ts` imports the same helpers. Both diffs are cosmetic (remove inlined math, import the helper) and ship in this session as part of the cross-module sweep.
5. **`apps/api/package.json`** — adds `@assessiq/rubric-engine: workspace:*` (pulled in transitively via 07/09 already, but explicit for clarity).

##### Documentation references

- `modules/08-rubric-engine/SKILL.md` — public surface.
- `docs/02-data-model.md:244–252` — `questions.rubric` JSONB shape.
- `docs/05-ai-pipeline.md:336–349` — score-computation worked example.
- `modules/04-question-bank/src/types.ts` — current `RubricSchema` location.
- P2.D12 in this plan.

##### Verification checklist

- [ ] `pnpm -r typecheck` green across all packages.
- [ ] `pnpm --filter @assessiq/rubric-engine test` green.
- [ ] `pnpm --filter @assessiq/question-bank test` still green (re-export round-trip preserved).
- [ ] `pnpm --filter @assessiq/ai-grading test` still green (07's inline math swap doesn't regress its tests).
- [ ] `import { RubricSchema } from '@assessiq/question-bank'` resolves and is identity-equal to `import { RubricSchema } from '@assessiq/rubric-engine'`.
- [ ] No new tables; `tools/lint-rls-policies.ts` unchanged.
- [ ] No `claude` / `@anthropic-ai/*` / `anthropic-api` imports in `modules/08-rubric-engine/**`.
- [ ] `docs/02-data-model.md:25` updated to remove `rubrics`/`anchors` table reference (P2.D12).

##### Anti-pattern guards

- Don't ship a separate `rubrics` table — `questions.rubric` JSONB is canonical. The data-model reference at `:25` is dead text from an earlier draft.
- Don't import grading runtime from 08 — 08 is pure scoring math, no AI.
- Don't introduce a stateful `RubricEngine` class — the four exports are pure functions. Tests stay deterministic.
- Don't break the re-export in 04 — Phase 1 consumers (route handlers in 04) bind to `@assessiq/question-bank.RubricSchema`. Lift without renaming.

##### DoD

1. Phase 2 gates pass; Phase 3 Opus diff review; **codex:rescue judgment-call** — recommend skip (small surface, no auth/RLS/AI exposure, pure math). 08 is not load-bearing.
2. Commit `feat(rubric-engine): lift RubricSchema + ship validate/score helpers`. Noreply env-var pattern.
3. Deploy: additive — `assessiq-api` recreate to pick up the new workspace module; no migrations.
4. Document: `modules/08-rubric-engine/SKILL.md` resolves P2.D12; `modules/04-question-bank/SKILL.md` notes the re-export shape; `docs/02-data-model.md:25` updated to remove dead `rubrics`/`anchors` reference.
5. Handoff: SESSION_STATE entry.

---

#### Session 3 — `09-scoring`

##### What to implement

1. **Migration `modules/09-scoring/migrations/0050_attempt_scores.sql`** — `attempt_scores` per `docs/02-data-model.md:531–541`. Standard tenant_id-direct RLS. Indexes: `(tenant_id, computed_at DESC)` for the cohort dashboards, `(tenant_id, archetype)` for the archetype-distribution rollup.
2. **No `archetypes` table.** Per P2.D11, archetypes are a TypeScript enum exported from `@assessiq/scoring` (the eight built-ins). Tenant-defined custom archetypes are an explicit Phase 3 deferral; Session 3's SKILL.md update flags this.
3. **Module skeleton at `modules/09-scoring/src/`:**
   - `types.ts` — exports `ArchetypeLabel` (string union of the 8 built-ins per P2.D11), `ArchetypeSignals` (the JSONB shape from P2.D11), `AttemptScore` (full row shape), `CohortStats`, `LeaderboardRow`. Zod schemas mirror.
   - `archetype.ts` — `deriveArchetype(scoreData: AttemptScore, eventData: AttemptEvent[]): { archetype: ArchetypeLabel | null, signals: ArchetypeSignals }`. **Pure deterministic function, no AI.** Computes `time_per_question_p50_ms`, `time_per_question_iqr_ms`, `edit_count_total` (sum of `answer_save` events with `clientRevision > 0`), `flag_count`, `multi_tab_conflict_count`, `tab_blur_count`, `copy_paste_count`, `reasoning_band_avg`, `reasoning_band_distribution`, `error_class_counts`, `auto_submitted` (true iff `attempts.status='auto_submitted'`). Archetype label assigned by the rules: `methodical_diligent` if `time_p50 > p75 AND edit_count > p75 AND reasoning_band_avg > 3`; `confident_correct` if `time_p50 < p25 AND edit_count < p25 AND total_pct > 0.85`; `confident_wrong` if `time_p50 < p25 AND edit_count < p25 AND total_pct < 0.5`; `cautious_uncertain` if `time_p50 > p75 AND flag_count > 3 AND reasoning_band_avg in [1.5, 2.5]`; `last_minute_rusher` if first-third of attempt time covers <30% of answers; `even_pacer` if time IQR < p25; `pattern_matcher` if mcq_score / mcq_max > 0.85 AND reasoning_band_avg < 2; `deep_reasoner` if reasoning_band_avg > 3 AND mcq_score / mcq_max in [0.5, 0.85]; else null. The percentile thresholds are tenant-cohort-relative (computed from `attempt_scores` for the same `assessment_id`); for the first attempt in a cohort the function returns `null` archetype and just the raw signals (later attempts trigger backfill via `recomputeOnOverride` if needed).
   - `service.ts` — public surface:
     - `computeAttemptScore(attemptId): Promise<AttemptScore>` — RLS-aware. Reads `gradings` rows for the attempt, sums per-question `score_earned` + `score_max`, computes `auto_pct = total_earned / total_max`, sets `pending_review` iff any `gradings.status='review_needed'` exists. Reads `attempt_events` for `deriveArchetype`. Writes `attempt_scores` row (UPSERT on `attempt_id` PK). Idempotent.
     - `recomputeOnOverride(attemptId)` — same as above; called by 07's `handleAdminOverride` after each override write so the score reflects the latest verdict.
     - `cohortStats(assessmentId): Promise<CohortStats>` — RLS-aware. Returns `{ attempt_count, average_pct, p50, p75, p90, archetype_distribution }`.
     - `leaderboard(assessmentId, {topN}): Promise<LeaderboardRow[]>` — RLS-aware, **admin-only** per P2.D13. Rows ordered by `auto_pct DESC` capped at `topN` (default 10).
   - `routes.ts` — Fastify plugin. Mounts `GET /api/admin/attempts/:id/score` (returns the row for an admin viewing the attempt detail page; mostly a fallback — module 10's attempt-detail handler can call the service directly), `GET /api/admin/reports/cohort/:assessmentId` (returns cohort stats), `GET /api/admin/reports/individual/:userId` (sequence of `AttemptScore` rows across that user's attempts), `GET /api/admin/reports/leaderboard/:assessmentId?topN=10`.
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers. Cases: computeAttemptScore happy path (gradings → attempt_scores write); `pending_review` flag flips when a `gradings.status='review_needed'` exists; deriveArchetype rule coverage (one test per archetype label, plus a "null archetype on first attempt in cohort" test); recomputeOnOverride writes a new row that reflects the post-override score; cohortStats percentile math; leaderboard ordered correctly + RLS isolated cross-tenant; the eight built-in archetype labels round-trip through the Zod enum.
4. **Apps wiring.** `apps/api/src/server.ts` imports + calls `registerScoringRoutes`. New deps in `apps/api/package.json`: `@assessiq/scoring: workspace:*`.
5. **Tools wiring.** Phase 1 G1.C left `attempt_scores` empty. Optional one-off backfill script at `tools/backfill-attempt-scores.ts` reads every `gradings`-row-bearing attempt (post-G2.A there will be a few) and computes the score row. Phase 2 G2.B doesn't *need* it (the writer is `computeAttemptScore`, called from 07's accept handler in a follow-up patch — see DoD note); the backfill ships for safety.

##### Documentation references

- `modules/09-scoring/SKILL.md` — public surface.
- `docs/02-data-model.md:531–541` — `attempt_scores` schema.
- `docs/05-ai-pipeline.md:336–349` — per-question scoring math (consumed via 08).
- `modules/06-attempt-engine/EVENTS.md` — behavioral signal event schemas.
- `modules/08-rubric-engine/src/score.ts` — math helpers.
- P2.D11, P2.D13 in this plan.

##### Verification checklist

- [ ] `0050_attempt_scores.sql` applies clean; `tools/lint-rls-policies.ts` passes (standard `tenant_id`-direct policy).
- [ ] `pnpm --filter @assessiq/scoring test` green.
- [ ] `computeAttemptScore` writes a row; second call is idempotent (UPSERT on `attempt_id`).
- [ ] `deriveArchetype` returns the 8 expected labels under the matching rule conditions; returns `null` for the first attempt in a cohort.
- [ ] `cohortStats` returns deterministic percentiles; cross-tenant invisibility verified via RLS test.
- [ ] `leaderboard` ordered correctly; RLS-tested (tenant A's leaderboard cannot see tenant B's attempts).
- [ ] `archetype_signals` JSONB shape matches P2.D11 verbatim.
- [ ] No `claude` / `@anthropic-ai/*` imports in `modules/09-scoring/**` (D2 lint enforces).
- [ ] No `WHERE tenant_id = $1` in repository — RLS only.

##### Anti-pattern guards

- **NEVER** invoke an LLM for archetype computation. Deterministic signal aggregation only. The D2 lint rejection pattern 1 enforces.
- Don't enqueue grading from 09 — scoring is post-grading only. D2 rejection pattern 4.
- Don't compute archetype in the foreground request thread for cohort stats — the rollup query reads `attempt_scores.archetype` directly.
- Don't expose `attempt_events.payload` to candidate APIs — internal observability (Phase 1 invariant — still applies).
- Don't write `attempt_scores` outside `computeAttemptScore` — single writer. 07's accept handler calls `computeAttemptScore(attemptId)` after writing the gradings row (follow-up patch in this session, or in G2.C Session 4 if 07 didn't include it).
- Don't make `leaderboard` cross-tenant — DPDP / data-residency. Phase 3 considers public leaderboards with explicit privacy review (P2.D13).

##### DoD

1. Phase 2 gates pass; Phase 3 Opus diff review; **codex:rescue judgment-call** — recommend invoke once on the archetype rule logic + the percentile-cohort thresholds (the deterministic-but-stateful "first attempt in cohort returns null" case is a subtle correctness trap). 09 is not on the load-bearing-paths list per `CLAUDE.md`, but the archetype labels are a candidate-visible surface (via 11-candidate-ui's results page in Phase 3+) and incorrect labels are reputational.
2. Commit `feat(scoring): attempt_scores + cohort + archetype + leaderboard`. Noreply env-var pattern.
3. Deploy: additive — apply migration `0050`, recreate `assessiq-api` to pick up the new routes + the scoring service. Smoke: from a Phase 2 G2.A graded attempt, call `GET /api/admin/attempts/:id/score` and verify the row + archetype shape.
4. Document: `docs/02-data-model.md` Status: live for `attempt_scores`; `docs/03-api-contract.md` adds the four new admin scoring endpoints; `modules/09-scoring/SKILL.md` resolves P2.D11 + P2.D13; `docs/05-ai-pipeline.md` § "Score computation" gets a "see also `modules/08-rubric-engine`, `modules/09-scoring`" cross-reference.
5. Handoff: SESSION_STATE entry.

---

### Group G2.C — Admin dashboard (after G2.B merges)

#### Session 4 — `10-admin-dashboard`

##### What to implement

1. **17-ui-system Phase 2 primitives (P2.D18) — first batch of files in this session's commit.** `modules/17-ui-system/src/components/`:
   - `ScoreRing.tsx` — circular progress, animated count-up. Uses `useCountUp` from existing 17. Sizes sm/md/lg.
   - `Sparkline.tsx` — 7–30 point line chart with optional area fill. Pure SVG, no chart library.
   - `Sidebar.tsx` + `NavItem.tsx` — admin shell.
   - `StatCard.tsx` — KPI tile (label + Num + optional Sparkline).
   - `Table.tsx` — `<Table data={...} columns={...} cursor={...} onLoadMore={...} />`. Server-pagination via opaque cursors. Filterable + sortable. Pure CSS grid for layout, no virtualization (Phase 2 scale doesn't need it).
   - `Modal.tsx` — focus-trap, Escape closes, backdrop click closes (configurable).
   - `Drawer.tsx` — right-side drawer (560px), shares some implementation with 16-help-system's HelpDrawer.
   - Storybook stories for each — light + dark + density-compact variants.
2. **Module skeleton at `modules/10-admin-dashboard/src/`:**
   - **Domain composites at `components/`:**
     - `AnchorChip.tsx` — chip with hit/miss icon + evidence-quote tooltip via `<HelpTip>`.
     - `BandPicker.tsx` — five radio cards (0/1/2/3/4) with band descriptions read from the question's rubric.
     - `RubricEditor.tsx` — anchor list (add/edit/delete), bands editor, weight totaler with live "weights must sum to 100" validation.
     - `GradingProposalCard.tsx` — shows anchors + band + justification + accept/override/rerun footer.
     - `EscalationDiff.tsx` — side-by-side Stage-2 vs Stage-3 verdict cards with "Reconcile" affordance per P2.D16.
     - `ArchetypeRadar.tsx` — radar chart of `archetype_signals` (pure SVG, axis = top 6 signals).
     - `ScoreDetail.tsx` — per-question breakdown rendering anchor hits + band + justification.
   - `pages/` (mounted under `apps/web/src/pages/admin/` via the module's barrel):
     - `dashboard.tsx` — `/admin` home. Layout: `<Sidebar>` + main pane with KPI row (`StatCard × 4`), `GradingQueue` table (`GET /api/admin/dashboard/queue`), recent activity feed.
     - `attempts.tsx` — `/admin/attempts`. Filterable `Table` of all attempts (status filter, assessment filter, candidate search).
     - `attempt-detail.tsx` — `/admin/attempts/:id`. Side-by-side: question + answer on left, grading proposal / accept-override-rerun / Stage-3 escalation diff on right. The page-load handler triggers the `submitted → pending_admin_grading` transition per P2.D15.
     - `grading-jobs.tsx` — `/admin/grading-jobs`. Phase 2 G2.A returns empty; the page renders "No background grading jobs — Phase 1 mode is sync. Switch to API mode to enable background grading." with help-link.
     - `cohort-report.tsx` — `/admin/reports/cohort/:assessmentId`. KPI row, archetype distribution donut, percentile table, leaderboard (anonymizable per P2.D13).
     - `individual-report.tsx` — `/admin/reports/individual/:userId`. Sequence of `AttemptScore` rows + `Sparkline` of `auto_pct` over time + per-attempt `ArchetypeRadar`.
     - `question-editor.tsx` — `/admin/question-bank/questions/:id`. Inline `RubricEditor` per P2.D14 + question content editor + version history.
     - `billing.tsx` — `/admin/settings/billing`. Reads from `GET /api/admin/settings/billing` (07's handler). Phase 2 G2 stub view: "Phase 2 grading uses the admin's Max OAuth on the VPS — no API token cost. Switch to API mode to enable per-tenant grading budgets." + budget panel placeholder.
     - `help-content.tsx` — `/admin/settings/help-content`. Per P2.D14: list view + inline edit + Markdown preview + import/export JSON.
   - `routes.ts` — Fastify plugin. The 10 module owns NO new HTTP routes (data routes live in 07/08/09); the plugin only wires React-Router-compatible static asset serving for the new pages. The actual admin SPA bundle re-builds via `pnpm --filter @assessiq/web build` during deploy.
   - `index.ts` — public barrel exposing the page components for `apps/web/src/main.tsx` to register.
3. **`apps/web/src/pages/admin/`** — register the new pages via React Router. Existing pages (`login`, `mfa`, `users` from Phase 0/1) stay untouched.
4. **Help YAML additions per P2.D17.** `modules/16-help-system/content/en/admin.yml` adds 25 new keys with production-quality copy (short_text + long_md). Re-run `tools/generate-help-seed.ts` to emit `0014_seed_help_phase2_admin.sql` migration.
5. **Tests:**
   - Vitest unit tests for pure components (`AnchorChip`, `BandPicker`, etc.).
   - Storybook stories for every domain composite.
   - Playwright E2E: full happy-path (admin logs in → goes to dashboard → opens grading queue → clicks Grade on a `pending_admin_grading` attempt → sees proposal → clicks Accept → attempt → graded; admin opens cohort report → sees percentiles + archetype distribution; admin overrides a grade with fresh-MFA; admin opens billing page → sees Phase 2 stub).
6. **17-ui-system tests** for the new primitives (ScoreRing animation, Table cursor pagination, Modal focus-trap, Drawer Escape key).

##### Documentation references

- `modules/10-admin-dashboard/SKILL.md` — full page tree.
- `modules/07-ai-grading/SKILL.md` — endpoints consumed.
- `modules/09-scoring/SKILL.md` — endpoints consumed.
- `docs/03-api-contract.md` — Admin section.
- `docs/08-ui-system.md` — UI primitives.
- `docs/10-branding-guideline.md` — visual invariants (especially `:270` Stage 3 escalation idiom).
- `modules/16-help-system/SKILL.md` + `content/en/admin.yml` — help-id stability + new key seeding.
- P2.D11, P2.D14, P2.D15, P2.D16, P2.D17, P2.D18.

##### Verification checklist

- [ ] All 17-ui-system Phase 2 primitives ship with Storybook stories; visual smoke green light + dark + density-compact.
- [ ] `pnpm --filter @assessiq/web build` produces a bundle ≤ 250 KB JS gzipped (Phase 2 budget = Phase 1 200 KB + ~50 KB headroom for new admin surfaces).
- [ ] Playwright E2E green: admin happy-path through grading queue → accept → graded.
- [ ] Override flow requires fresh MFA: a stale-MFA admin session redirects to MFA verify before allowing override submit.
- [ ] Stage-3 escalation diff renders side-by-side when proposal carries `escalation: BandFinding`; admin "Reconcile" pick writes `gradings.escalation_chosen_stage` correctly.
- [ ] Cohort report renders archetype distribution donut + percentile table; leaderboard anonymization toggle works.
- [ ] Billing page renders the Phase 2 stub copy correctly; reads from `GET /api/admin/settings/billing`.
- [ ] Help-content authoring page lists all admin help_ids; inline edit + Markdown preview + version-bump on save works; export JSON downloads the seed-equivalent.
- [ ] Help YAML seed re-generation idempotent: `tools/generate-help-seed.ts` produces the same `0014_seed_help_phase2_admin.sql` on second run.
- [ ] `helpId` references in pages match seeded keys (no orphan `helpId="..."` per Phase 1 plan decision #10).
- [ ] No `AccessIQ_UI_Template/` runtime imports in 10's pages or components (Phase 0 invariant).
- [ ] No `claude` / `@anthropic-ai/*` imports anywhere in `modules/10-admin-dashboard/**` or `apps/web/**` (D2 lint enforces).
- [ ] No `if (domain === 'soc')` anywhere.
- [ ] All buttons render as pills; no card shadows; big numbers in serif tabular-nums (Phase 0 invariants).

##### Anti-pattern guards

- Don't import `AccessIQ_UI_Template/*` at runtime — port idioms by hand (Phase 0 invariant).
- Don't render the proposal `ai_justification` as raw HTML — sanitize via remark-rehype with safe defaults. AI output is admin-trusted but defense-in-depth.
- Don't render candidate `answer` content as raw HTML — same sanitization.
- Don't write `gradings` directly from 10's pages — always route through 07's handlers (`/grade`, `/accept`, `/override`, `/release`).
- Don't compute archetype in 10 — read from 09's `attempt_scores.archetype_signals`.
- Don't skip the fresh-MFA gate on override — middleware enforces, but the UI must also handle the redirect-to-MFA gracefully.
- Don't expose Phase 1 attempt rate-limit internals to admin UI — they're in module 06's repository, not 10's contract.
- Don't render `attempt_events` to candidate-side UI — 10 is admin-only territory anyway, but be explicit.
- Don't bundle Monaco in the admin pages — 10's `RubricEditor` is plain textarea + Markdown preview, not Monaco. Monaco lives in `11-candidate-ui` per Phase 1 G1.D.
- Don't ship a heavyweight chart library — `Sparkline` and `ArchetypeRadar` are pure SVG by design.

##### DoD

1. Phase 2 gates pass; Phase 3 Opus diff review; **codex:rescue judgment-call** — recommend invoke once on the override + escalation-reconcile flow (the writer-of-record is 07's handler, but 10's UI is the one that constructs the request body — a malformed body shape could write garbage to `gradings.override_reason`). 10 is not load-bearing.
2. Commit `feat(admin-dashboard): phase-2 admin pages + 17-ui-system primitives + help yaml seeding`. Noreply env-var pattern.
3. Deploy: additive — no migrations except the help-seed `0014_seed_help_phase2_admin.sql`. Rebuild + redeploy `assessiq-frontend` (the SPA bundle includes the new admin pages + 17-ui-system primitives). Smoke: real browser → admin login → MFA → dashboard → grading queue → click into an attempt → see the proposal-review flow end-to-end.
4. Document: `modules/10-admin-dashboard/SKILL.md` Status: live for the Phase 2 pages (with explicit Phase 3 deferral list for the remaining SKILL.md pages); `modules/17-ui-system/SKILL.md` flips Phase 2 primitives to live; `modules/16-help-system/SKILL.md` resolves P2.D14 (admin authoring UI is now in scope and shipped); `modules/16-help-system/content/en/admin.yml` ships the 25 new keys; `docs/08-ui-system.md` adds the new primitives to the shipped-components list; `docs/03-api-contract.md` confirms no new endpoints (10 owns no HTTP routes).
5. Handoff: SESSION_STATE entry. **Phase 2 closes here.**

---

## Final phase — Phase 2 verification (orchestrator-only, no new session)

After all four sessions land, the orchestrator runs a single verification pass:

1. **Manual full-stack smoke** — admin logs into `/admin/login` → MFA → `/admin` shows the grading queue → opens a `pending_admin_grading` attempt → `/admin/attempts/:id` shows the proposal-review UI → admin clicks "Grade" → real `claude -p` spawn on the VPS → proposal renders with anchor hits + band + justification → admin clicks "Accept" → `gradings` row commits with the three D4 columns populated → `attempt_scores` row writes via 09 → admin opens `/admin/reports/cohort/:assessmentId` → archetype distribution + percentiles render. Take screenshots; attach to handoff.
2. **D8 compliance frame drill** — confirm via `docker exec assessiq-api sh -c 'echo $ANTHROPIC_API_KEY'` returns empty (D1 invariant). Confirm via `cat /var/log/assessiq/grading-audit.jsonl | tail -3` that the audit hook captured the smoke test's grading runs. Confirm `~/.claude/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md` exist on the VPS with the same SHAs as the in-repo `prompts/skills/` files.
3. **D2 lint drill** — synthesize a violation (e.g., add `import { runClaudeCodeGrading } from '@assessiq/ai-grading'` to `apps/worker/src/scheduler.ts`) → CI fails the lint check → revert. Verify the lint correctly flags the violation message.
4. **D7 mutex drill** — open two browser tabs as admin. Tab 1: click "Grade" on attempt A. Tab 2 immediately: click "Grade" on attempt B. Tab 2 should receive 409 with the global "another grading is running" message until tab 1's grading completes. Reverse the test for same-attempt double-click.
5. **Override + fresh MFA drill** — admin session, override an existing grading row → middleware redirects to MFA verify → after verify, override succeeds → second override 6 minutes later → middleware redirects again (5min freshness window).
6. **Cross-tenant isolation drill** — using `assessiq_system` BYPASSRLS role, insert a second tenant + a graded attempt. As tenant A's admin, hit `/api/admin/dashboard/queue` and `/api/admin/reports/cohort/:assessmentId` and confirm tenant B's rows are absent. Repeat for `attempt_scores`.
7. **Skill drift drill** — manually `echo "extra line" >> ~/.claude/skills/grade-band/SKILL.md` on the VPS → reload the admin attempt-detail page → drift badge appears with the "Re-grade" CTA → click re-grade → new `gradings` row writes with the new SHA, old row stays untouched (per D4).
8. **Eval harness drill** — `pnpm aiq:eval:run --mode claude-code-vps` against the 5 sample cases per type → produces `runs/<ISO>/` → admin reviews diffs → `pnpm aiq:eval:bless --run <ISO>` writes `baselines/<YYYY-MM-DD>.json` with `signed_by` populated.
9. **Budget panel drill** — `/admin/settings/billing` renders the Phase 2 stub copy correctly with the 0/0 values. Insert a `tenant_grading_budgets` row directly via `psql` for tenant A → reload → values update. (No enforcement yet — the panel is read-only display.)
10. **VPS additive-deploy audit** — `ssh assessiq-vps`, run `docker ps` (only `assessiq-api` recreated; other 14 co-tenant containers untouched), `systemctl list-units --state=running --no-pager` (no new units), `diff /opt/ti-platform/caddy/Caddyfile.bak.<latest> /opt/ti-platform/caddy/Caddyfile` (Phase 2 doesn't touch edge config — diff should be empty), `ls /opt/ti-platform/caddy/ssl/` (no changes). The Caddy `@api` matcher already includes `/api/*` from Phase 0; no new matcher additions in Phase 2. Confirm no other apps' configs or containers touched.
11. **Doc drift sweep** — for each Phase 2 module: SKILL.md Status reflects live; `docs/02-data-model.md` (`gradings` Phase 2 columns + `tenant_grading_budgets` + `attempt_scores`), `docs/03-api-contract.md` (admin grading + dashboard + reports + scoring + billing endpoints), `docs/05-ai-pipeline.md` (Phase 1 implementation skeleton flipped to live), `docs/06-deployment.md` (§ Pipeline mode + skill deploy procedure + MCP server), `docs/08-ui-system.md` (Phase 2 primitives live), `modules/16-help-system/content/en/admin.yml` (25 new keys), `prompts/skills/` (in-repo source-of-truth for the three skills) all reflect what shipped. Phase 2 entry appended to `PROJECT_BRAIN.md` § Build phases.
12. **codex:rescue final pass** on the merged Phase 2 surface — D2 lint is the security-defining artifact, the runtime is the ToS-defining artifact, the override + accept flow is the auditable-AI-defining artifact. Log final verdict.

If any step fails: open one bounce-back session, fix, re-verify the failed step only.

---

## Routing summary (for future-me)

| Activity | Where |
|---|---|
| This plan | Anyone reads `docs/plans/PHASE_2_KICKOFF.md` |
| Each session's day-one read | `PROJECT_BRAIN.md` + `docs/01-architecture-overview.md` + `docs/SESSION_STATE.md` + `docs/RCA_LOG.md` + `docs/05-ai-pipeline.md` (mandatory for every Phase 2 session) + this file's session block + the module's `SKILL.md` (per `CLAUDE.md` § Phase 0 reading list) |
| Subagent delegation inside a session | Per global `CLAUDE.md` orchestration playbook (Sonnet for mechanical implements, Haiku for grep sweeps + post-deploy verification, Opus for diff critique) |
| Adversarial review | `codex:rescue` **mandatory** on Session 1 (`07-ai-grading` — load-bearing per `CLAUDE.md`, lint sentinel + runtime + handlers + audit hook); judgment-call on Sessions 2, 3, 4 (recommendations per Session DoD notes) |
| Out-of-scope deferrals | `runtimes/anthropic-api.ts` real implementation → Phase 3+ when paid grading credits land; `runtimes/open-weights.ts` → Phase 4+ on-prem; `prompt_versions` table population → Phase 3+ (with `anthropic-api`); admin help-content WYSIWYG → Phase 3+ (Phase 2 G2.C ships Markdown-only); public-facing leaderboard → Phase 3+ analytics module 15 with DPDP review; tenant-defined custom archetypes → Phase 3+; mobile admin UI → Phase 3+; audit-log viewing UI (`/admin/settings/audit`) → Phase 3 (module 14); webhook config UI (`/admin/settings/integrations/webhooks`) → Phase 3 (module 14); auto-retry on grading failures → Phase 3+ (when `anthropic-api` mode lands with budget enforcement, BullMQ exponential backoff per D3); CSV bulk import → Phase 3+ (Phase 1 plan decision #4 default); `QuestionNavigator` UI primitive → Phase 3+ candidate-UI polish; remaining 19 SKILL.md pages in module 10 (`/admin/assessments/*` form pages, `/admin/users/:id`, `/admin/users/invitations`, `/admin/profile`, `/admin/settings/tenant`, `/admin/settings/authentication`, `/admin/settings/integrations/api-keys`, `/admin/settings/integrations/embed-secrets`, `/admin/reports/topic-heatmap`, `/admin/reports/exports`, `/admin/question-bank/import` UI) → Phase 3+ — Phase 2 admin work focuses on grading + scoring + reports + the inline rubric author + help authoring; the rest remain CLI/curl-driven through Phase 2 |

---

## Appendix A — 25 Phase 2 admin help_ids to seed in G2.C Session 4

```
admin.grading.queue.row
admin.grading.queue.empty
admin.grading.proposal.anchors
admin.grading.proposal.band
admin.grading.proposal.justification
admin.grading.proposal.error_class
admin.grading.proposal.escalation
admin.grading.accept
admin.grading.override.reason
admin.grading.rerun
admin.grading.rerun.opus
admin.grading.skill_drift
admin.scoring.attempt.total
admin.scoring.attempt.archetype
admin.scoring.archetype.disclaimer
admin.scoring.cohort.percentiles
admin.scoring.leaderboard.privacy
admin.rubric.anchor.weight
admin.rubric.anchor.synonyms
admin.rubric.anchor.required
admin.rubric.reasoning.bands
admin.rubric.error_classes
admin.settings.billing.budget
admin.settings.billing.alert_threshold
admin.settings.help_content.markdown
```

These are stable forever once seeded per Phase 1 plan decision #10. Tenant overrides can be authored via the `/admin/settings/help-content` page (P2.D14).

---

## Appendix B — Phase 2 G2.A migration order (operational recipe for Session 1's deploy step)

```
1. Backup gradings table:
   pg_dump -t gradings assessiq > /var/backups/assessiq/gradings-pre-phase2-$(date -u +%Y%m%dT%H%M%SZ).sql

2. Apply migrations in order:
   docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 \
     < modules/07-ai-grading/migrations/0040_gradings_phase2_columns.sql
   docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 \
     < modules/07-ai-grading/migrations/0041_gradings_escalation_chosen.sql
   docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 \
     < modules/07-ai-grading/migrations/0042_tenant_grading_budgets.sql

3. Verify:
   docker exec assessiq-postgres psql -U assessiq -d assessiq \
     -c "\d gradings" \
     -c "\d tenant_grading_budgets"

4. Copy in-repo skills to VPS:
   scp -r prompts/skills/grade-anchors prompts/skills/grade-band prompts/skills/grade-escalate \
     assessiq-vps:~/.claude/skills/

5. Copy MCP server + register:
   scp -r tools/assessiq-mcp assessiq-vps:/srv/assessiq/mcp/
   ssh assessiq-vps 'cat /srv/assessiq/mcp/.mcp.json.example > ~/.claude/.mcp.json'

6. Copy admin claude settings (PostToolUse audit hook):
   scp infra/admin-claude-settings.example.json assessiq-vps:~/.claude/settings.json
   ssh assessiq-vps 'mkdir -p /var/log/assessiq && chmod 0640 /var/log/assessiq'

7. Verify claude CLI on VPS:
   ssh assessiq-vps 'claude --version'

8. Set AI_PIPELINE_MODE in /srv/assessiq/.env:
   ssh assessiq-vps 'grep -q AI_PIPELINE_MODE /srv/assessiq/.env || echo "AI_PIPELINE_MODE=claude-code-vps" >> /srv/assessiq/.env'

9. Recreate API container (env_file diff requires recreate, not restart, per RCA 2026-05-01):
   ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-api'

10. Recreate worker container to pick up the daily rollover BullMQ job (D6):
    ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate assessiq-worker'

11. Smoke:
    curl -fsS https://assessiq.automateedge.cloud/api/health  # 200
    # Then auth + admin queue + grade flow per § Final phase verification step 1.
```

---

## Status

- **Plan version:** 1.0 (2026-05-02, orchestrator: Opus 4.7)
- **Open questions outstanding:** none. All 18 decisions captured at orchestrator-default; D1–D8 are verbatim restatements of the user-confirmed `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) addendum and stay load-bearing.
- **Blocking dependencies before G2.A opens:** Phase 1 G1.A through G1.C shipped (verified at this plan's authoring time on `main`); Phase 1 G1.D (`11-candidate-ui`) is in flight in a separate session window and **does not block G2.A** — G1.D is candidate-side `/take/*`; G2.A is admin-side `/admin/*` + grading runtime. The two windows can ship in parallel against the same `main` branch as long as their commit windows don't overlap on shared files (the only shared file is `apps/web/src/main.tsx` for route registration; Session 4's frontend ship coordinates with the in-flight G1.D handoff).
- **Next action:** wait for the orchestrator overlap with the in-flight G1.D session to settle (G1.D's commit lands first, then G2.A opens), then open G2.A Session 1. Sessions 2 + 3 open in parallel after G2.A merges. Session 4 opens after G2.B merges.
