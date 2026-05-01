# Session — 2026-05-01 (Phase 1 G1.A Session 1 — `04-question-bank` ship)

**Headline:** Phase 1 G1.A `04-question-bank` shipped — 6 migrations + service + 15 admin endpoints + JSON bulk-import + CLI helper live on production. Routes verified at `https://assessiq.automateedge.cloud/api/admin/packs` (401 AUTHN_FAILED without session, was 404 pre-deploy). 50/50 tests green. Sonnet-takeover adversarial review accepted after 2 must-fix items applied.

**Commits this session (mine):** `f0b5ad9` — feat(question-bank): packs + levels + questions + versioning + json import (~6453 LOC, 23 files)

**Other commits landed on `main` while this session was running (not mine — surfaced for context):**

- `67d751e` — feat(auth): MFA_REQUIRED config flag (parallel agent, unrelated to G1.A scope)
- `b09db92` — chore: regenerate pnpm-lock.yaml — drop phantom `yaml@2.8.3` from root (parallel fix that unblocked my G1.A deploy after my f0b5ad9 lockfile included a transitive bleed from the in-progress 16-help-system parallel session)
- `f7b5786` — fix(infra): assessiq-api Dockerfile copies modules/ wholesale, not per-name (parallel fix to a Dockerfile glob issue)

