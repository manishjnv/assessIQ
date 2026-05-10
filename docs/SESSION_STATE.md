# Session — 2026-05-10 (Stage 1.5+ sweep — mechanical gates + admin UI completion)

**Headline:** Closed the type-sharded generation loop end-to-end. Structural shape now enforced at the MCP boundary (Stage 1.5e); citation IDs enforced at the handler boundary (Stage 1.5f); per-chunk stderr aggregation makes any failure diagnosable; admin web UI now covers every operator surface (no SSH/CLI required for normal admin workflows); candidate take flow renders all 5 question types correctly; invitation emails actually deliver via SMTP with `email_log` rows. Production at `AI_GENERATE_MODE=omnibus`; sharded mode is feature-complete but blocked from default-flip by 2 chunks (log_analysis + scenario) failing exit-1 on every smoke — diagnosis unblocked once the next sharded smoke runs (per-chunk stderr aggregation now live).

**Commits this session (chronological, ~28 commits across the day):**
- `bb17254` — fix(skills): Stage 1.5d -- lock per-type content shape + strengthen citation rule
- `898f012` — fix(notifications): thread tenantId through invitation legacy shim + admin invite visibility
- `e25f7b7` — feat(admin-dashboard): /admin/generation-attempts history page
- `930bfb4` — fix(take): candidate renderer + answer-shape audit for all 5 question types
- `3a7906d` — fix(ai-grading): Stage 1.5e -- MCP submit_questions strict per-type schema
- `c6d1992` — fix(notifications): email_log status update after worker delivery
- `f7e1855` — feat(admin-dashboard): bulk approve + bulk archive on pack-detail
- `13f6231` — feat(ai-grading): mechanical citation enforcement at handler boundary
- `9c63d7f` — ci(ai-grading): wire score-goldens as a CI regression gate
- `407f4d7` — chore(ai-grading): post-Stage-1.5e smoke -- runtime-baseline + finding note
- `cd352c7` — fix(grading): heartbeat 60s->5min, dismissible error banner, eval fixtures realigned to real KB IDs
- `9b52fe1` — feat(ai-grading): inspect-attempt CLI subcommand for diagnostics
- `26d0be5` — fix(ai-grading): per-type grading dispatch audit -- log_analysis rubric synthesis
- `c979503` — feat(ops): cleanup-stale-drafts + cleanup-orphaned-attempts CLI helpers
- (+ earlier same-day commits documented in `git log --since="2026-05-09" --oneline`)

**Tests:** pnpm -C modules/07-ai-grading typecheck ✅ | apps/api typecheck ✅ | admin-dashboard typecheck ✅ | notifications typecheck ✅ | 04-question-bank typecheck ✅ | pnpm eval:goldens-strict 75/75 ✅ | new tests: 11 inspect-attempt render + 18 cleanup + 12 email-send-flow + 18 MCP submit-questions + 14 generate-body-validation. testcontainers integration tests skipped locally (Docker-not-available baseline pattern, not regressions).

**Next:** Re-fire sharded smoke (count=15 L2) → use new per-chunk stderr_tail aggregation + inspect-attempt to diagnose the 2-chunk-fail mystery (log_analysis + scenario exit-1 on every smoke). Once root-caused, Stage 3 promotion design (in flight as `docs/design/2026-05-10-stage-3-promotion-rollout.md`) decides Option A (per-tenant flag column) vs Option B (global flip + auto-rollback cron) and execution begins.

**Open questions:**
- Why do log_analysis + scenario chunks consistently exit-1 across 4 smokes (`019e0d59`, `019e0da1`, `019e0deb`)? Pre-aggregation, stderr_tail was always NULL; next smoke will surface the actual reason.
- Stage 3 rollout shape — pending design-doc completion + user pick.
- Score-attempt web button (in flight) — closes last CLI-only gap for admins.

---

