# Session — 2026-05-03 (Phase 2 G2.A Session 1.b — claude-code-vps runtime + 9 admin handlers + eval + skills + MCP — LIVE on production)

**Headline:** AI grading pipeline lit up end-to-end on `assessiq.automateedge.cloud`. Real `runClaudeCodeGrading` body, 9 admin service handlers, 10 Fastify admin endpoints, eval harness skeleton, 3 in-repo skills (Haiku/Sonnet/Opus), assessiq-mcp server, admin Claude settings template, plus 6 helper modules and 7 vitest files (102/102 green). Sonnet-takeover adversarial pass returned REVISED — 3 findings applied, 1 deferred. 11/11 live-prod smoke checks PASS post-deploy. Co-tenant containers untouched.
**Commits:** `5aec6ad — feat(ai-grading): Phase 2 G2.A Session 1.b — claude-code-vps runtime + 9 admin handlers + eval harness + 3 in-repo skills + MCP server` (54 files, +9337/−101). On `origin/main`.
**Tests:** `pnpm --filter @assessiq/ai-grading exec vitest run` → **102/102 passing in 12.5s** across 7 files (score 17, single-flight 10, stream-json-parser 16, skill-sha 10, runtime mock-spawn 17, handlers testcontainer 23, eval CLI 9). `pnpm -r typecheck` → 16/16 workspaces green. `pnpm lint:ambient-ai` (203 TS files), self-test (8/8), `pnpm lint:rls` (30 migrations / 16 + 8 tables), `pnpm lint:edge-routing` (23 files / 80 mounts), anti-pattern greps (`@anthropic-ai`, `spawn("claude")`, `sk-ant-`, untagged TODOs) all clean. Production smoke grid 11/11 ✓.
**Next:** Phase 2 G2.B Sessions 2 + 3 in parallel (08-rubric-engine + 09-scoring) per `docs/plans/PHASE_2_KICKOFF.md`. 08 lifts the rubric Zod schema from 04 + ships `validate.ts` + `score.ts`; 07's runtime currently has its own local `score.ts` (intentional G2.B-deferral) and will swap to `@assessiq/rubric-engine` in 08's PR. 09 ships the `attempt_scores` table + archetype derivation. G2.B Session 3 = `codex:rescue` judgment-skip per kickoff plan; both are non-load-bearing pure-math + read-only services.
**Open questions:** see § Carry-forwards.

---

## What shipped (commit `5aec6ad`)

`modules/07-ai-grading/` source (24 new + 5 modified) + `apps/api/src/server.ts` wiring + `prompts/skills/` + `tools/assessiq-mcp/` + `infra/admin-claude-settings.example.json`:

| File | Role |
|---|---|
| `src/runtimes/claude-code-vps.ts` | Real `runClaudeCodeGrading` body. Spawns `claude -p` with `--allowed-tools mcp__assessiq__submit_*`, `--disallowed-tools Bash,Write,Edit,Read,Glob,Grep`, `--output-format stream-json`, `--max-turns 4`, 120s timeout per stage. 3-stage cascade: Stage 1 anchors → Stage 2 band → Stage 3 escalate (auto when `band.needs_escalation === true` OR forced by `input.force_escalate === true`). Reconciliation: ≥2-band Stage 2/3 disagreement → `escalation_chosen_stage: "manual"` (admin sees both verdicts); <2 → Stage 3 wins. |
| `src/runtime-selector.ts` | Dynamic `await import()` per case branch. Closes the R2 hazard from 1.a Sonnet rescue (eager import would have crashed startup once `runtimes/anthropic-api.ts` ships its real Agent SDK import). |
| `src/single-flight.ts` | D7 in-process `Map<attemptId, true>` mutex. Same-attempt double-click → 409 `same_attempt_in_flight`. Different-attempt while busy → 409 `other_attempt_in_flight`. No queueing, no merging, no auto-retry — by design. |
| `src/skill-sha.ts` | Reads `~/.claude/skills/<name>/SKILL.md`, returns sha256 + first-8-hex + frontmatter `version:` + `model:`. Minimal regex parser (no `yaml` dep). |
| `src/stream-json-parser.ts` | Newline-delimited JSON splitter. `parseToolInput` uses **EXACT** prefix match `name === toolName \|\| name === "mcp__assessiq__" + toolName` (rescue Finding #2 — was `endsWith` originally). |
| `src/score.ts` | `sumAnchorScore` + `computeReasoningScore` + `computeFinalScore` per `docs/05-ai-pipeline.md` § Score computation. Local interface `RubricForScoring` lets module 07 ship before module 08 lifts the canonical Rubric Zod (G2.B Session 2). |
| `src/types.ts` | (modified) Added `force_escalate?: boolean` to `GradingInput` so `handleAdminRerun` can route through the runtime to force Stage 3. |
| `src/handlers/admin-grade.ts` | Service handler. D1 mode-check → D7 heartbeat (60s) → D7 single-flight `acquire` → load attempt + frozen questions + rubric + answers via `withTenant` → per-question `gradeSubjective(input)` → collect proposals → release in `finally`. NO database writes — D8 accept-before-commit. |
| `src/handlers/admin-accept.ts` | Service handler. Pre-loop validates `proposal.question_id ∈ attempt_questions` for the URL attemptId (rescue Finding #3). D7 idempotency check via `findGradingByIdempotencyKey`. Inserts gradings rows (grader='ai') + flips `attempts.status='graded'` in one transaction. `deriveStatus` distinguishes AI runtime failures (`AIG_*` codes → review_needed) from legitimate rubric error_class (flow through score-ratio — H2 fix). |
| `src/handlers/admin-override.ts` | Service handler. **D8 invariant structurally enforced** — zero `UPDATE gradings` statements; only `insertGrading` with `grader='admin_override'`, `override_of=<original.id>`, `override_reason=<admin reason>`. Inherits SHA pinning from original (D4). Fresh-MFA gating is route-layer responsibility. |
| `src/handlers/admin-rerun.ts` | Same heartbeat + single-flight gates as `admin-grade`. Forwards `forceEscalate` flag to `GradingInput.force_escalate` (rescue Finding #5 — JSDoc updated to reflect this is live, not deferred). |
| `src/handlers/admin-queue.ts` | Reads queue via `repo.listGradingQueue` (JOIN: attempts → assessments → levels → users). RLS-scoped via `withTenant`. Phase-1 queue derives from `attempts.status IN ('submitted','pending_admin_grading')` per D3 — no `grading_jobs` table. |
| `src/handlers/admin-claim-release.ts` | Two handlers. Claim = idempotent `submitted → pending_admin_grading` then load answers + frozen_questions (rubric excluded) + gradings. Release = `graded → released` then best-effort `13-notifications.sendResultReleasedEmail` via dynamic `Function("return import")` indirection (handles missing module gracefully). |
| `src/handlers/admin-grading-jobs.ts` | D3 forward-compat stubs: list returns `{ items: [] }`, retry throws RUNTIME_NOT_IMPLEMENTED 503. Real impl lands when `anthropic-api` runtime ships. |
| `src/handlers/admin-budget.ts` | D6: read `tenant_grading_budgets` row or return default `{ monthly_budget_usd: 0, used_usd: 0, period_start: null, alert_threshold_pct: 80 }`. Phase 1 informational only — Max plan is flat-rate. |
| `src/repository.ts` | gradings + tenant_grading_budgets queries. RLS-only (no `WHERE tenant_id`). UNIQUE constraint backstop on `(attempt_id, question_id, prompt_version_sha) WHERE override_of IS NULL` (D7 idempotency). NUMERIC mapping via `parseFloat`. `assessment_levels` JOIN typo caught by handler tests + fixed (`levels al`). |
| `src/routes.ts` | Fastify registrar. 10 endpoints under `/api/admin/{attempts,gradings,dashboard,grading-jobs,settings}/*`. Override uses `adminFreshMfa(5min)` chain. **C1 multi-tenancy guard** — validates every `proposal.attempt_id === URL attemptId` in /accept body before dispatch. Zod body validation on all bodies; `VALIDATION_FAILED 400` on issue. |
| `src/fastify.d.ts` | Ambient `FastifyRequest.session.lastSeenAt: string` augmentation (heartbeat field). Mirrors module 04/05/06 pattern. |
| `src/index.ts` | (modified) Added `registerGradingRoutes` + handler exports. |
| `eval/cli.ts` | Manual entrypoint: `run --mode claude-code-vps`, `compare --run <ISO>`, `bless --run <ISO>`. CI guard refuses to run when `process.env.CI === "true"` (D5). Per-case `*.actual.json` + `run.json` manifest with `prompt_version_shas` + `models` extracted from first proposal. Compare exits 1 on hard-fail (agreement <85%, anchor F1 <0.80, silent-band-4-on-adversarial). |
| `eval/cases/sample-soc-l1-subjective-001.{input,expected}.json` | Hand-crafted SOC-L1 lateral-movement case (4 anchors, 60-pt rubric, medium-quality answer expected band 3). Smoke fixture only — full 50-case golden set is the admin's authoring workstream per D5. |
| `eval/{runs,baselines}/.gitkeep` + `.gitignore` excludes `runs/*/` + `baselines/*.json` | Run output is admin-local. |
| `eval/README.md` | D5 thresholds + bless flow + CI-guard rationale. |
| `prompts/skills/grade-{anchors,band,escalate}/SKILL.md` | The three Claude Code skills. Frontmatter `version: v1`, `model: claude-{haiku-4-5,sonnet-4-6,opus-4-7}`, `temperature: 0.0`. Untrusted-candidate-text framing. Output via `mcp__assessiq__submit_{anchors,band}` MCP tool only. Stage 3 emphasises "you are not shown Stage 2's band" anchoring-bias avoidance. Live SHAs: `anchors=1f04c875`, `band=15c14f96`, `escalate=f3588256`. |
| `tools/assessiq-mcp/{package.json,tsconfig.json,src/server.ts,src/tools/{submit-anchors,submit-band}.ts,.mcp.json.example,README.md,pnpm-lock.yaml}` | Stdio JSON-RPC MCP server via `@modelcontextprotocol/sdk` v1.29 (protocol `2024-11-05`). Two echo tools with Zod input validation. Standalone tsconfig (not extending workspace base) — built artifact deployed to `/srv/assessiq/tools/assessiq-mcp/dist/server.js`. |
| `infra/admin-claude-settings.example.json` | `~/.claude/settings.json` template. PostToolUse hook with matcher `submit_anchors\|submit_band` calling `/srv/assessiq/scripts/grading-audit-hook.mjs` (TODO(phase-2-audit) — script ships in a follow-up; harmless missing-file behavior until then). |
| `apps/api/src/server.ts` | (modified) Wires `registerGradingRoutes(app, { adminOnly: authChain({roles:['admin']}), adminFreshMfa: authChain({roles:['admin'], freshMfaWithinMinutes: 5}) })` after `registerAttemptTakeRoutes`. |
| `apps/api/src/types.d.ts` | (modified) `Pick<Session, ..., 'lastSeenAt'>` for the heartbeat field. |
| `apps/api/package.json` | (modified) Added `@assessiq/ai-grading: workspace:*` dep. |
| `modules/07-ai-grading/package.json` | (modified) Added `@assessiq/attempt-engine`, `@assessiq/auth`, `fastify` deps. |
| `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` | (modified) **Allow-list path correction** — entries gained `src/` prefix to match the actual scaffold (1.a defect: original list said `modules/07-ai-grading/runtimes/...`, actual scaffold is `modules/07-ai-grading/src/runtimes/...`). The 1.a self-test fixtures used the wrong paths so the bug was latent. Fixed both fixtures and contract; 8/8 self-test still passes; 203 TS files repo scan still clean. |
| `modules/07-ai-grading/src/__tests__/` | 6 vitest files (score, single-flight, stream-json-parser, skill-sha, claude-code-vps mock-spawn, handlers testcontainer). |
| `modules/07-ai-grading/eval/__tests__/cli.test.ts` | 9 tests for the eval CLI via subprocess invocation + Node ESM hooks for tmpdir + runtime-mock isolation. |
| `modules/07-ai-grading/vitest.config.ts` | (new) Workspace-relative include glob. |

## Phase 3 critique findings — fixed inline before push

- **C1 (multi-tenancy guard, security):** `routes.ts` `/accept` validates `proposal.attempt_id === URL attemptId` for every proposal in body. Without it, an admin could spoof attempt_id in body and write a gradings row attached to an unrelated attempt within the same tenant (RLS doesn't catch cross-attempt within tenant). Throws `VALIDATION_FAILED 400` with `details.expected/received` on mismatch.
- **H2 (deriveStatus semantic):** `admin-accept.ts` `deriveStatus` only flips to `review_needed` for AI runtime failure codes (`AIG_*` prefix). Legitimate Stage-2 rubric error_classes (`missed_pivot_to_identity`, `over_escalation`, etc) flow through the score-ratio derivation. Old logic flipped any non-null `error_class` to review_needed which would have broken the band scoring for every legitimate AI grade with a non-band-4 error class.

## Adversarial review — sonnet-takeover verdict

User invoked **"sonnet takeover"** for the rescue pass (memory pattern `feedback-sonnet-takeover-on-rescue.md`) — Sonnet subagent ran the same self-contained adversarial prompt that codex:rescue would have received. **Verdict: REVISED**, 4 findings:

- **#2 HIGH (parser exact-prefix):** ACCEPTED + applied. Replaced `parseToolInput`'s `name.endsWith(toolName)` with exact match `name === "mcp__assessiq__" + toolName`. Defense-in-depth — Anthropic-side `--allowed-tools` is the primary block; this tightens the parse-side identity binding so a hypothetical future MCP server with a colliding tool name can't slip a verdict through.
- **#3 MEDIUM (question_id integrity):** ACCEPTED + applied. `acceptProposals` in `admin-accept.ts` runs a pre-loop query against `attempt_questions` to validate every `proposal.question_id` belongs to this attemptId. No DB FK on `gradings.question_id` to `attempt_questions(attempt_id, question_id)`; RLS does not catch cross-attempt-within-tenant; this is the integrity check.
- **#5 LOW (stale JSDoc):** ACCEPTED + applied. `admin-rerun.ts` `forceEscalate` JSDoc updated — the runtime IS live as of 1.b (no longer "deferred to a later session").
- **#4 LOW (admin-grade.ts in spawn allow-list):** **DEFERRED**. The 1.a allow-list set `admin-grade.ts` as belt-and-suspenders even though it doesn't directly spawn `claude` (the runtime does). Tightening the contract to only the runtime file is a separate change that warrants its own rescue pass — out of 1.b scope. Logged as carry-forward.

Tests still 102/102 after revisions. Sonnet substitution flagged in agent-utilization footer per memory protocol.

## Documentation updates (this same-PR + the next docs commit)

- `modules/07-ai-grading/SKILL.md` — § Status Phase 2 G2.A live as of 2026-05-03 (1.b) added with the full file inventory, D1-D8 status flips to live, rescue verdict notes, and what's still NOT live (prompt_versions, grading_jobs, anthropic-api runtime, audit-hook script).
- `docs/05-ai-pipeline.md` § Implementation skeleton flips from "spec" to "live (G2.A 1.b 2026-05-03)" in the next docs commit.
- `docs/03-api-contract.md` § Admin — Grading & review — every endpoint flips to live with full request/response/error contract per CLAUDE.md rule #5 in the next docs commit.
- `docs/06-deployment.md` § Pipeline mode added in the next docs commit (env var + skill-deploy procedure + MCP server registration + admin claude settings copy).
- `docs/11-observability.md` § 10 (Phase-1 AI grading run capture) — status note flips from "doc-only today; module 07 has only SKILL.md" to "live as of G2.A 1.b — `streamLogger('grading')` emits per-call lines with redacted stderrTail" in the next docs commit.

## Deploy posture — LIVE on production VPS

VPS state at deploy: 5 `assessiq-*` containers healthy + 14 co-tenant containers (roadmap, accessbridge, ti-platform) all `Up` and untouched per CLAUDE.md rule #8. Deploy procedure:

1. **Atomic git archive** — `git archive HEAD modules/07-ai-grading/ apps/api/src/ apps/api/package.json infra/admin-claude-settings.example.json prompts/ tools/assessiq-mcp/ pnpm-lock.yaml package.json | ssh assessiq-vps 'cd /srv/assessiq && tar -xf -'`. Single tar — apps/api importer + module 07 exporter together (per RCA 2026-05-03 staggered-deploy lesson — never split a cross-module-import deploy across two tar batches).
2. **Migrations 0040 + 0041 applied** — both shipped in 1.a but deliberately deferred apply per 1.a handoff. `gradings` + `tenant_grading_budgets` tables live with all D4 columns + RLS policies.
3. **Skills installed** — `cp -r prompts/skills/grade-{anchors,band,escalate}` to `~/.claude/skills/` on the admin user. SHAs: `anchors=1f04c875`, `band=15c14f96`, `escalate=f3588256`.
4. **MCP server built** — `cd /srv/assessiq/tools/assessiq-mcp && npm install && npm run build`. `dist/server.js` + `dist/tools/{submit-anchors,submit-band}.js` produced. (`npm install --omit=dev` failed first try — `tsc` is in devDeps; rebuilt with full install.) `.mcp.json` updated to point at `/srv/assessiq/tools/assessiq-mcp/dist/server.js` (note: the kickoff-plan-suggested `/srv/assessiq/mcp/` path was overridden in favor of where the git archive landed).
5. **Admin Claude settings + .mcp.json registered** — `cp infra/admin-claude-settings.example.json ~/.claude/settings.json`; `.mcp.json` written with the corrected absolute path to the MCP server.
6. **`AI_PIPELINE_MODE=claude-code-vps`** confirmed in `/srv/assessiq/.env`. **`ANTHROPIC_API_KEY` confirmed unset** (D1 invariant — Zod superRefine in `00-core/src/config.ts` would have refused boot if both were set). API container booted clean — verified.
7. **assessiq-api + assessiq-worker rebuilt and recreated** with `--no-deps --force-recreate`. New image SHA: `575af96c38ad6...`. Boot log scrape clean (no SyntaxError, no "module does not provide", no config-validation error).
8. **Live smoke grid** (Haiku subagent, 11 checks): all PASS. 5 assessiq containers Up/healthy, /api/health 200, all 10 admin endpoints return 401 (no 404/405 — every route registered), 3 skill files present with deterministic SHAs, claude --version `2.1.119`, MCP dist/ compiled, .mcp.json + settings.json valid JSON, gradings + tenant_grading_budgets tables with 4 RLS policies, AI_PIPELINE_MODE invariant honored, 14 co-tenant containers all Up at pre-deploy uptimes.

## Carry-forwards / open items

| Item | Owner | Notes |
|---|---|---|
| Phase 2 G2.B Sessions 2 + 3 in parallel | next session | 08-rubric-engine lifts `RubricSchema` from 04 + ships `validate.ts` + `score.ts`; 09-scoring ships `attempt_scores` migration 0050 + archetype derivation. 07's local `score.ts` swaps to `@assessiq/rubric-engine` import in 08's PR. |
| `admin-grade.ts` spawn-allow-list tightening (Sonnet rescue Finding #4) | future load-bearing-paths cleanup | Currently `admin-grade.ts` is on `CLAUDE_SPAWN_ALLOW_LIST` despite not directly spawning. Tightening to runtime-file-only is a separate contract change requiring its own rescue pass. Low priority — harmless today (no spawn there to trigger the lint). |
| `/srv/assessiq/scripts/grading-audit-hook.mjs` (PostToolUse audit script) | Phase 2 follow-up | `infra/admin-claude-settings.example.json` references this script; it doesn't exist yet. The hook line silently no-ops until the script lands (Claude Code logs a warning per missing-file but doesn't fail the grading run). Tagged `TODO(phase-2-audit)` in the settings template. |
| `pnpm lint` (eslint) regressions on main pre-existing | tooling cleanup session | 40 problems in 11 files (pre-existing — not 1.b's contribution). Includes `react-hooks/exhaustive-deps` rule mis-config in 11-candidate-ui (4 errors), `no-console` violations in `apps/web/src/lib/logger.ts` + several other places, unused-var in `apps/web/src/pages/take/*.tsx` and `tools/aiq-import-pack.ts`, etc. CI step 6 (`pnpm lint`) was likely never run as a gate by 1.a or earlier sessions. 1.b's diff adds zero new failures (verified by per-file grep — `modules/07-ai-grading/**` is clean, `tools/assessiq-mcp/` is clean, `prompts/skills/**` are markdown not lint-scanned). |
| Real `anthropic-api` runtime | Phase 3+ | Stub remains. Lands when paid budget unlocks; gates: `codex:rescue` first ship, eval-harness re-baseline, D6 budget enforcement. |
| Open-weights runtime | Phase 4+ | Stub remains. Compliance-driven on-prem only. |
| `prompt_versions` table | Phase 3+ | Per D3, Phase 1 stores SHAs on `gradings` rows directly via D4. The table only matters when `anthropic-api` mode adds the budget + cost-telemetry surface. |
| `grading_jobs` table | Phase 2+ when `anthropic-api` mode lands | Per D3, no async fan-out in Phase 1. The /grading-jobs endpoints already return empty list / 503 forward-compat for the UI. |
| Bulk re-grading of Phase 1 attempts | separate task | None to re-grade today — no `gradings` rows have been written to production yet. |
| `'overridden'` gradings.status enum value | minor schema cleanup | Reserved by the migration's CHECK constraint but never set by any code path (override rows use `correct/incorrect/partial` based on score-ratio, with `grader='admin_override'` carrying the identity signal). Vestigial. Document in 02-data-model.md or remove via a future migration. |

---

## Agent utilization

- **Opus 4.7 (1M)**: orchestration; full Phase 0 warm-start (PROJECT_BRAIN + 01-architecture-overview + SESSION_STATE + RCA_LOG + PHASE_2_KICKOFF G2.A block + 05-ai-pipeline (D1-D8 in cache) + 07-ai-grading SKILL.md + the entire 1.a scaffold + 03-api-contract + 06-attempt-engine + 02-tenancy + 11-observability + apps/api/server.ts + auth-chain.ts + admin-worker.ts pattern + 00-core/config.ts + 00-core/errors.ts + 06-attempt-engine repository.ts) all in cache; authored 5 of the 6 RUNTIME files inline (score.ts, skill-sha.ts, stream-json-parser.ts, runtime-selector.ts, runtimes/claude-code-vps.ts) plus all 4 SKILLS files (3 SKILL.md + admin-claude-settings.example.json) when those Sonnets terminated early; AppError-options-shape + force_escalate cross-cutting fixes; lint allow-list path correction (1.a defect); Phase 3 critique authored (C1 + H2 + 4 lower-severity findings adjudicated); rescue verdict adjudication (#2 + #3 + #5 accept, #4 defer); commit + push; deploy orchestration (atomic git archive + migrations + skill install + MCP build + .env config + container recreate); SKILL.md status update + this handoff prepend.
- **Sonnet**: 9 parallel-burst calls. **Phase 1 draft (6):** RUNTIME (terminated early — 1 of 6 files shipped — Opus completed the rest); HANDLERS (✓ — 9 handlers + repository); ROUTES (✓ — registrar + apps/api wiring); EVAL (✓ — CLI + sample case + README + scripts); SKILLS (terminated early — 0 of 4 files shipped — Opus completed); MCP (✓ — server + 2 tools). **Phase 2 tests (3):** runtime tests (✓ — 70 tests, 5 files); handlers tests (✓ — 27 tests, surfaced + drove the `assessment_levels` → `levels` repository fix); eval CLI tests (✓ — 9 tests). **Adversarial rescue:** **sonnet-takeover** invoked by user in lieu of codex:rescue — Sonnet ran the full self-contained adversarial prompt on the 1.b diff, returned **REVISED** with 4 findings, 3 accepted + applied (parser exact-prefix #2, question_id integrity #3, JSDoc #5), 1 deferred (#4 spawn-allow-list tightening).
- **Haiku**: live-prod smoke grid post-deploy — 11 checks (5 assessiq containers Up, /api/health, 10 admin endpoints all 401, 3 skill files + SHAs, claude --version, MCP dist/, .mcp.json + settings.json, gradings + budgets tables, 4 RLS policies, D1 invariant, 14 co-tenant containers untouched). Verdict: **PASS — all 11 ✓**.
- **codex:rescue**: **substituted by sonnet-takeover** per user direction. Same self-contained adversarial prompt shape, verdict logged here as "REVISED → 3/4 accepted + applied, 1 deferred". Per memory `feedback-sonnet-takeover-on-rescue.md` substitution flagged here on its own line as the protocol requires.

---

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