**Tests:** `pnpm --filter @assessiq/question-bank test` = 50/50 pass against `postgres:16-alpine` testcontainer. Workspace `pnpm -r typecheck` clean across all 11 packages I touched (excluding the parallel-session 16-help-system which has its own deps issue — not my session's responsibility). `pnpm tsx tools/lint-rls-policies.ts` = OK (19 migration files scanned, 12 tenant-bearing tables + 4 JOIN-based child tables matched policies). Secrets / ambient-AI greps clean.

**Live verification (`https://assessiq.automateedge.cloud/api`):**

- `GET /api/health` → 200 `{"status":"ok"}` ✅
- `GET /api/admin/packs` (no session) → 401 AUTHN_FAILED ✅ (was 404 before deploy — confirms routes registered + auth chain firing)
- `GET /api/admin/questions` (no session) → 401 AUTHN_FAILED ✅
- 6 question-bank tables on production: `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags` (verified via `psql -c "SELECT tablename FROM pg_tables WHERE tablename IN (...)"`)

**Next:** Open Phase 1 G1.B per [docs/plans/PHASE_1_KICKOFF.md](plans/PHASE_1_KICKOFF.md) — `05-assessment-lifecycle` (Session 3, depends on G1.A's question-bank contracts). The parallel `16-help-system` session (G1.A Session 2) is in-flight in this same workspace; it will either land before or after G1.B opens. The 2 documented Phase 1 follow-ups in `modules/01-auth/SKILL.md` (mapLockout `TOTP_LOCKED` sentinel, `extractClientIp` consolidation) remain deferred to a dedicated 01-auth refactor session.

**Open questions / explicit deferrals:**

- **`pnpm-lock.yaml` bleed in `f0b5ad9`** — DEFERRED-CLEAN, fixed by `b09db92`. My `pnpm install` during the session picked up the parallel-session `modules/16-help-system/package.json` (untracked but on disk in the same workspace), which transitively added `yaml@2.8.3` to the root importer in `pnpm-lock.yaml`. Root `package.json` didn't declare `yaml`, so the build's `--frozen-lockfile` rejected. The parallel agent already landed `b09db92` which regenerated the lockfile cleanly while my session was in progress. **Lesson learned:** when running parallel sessions in the same workspace, `pnpm install` from one session can pollute the other's lockfile via untracked workspace packages. Future fix: each parallel session should run in a `git worktree` per CLAUDE.md global rule (the project overlay says worktrees are for load-bearing writes only — this incident suggests the rule should extend to "any session that runs `pnpm install` while another session has untracked workspace packages on disk").

- **Auto-stash hook captured user's WIP** during the session (per memory `auto-stash-hook.md`). `git stash list` should show the user's in-progress edits to `apps/web/src/pages/admin/login.tsx`, `mfa.tsx`, `users.tsx`, `apps/api/src/server.ts` (help-system route registrations), and `apps/api/package.json` (help-system dep). These were NOT touched by this session — restored to their stashed state, available via `git stash pop` when the user wants.

- **`.claude/settings.json` working-tree modification** — left untouched per the original session prompt ("Do NOT include in any G1.A commit"). Per memory `S105 / 436`: `bypassPermissions` was moved out of the shared settings file into a gitignored `settings.local.json`. The user owns this commit if they want to land it.

- **Phase 0 closure carry-overs (Phase A migration GRANT, Phase B auth nice-to-haves) from the prior session's prompt** — Phase A landed earlier today as `2d70fd1`; Phase B (mapLockout sentinel + extractClientIp consolidation) was never started — deferred to a dedicated 01-auth refactor session per the rationale recorded in `modules/01-auth/SKILL.md` follow-ups.

- **Re-publish UX for question packs** — service currently rejects `published → published`. Decision #21 implies re-publish should re-snapshot. Phase 2 design question.

- **`generateDraft` AI question generation** — 501 stub per decision #11; lands when `07-ai-grading` runtime is in place.

- **`@assessiq/question-bank` typecheck cleanly excludes the parallel-session 16-help-system** — its package was not yet committed when I started typecheck runs, and its missing deps (fastify, @assessiq/core/tenancy direct imports) would have blocked the workspace-wide check. Once the parallel session lands, `pnpm -r typecheck` should be re-validated.

---

## Agent utilization

- **Opus:** Phase 0 warm-start parallel reads (PROJECT_BRAIN, 01-architecture-overview, prior SESSION_STATE, RCA_LOG, PHASE_1_KICKOFF.md G1.A block, modules/04-question-bank/SKILL.md, docs/02-data-model.md question-bank section, modules/00-core + 02-tenancy SKILL.md); WIP-vs-spec gap analysis (4,731-LOC scaffold from `stash@{1}` was nearly complete — only `routes.ts` + `index.ts` + `apps/api` wiring missing, plus the PACK_HAS_ASSESSMENTS test gap from memory 454); routes.ts authoring (15 endpoints, structurally typed against fastify with the same admin-chain DI pattern used by 16-help-system in parallel); index.ts barrel; getPackWithLevels service helper; apps/api wiring; 3-bug fix (publishPack v1-snapshot collision in service.ts, RLS direct-SQL test missing BEGIN/COMMIT, tagsReused == 0 strict assertion vs reality); 2 rescue must-fix items applied (migration 0015 composite FK + 2 FK tests, fastify.d.ts comment correctness); commit + push; deploy (git archive + scp + extract + migration apply + docker compose build + restart + smoke verify); doc updates (SKILL.md Status section, 03-api-contract.md confirm + 3 row extensions, 02-data-model.md JOIN-RLS appendix); this handoff.
- **Sonnet:** **Adversarial-review subagent (sonnet-takeover) — verdict REVISED → ACCEPTED.** Single subagent dispatched after the user explicitly requested "sonet takeover" instead of `codex:rescue`. Self-contained prompt covered 6 critical seams (publishPack atomicity, JOIN-based RLS for child tables, routes.ts body handling + auth, fastify.d.ts triple-declaration drift, archivePack lazy gate, CLI helper BYPASSRLS scope). Returned 2 must-fix items (composite FK gap on `questions(level_id, pack_id)`, fastify.d.ts misleading "stay in sync" comment) + 3 nice-to-haves all explicitly verified as non-issues. Both must-fixes applied in this session before push.
- **Haiku:** n/a — this session had no bulk-read sweeps to delegate. The Phase 0 warm-start parallel reads (~10 docs) stayed in Opus's hot cache; subagent cold-start would have been slower than direct reads. VPS deploy enumeration done by direct ssh from main session in one command (smaller surface than would warrant a Haiku checkmark-table).
- **codex:rescue:** n/a — user explicitly directed "sonnet takeover" mid-session, replacing the rescue invocation with a Sonnet subagent. New memory entry saved (`feedback-sonnet-takeover-on-rescue.md`) so future sessions recognize the pattern. Trigger phrases: "sonnet takeover", "sonet takeover", "let sonnet do it". Verdict logged on the Sonnet line above.