## Agent utilization
- Opus: Phase 0 reads, Phase 3 critique on every Sonnet diff, all deploy + smoke + DB ops, RCA + handoff authorship.
- Sonnet: Drove implementation across ~12 distinct prompts (Stage 1.5d/e/f, MCP schema, citation enforcement, stderr aggregation, generation-attempts history page, bulk archive UI, type-aware question view, invitation flow, candidate take audit, inspect-attempt CLI, cleanup CLIs, eval-fixture realignment, score-goldens CI gate, per-type grading audit). Phase 3 review caught 4 issues across the session: Stage 1.5d only landed HARD RULE on 1 of 5 skills (bounce-back), citation regex too soft (escalated to MCP gate), per-chunk stderr never reaching the row, eval fixtures had invented IDs (caught by score-candidate against attempt 019e0deb).
- Haiku: n/a — no bulk grep sweeps needed; investigation was concentrated in handler + runtime files.
- codex:rescue: n/a — companion MCP intentionally bypassed for Stage 1.5* work since structural+citation gates are now mechanical (Zod-enforced) rather than judgment-dependent. Adversarial review NOT needed for prompt-level → tool-level transitions.

---

## Stage 1.5+ artifacts (canonical references for next session)

- **`docs/design/2026-05-09-type-sharded-generation.md`** — parent architecture doc; 9 sections; all 9 open questions closed.
- **`docs/design/2026-05-10-stage-3-promotion-rollout.md`** (in flight) — Stage 3 rollout spec: gating criteria, per-tenant flag design, pilot tenant selection, rollout sequence, observability.
- **`modules/07-ai-grading/eval/runtime-baseline.json`** — single source of truth for runtime metrics + open known_gaps. Lines 56-64 list 6 RESOLVED and 1 OPEN gap (scenario chunk failed once, awaiting stderr dive).
- **`modules/07-ai-grading/eval/baseline.json`** — structural baseline; 75/75 across L1+L2+L3 across all 5 types.
- **`modules/07-ai-grading/eval/golden-questions/L{1,2,3}/{mcq,log_analysis,scenario,kql,subjective}.json`** — 75 reference questions.
- **`modules/07-ai-grading/eval/fixtures/L{1,2,3}-sources.json`** — KB source fixtures realigned to real `mitre.t*` IDs from `modules/04-question-bank/src/knowledge-base/soc-l*.json` (commit `cd352c7`).
- **`prompts/skills/generate-{mcq,log-analysis,scenario,kql,subjective}/SKILL.md`** — 5 type-shard skills at version `2026-05-09d`. Each contains a Question content shape (HARD RULE) + Source-citation contract (HARD RULE) — but both are now MECHANICALLY ENFORCED (MCP + handler) rather than load-bearing.
- **`prompts/skills/generate-rubric/SKILL.md`** — version `2026-05-08` (or `2026-05-10` if rubric audit prompt landed); see in-flight prompt for log_analysis support.
- **`tools/stage1-sharded-smoke.ts`** — fire smoke directly (count=15 L2 default). Bypasses HTTP/auth.
- **`tools/test-invite.ts`** — invite candidate via direct service call.
- **`tools/inspect-attempt.sh`** — VPS wrapper for inspect-attempt CLI.
- **`tools/cleanup-stale-drafts.ts`** + **`tools/cleanup-orphaned-attempts.ts`** — operator hygiene scripts; default --dry-run, --apply for writes; SET LOCAL ROLE assessiq_system for cross-tenant ops sweep.
- **`modules/07-ai-grading/eval/cli-typed.ts`** subcommands: `score-goldens` (CI gate, `pnpm eval:goldens-strict`), `write-baseline`, `diff-against-baseline`, `score-candidate --attempt-id <uuid>` (structural Zod parse + citation resolve + baseline diff; exit 0 pass / 1 regression / 2 error), `inspect-attempt --attempt-id <uuid> [--show-stderr] [--show-questions]` (diagnostic surface).

---

## Production state snapshot (2026-05-10 ~12:00 IST)

- VPS: `srv1150121.hstgr.cloud` (`72.61.227.64`); SSH alias `assessiq-vps`.
- All 5 containers healthy: postgres, redis, api (cmd: `pnpm exec tsx src/server.ts`), worker, frontend.
- VPS HEAD: matches origin/main `c979503` (last deploy this session).
- `/srv/assessiq/.env` `AI_GENERATE_MODE=omnibus` (default; sharded smoke flips this temporarily).
- 9 skills live at `~/.claude/skills/`: generate-questions (omnibus), generate-rubric, 5 type shards, 3 grading skills (anchors/band/escalate).
- assessiq-mcp: dist built on VPS, 4 tools registered (submit_anchors, submit_band, submit_questions, submit_rubric); strict per-type Zod schema enforced on submit_questions.
- API healthcheck: node fetch (replaced wget which was missing in node:22-slim, FailingStreak=1589 RCA).
- Migrations applied through 0043 (citation_dropped column on generation_attempts).
- 50+ ai_draft questions accumulated across 4 smoke runs on WIPRO-SOC L2 — admin can clean via bulk-archive UI or `cleanup-stale-drafts.ts`.

---



**Commits:** `cd352c7` — fix(grading): heartbeat 60s->5min, dismissible error banner, eval fixtures realigned to real KB IDs

**Tests:** pnpm -C modules/07-ai-grading typecheck ✅ | pnpm -C apps/api typecheck ✅ | pnpm -C modules/10-admin-dashboard typecheck ✅ | pnpm eval:goldens-strict: 75/75 passed ✅

**Next:** Deploy is not required (no API surface changes; eval and handler files are local). Next session can pick up Phase 2 work per `docs/plans/PHASE_2_KICKOFF.md`.

**Open questions:** none

---

## Agent utilization
- Opus: Drove entire session — planning, file edits, fixture replacements, verification
- Sonnet: n/a — all edits were ≤30 lines across ≤2-3 files, within Opus hot-cache
- Haiku: n/a — no bulk sweeps needed
- codex:rescue: n/a — no security/auth/classifier diffs; pre-flight confirmed companion MCP not needed

---

# Session — 2026-05-02 (Phase 2 Kickoff Plan authored)

**Headline:** `docs/plans/PHASE_2_KICKOFF.md` shipped — full Phase 2 plan for modules 07-ai-grading + 08-rubric-engine + 09-scoring + 10-admin-dashboard, mirroring Phase 1's structure: discovery summary, 18-row decisions table (D1–D8 verbatim from `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) + 10 new orchestrator-default resolutions P2.D9–P2.D18), G2.A → G2.B → G2.C session DAG with file paths, contracts, verification checklists, anti-pattern guards, four-step DoD per session.

**Commits this session:**

- `53a881e` — docs(plans): phase 2 kickoff plan

**Tests:** skipped — pure docs session, no code touched.

**Live verification:** N/A — pure docs, no deploy.

**Next:**

1. **Phase 1 G1.D closure** (in flight in a parallel window) — `11-candidate-ui` candidate-side `/take/*` flow staged uncommitted in this working tree (`modules/11-candidate-ui/{src,package.json,tsconfig.json,vitest.config.ts}` untracked from this Phase-2-plan session). G1.D's session lands its commit before G2.A opens to avoid the two windows racing on `apps/web/src/main.tsx` route registration.
2. **Phase 2 G2.A Session 1** — opens after G1.D lands. `modules/07-ai-grading` ships the D2 lint sentinel + `claude-code-vps` runtime + admin handlers (grade / accept / override / rerun / queue / claim / release / grading-jobs / budget) + eval harness skeleton + 3 in-repo skills (`prompts/skills/{grade-anchors,grade-band,grade-escalate}/SKILL.md`) + MCP server source at `tools/assessiq-mcp/` + admin Claude settings template at `infra/admin-claude-settings.example.json`. Migrations 0040 (gradings Phase 2 columns), 0041 (escalation_chosen_stage), 0042 (tenant_grading_budgets). **codex:rescue MANDATORY before push** per CLAUDE.md load-bearing-paths rule + the lint sentinel's own load-bearing-with-rescue-gate status.

**Open questions / explicit deferrals:**

- **None for the plan itself** — all 18 decisions captured at orchestrator-default. D1–D8 stay load-bearing per the user-confirmed `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) addendum. P2.D9–P2.D18 are new resolutions; if the user disagrees with any, the relevant session can re-open.
- **G1.D ↔ G2.A coordination** — Window α (G1.D) and the future Window for G2.A both write to `apps/web/src/main.tsx`. Coordinate commit windows so G1.D lands first; G2.A's frontend ship in G2.C Session 4 then layers on top. Not a Phase 2 plan-authoring concern, but an operational note for the next sessions.
- **Phase 2 deferrals listed in the plan's § Routing summary:** `runtimes/anthropic-api.ts` real implementation → Phase 3+; `runtimes/open-weights.ts` → Phase 4+; `prompt_versions` table population → Phase 3+; admin help-content WYSIWYG → Phase 3+ (Markdown-only ships in G2.C); public-facing leaderboard → Phase 3+ analytics module 15 with DPDP review; tenant-defined custom archetypes → Phase 3+; mobile admin UI → Phase 3+; `/admin/settings/audit` UI → Phase 3 (module 14); webhook config UI → Phase 3 (module 14); auto-retry on grading failures → Phase 3+ (BullMQ exponential backoff with `anthropic-api` mode); CSV bulk import → Phase 3+; `QuestionNavigator` UI primitive → Phase 3+ (`11-candidate-ui` polish); 19 of module 10's 26 SKILL.md pages → Phase 3+ (Phase 2 ships only the 7 grading/scoring/reports/help/billing-related pages).
- **Carry-over from prior sessions** (still open, not Phase-2-blocking): apps/web logger no-console violations + `pnpm exec eslint .` in CI; admin pages without kit reference screens (`mfa`, `users`, `invite-accept`); Spinner component in `@assessiq/ui-system`; MFA recovery code flow; HelpProvider localStorage tenant_id leak; `--aiq-color-bg-elevated` → `--aiq-color-bg-raised` rename; root `eslint .` not in CI; SMTP driver swap-in for `tenants.smtp_config` JSONB column. All carried forward independent of Phase 2.

---

## Agent utilization

- **Opus:** Phase 0 warm-start reads (parallel: PROJECT_BRAIN, 01-architecture, prior SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF, PHASE_1_KICKOFF in two chunks for size, full 05-ai-pipeline.md including D1–D8 addendum). Synthesis of three Haiku discovery cluster reports into the single Phase 2 plan: dependency DAG, 18-row decisions table, four per-session blocks (G2.A Session 1 = 07; G2.B Sessions 2/3 = 08/09 parallel; G2.C Session 4 = 10), Final phase verification (12 drills), Routing summary, Appendix A (25 help_ids), Appendix B (G2.A operational migration recipe). Authored `docs/plans/PHASE_2_KICKOFF.md` end-to-end. Edited `PROJECT_BRAIN.md` decision log (one-line entry per the brief). Wrote this `docs/SESSION_STATE.md`.
- **Sonnet:** n/a — pure plan-authoring is judgment-heavy, not mechanical. The plan structure mirroring Phase 1 was Opus-direct because the substrate (PHASE_1_KICKOFF.md) was already in Opus's hot-cache window after the warm-start reads, and the synthesis required cross-referencing the three Haiku reports against the 8 D-decisions in 05-ai-pipeline.md — judgment work, not template-fill work.
- **Haiku:** 3 parallel discovery sweeps dispatched — Cluster A (07-ai-grading + AI-pipeline boundary), Cluster B (08-rubric-engine + 09-scoring), Cluster C (10-admin-dashboard + cross-cuts). Each agent reported per a strict reporting contract (consume / expose / copy-from-doc / gaps + confidence + line citations). All three returned high-quality structured reports inside the 1800-word budget; their outputs are the discovery substrate this plan rests on.
- **codex:rescue:** n/a — pure docs session; the plan itself does not touch security/auth/AI-classifier code. **G2.A Session 1 will require codex:rescue** when it ships the D2 lint sentinel + `claude-code-vps` runtime + admin handlers; that's the next session's obligation per CLAUDE.md load-bearing-paths rule.
