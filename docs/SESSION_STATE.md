# Session — 2026-05-03 (Multi-deploy unblock: G2.C frontend live + G3.A migration applied + G3.D dep-fix loop closed)

**Headline:** Three sequential deploy-blockers diagnosed + unblocked across G2.C / G3.A / G3.D in this Opus 4.7 main session, after a Sonnet/Copilot session burned hours on shell-quoting and rsync grind. (1) G2.C frontend stalled on stale `Dockerfile.dockerignore` excluding modules in the new admin-dashboard transitive closure → fixed at `e1e27bf`. (2) G3.A `audit_log` migration was never actually applied to prod despite `43c0e45`'s "shipped" status — code-only deploy hid the operational gap. The Sonnet session caught this and applied `0050_audit_log.sql` directly via psql; verified RLS shape (SELECT+INSERT for `assessiq_app`, no UPDATE/DELETE, two-policy template). (3) G3.D restart-loop on `ERR_MODULE_NOT_FOUND: @assessiq/audit-log` because `02-tenancy` + `13-notifications` package.jsons never declared the dep — fixed at `81da5db`. **All 5 containers healthy, /api/health returns 200, worker cron jobs firing every 30s with structured JSONL.** Phase 2 + Phase 3 are now both formally live on prod.

**Commits referenced (all on `origin/main`):**

- `43c0e45` — feat(audit-log): G3.A core (migration, write service, redact, query/export, 9 admin write hooks across 4 modules) — shipped earlier today; migration apply step was missed (operational gap caught by today's session)
- `639cb22` — revert(deps): removed premature `@assessiq/audit-log` dep from 05-lifecycle — was correct for that module but the vague subject led to an over-correction interpretation (see RCA entry)
- `73ad0b2` — fix(lifecycle/deps): the original audit-log dep RCA + regression test
- `cae6d37` — feat(notifications): G3.B email/webhook/in-app
- `ce041e3` — feat(analytics): G3.C MV + 6 routes + exports
- `18fece2` — feat(dashboard/ui): G2.C admin-dashboard pages + ui-system primitives
- `b3601c0` — fix(admin-dashboard): type errors + tests
- `4807ba5` — fix(frontend): Dockerfile additions for admin-dashboard module COPY (but NOT the matching dockerignore update — that was the bug)

**This session's commits:**

- `e1e27bf` — fix(infra): unexclude G2.C modules from frontend Dockerfile.dockerignore (G2.C unblock)
- `ea31735` — docs(session): G2.C closure handoff + 2 RCA entries (dockerignore drift + git-clone-on-VPS debt)
- `8fff574` — fix(api): add @assessiq/audit-log to apps/api deps (Sonnet's partial dep fix; necessary but not sufficient)
- `81da5db` — fix(deps): declare @assessiq/audit-log in 02-tenancy + 13-notifications (the actual sufficient fix)
- `<this-handoff-sha>` — docs(session): multi-deploy unblock handoff + recurring missing-dep RCA entry

**Tests:** 17/17 admin-dashboard pass; 23/23 analytics pass; lifecycle 70/70 pass; notifications 39/39 pass; audit-log 12/12 pass (per `43c0e45`); workspace typecheck clean across all packages. No new tests in this close-out session.

**Live verification (`https://assessiq.automateedge.cloud`, 2026-05-03 ~16:48 UTC, after `81da5db` deploy):**

| Container | Status |
| --- | --- |
| `assessiq-api` | `Up About a minute (healthy)` — passing /api/health every 15s |
| `assessiq-worker` | `Up` — cron jobs `assessment-boundary-cron` (40ms) + `attempt-timer-sweep` (6-50ms) firing every 30s, structured JSONL emitting to `/var/log/assessiq/worker.log` |
| `assessiq-frontend` | `Up 34m (healthy)` — G2.C bundle `index-CqLC_h7V.js` serving |
| `assessiq-redis` | `Up 2 days (healthy)` |
| `assessiq-postgres` | `Up 2 days (healthy)` |

| Endpoint | Result |
| --- | --- |
| `GET /api/health` | **200**, 0.06s |
| `GET /admin/login` | 200, SPA shell + new bundle hydrates |
| `GET /admin/dashboard` (G2.C) | 200, SPA shell |
| `GET /admin/attempts` (G2.C) | 200, SPA shell |
| `audit_log` table query (as `assessiq_system`) | 0 rows, table accessible — first row will land when an admin triggers a hooked action |

## Three blockers, three fixes

### Blocker 1 — G2.C frontend deploy stalled multi-hours on rsync + dockerignore drift

**Root cause:** Sonnet's `4807ba5` Dockerfile fix added 8 module COPY lines for the admin-dashboard transitive closure, but the matching exclude lines in `infra/docker/assessiq-frontend/Dockerfile.dockerignore` were not removed. BuildKit honored the excludes → modules invisible in the build context → `failed to compute cache key: /modules/06-attempt-engine: not found`. Compounded by `/srv/assessiq` not being a git clone (every deploy is rsync-from-local), so the failed build was preceded by a multi-hour rsync of `node_modules` (~949 MB, ~30 KB/s per file).

**Fix:** Patched `Dockerfile.dockerignore` on VPS in-place (commented out 8 stale module excludes); rebuilt assessiq-frontend in 32s; restarted; smoke-tested 3 routes. Then committed the same patch locally + pushed (`e1e27bf`). Replaced the rsync flow with `git archive HEAD | scp | tar -xzf | docker build` (1.6 MB tarball, 2s scp, 32s build). Total wall-clock from "do it now" → live: **~5 minutes**.

**RCA:** Captured in `ea31735` as 2 entries — (1) Dockerfile/Dockerignore drift detection (`tools/lint-dockerignore-vs-copy.ts` proposed), (2) Architectural debt of `/srv/assessiq` not being a git clone (~30 min Sonnet conversion task documented).

### Blocker 2 — G3.A `audit_log` table never applied to prod

**Root cause:** `43c0e45 feat(audit-log)` shipped the code (migration file `0050_audit_log.sql` + service + 9 hook sites) but the deploy step that should have run `tools/migrate.ts up` was not actually executed in the prior G3.A session. The G3.A handoff implicitly assumed the migration was applied (the SKILL.md status was marked live), but the table didn't exist on prod. Hidden until today's G3.D session ran a `SELECT … FROM audit_log` and got `relation "audit_log" does not exist`.

**Fix:** The Sonnet G3.D session diagnosed it correctly (after navigating tsx hostname resolution + assessiq_app insufficient_privilege errors trying to use the migrate.ts runner) and applied `0050_audit_log.sql` directly via `docker exec assessiq-postgres psql -U assessiq -d assessiq -f -`. Verified the resulting RLS shape: SELECT + INSERT policies present, UPDATE + DELETE policies ABSENT (Postgres denies by default per the load-bearing append-only invariant), `assessiq_app` has only INSERT + SELECT, `assessiq_system` has full access for archive job. Two indexes + `tenant_settings.audit_retention_years` column also confirmed.

**RCA-adjacent:** Worth a future RCA entry if it recurs. For now, the fix-forward is documented inline in this handoff. Future-session prevention: every `feat(*)` commit that adds a `migrations/*.sql` file should be paired with a deploy script step that runs the migration runner; CI should include a "migrations applied" check before marking deploy success.

### Blocker 3 — assessiq-api + assessiq-worker restart-loop on missing `@assessiq/audit-log` dep declarations

**Root cause:** `modules/02-tenancy/src/service.ts` and `modules/13-notifications/src/*` both import `@assessiq/audit-log`, but neither package.json declared the dep. pnpm's `--filter '@assessiq/api...'` selective install in the Docker builder honors only declared workspace deps; undeclared imports survive `pnpm typecheck` (TypeScript resolves across the workspace virtual store regardless of declarations) but FAIL at runtime when Node's ESM resolver looks for the package in the per-module `node_modules/`. Earlier today's `8fff574 fix(api)` patched apps/api's package.json (necessary but not sufficient — the actual import sites were in 02-tenancy + 13-notifications). `639cb22`'s revert had legitimately removed the stale lifecycle dep but the vague subject ("premature dep declarations") was over-generalized — it should NOT have inhibited the legitimate declarations needed in tenancy + notifications.

**Fix:** Commit `81da5db` — added `"@assessiq/audit-log": "workspace:*"` to both `modules/02-tenancy/package.json` and `modules/13-notifications/package.json`; ran `pnpm install --no-frozen-lockfile` (4.5s; 6 lockfile lines added). Verified locally that `node_modules/@assessiq/audit-log` symlinks resolve to `modules/14-audit-log/` in both modules. Redeployed via git-archive flow; assessiq-api + assessiq-worker rebuilt in 40s, both came up healthy on first try.

**RCA:** This is the **third** documented instance of "module imports `@assessiq/X` without declaring it" in this project. New entry appended to `docs/RCA_LOG.md` 2026-05-03 promotes `tools/lint-cross-module-deps.ts` from "Phase 4+ tooling task" to immediate next-session priority. Lint catches the class in 50ms; today's incident lost ~3 hours across two sessions.

## Next

1. **`tools/lint-cross-module-deps.ts`** — promoted to immediate next-session priority by today's RCA. ~30 min Sonnet 4.6. Catches the entire missing-dep-declaration class.
2. **Phase 4 `12-embed-sdk`** — implementation. Two new untracked migrations on disk (`modules/12-embed-sdk/migrations/0070_embed_origins.sql`, `0071_tenants_embed_metadata.sql`) suggest a parallel session is in flight; coordinate before opening a fresh Phase 4 session. Multi-model orchestration prompt is ready (Sonnet 4.6 primary + Haiku discovery + Copilot GPT-5 substitute for codex:rescue).
3. **Convert `/srv/assessiq` to a git clone** (per `ea31735` RCA entry). ~30 min Sonnet. Eliminates the rsync grind class permanently; future deploys become `git pull && docker compose -f infra/docker-compose.yml up -d --build <service>`.
4. **`tools/lint-dockerignore-vs-copy.ts`** (per `ea31735` RCA). ~20 min Sonnet. Catches the G2.C-class drift bug.
5. **Browser-level G2.C smoke** (manual, you, 1 min) — confirm `/admin/dashboard` actually renders client-side.

## Open questions / explicit deferrals

- **Two untracked Phase 4 migrations on disk** (`0070_embed_origins.sql`, `0071_tenants_embed_metadata.sql`) — left for the Phase 4 session that's apparently in flight in another window. Did NOT include in this handoff's commit.
- **G3.A operational-gap RCA** — should be written up properly. Deferred since the immediate fix-forward (apply migration directly) is already documented above; a dedicated RCA entry would be polish.
- **G3.D scope clarification** — the Sonnet session that ran today described "9 hook sites across 4 modules + 12 tests" but git diff showed it only contributed `8fff574` (4 lines, dep fix only). Whatever G3.D audit-hook expansion was supposed to land either was already in `43c0e45` (audit() calls in 01-auth/totp + 02-tenancy/service + 07-ai-grading/admin-override are already on main, blame-untraced this session) or never got committed.
- **`639cb22`'s vague subject** caused the over-correction. Consider amending CLAUDE.md hard rule #9 § detail-level requirements to also apply to revert commits: must enumerate "what was reverted, what was NOT reverted, why each."

---

## Agent utilization

- **Opus 4.7 (this session, main):** orchestration; G2.C + G3.A + G3.D deploy unblock end-to-end; 4 commits authored (`e1e27bf`, `ea31735`, `81da5db`, this handoff); 2 RCA entries appended; multiple ssh-driven psql + docker investigations on the VPS. Total wall-clock: ~30 minutes spread across the session.
- **Sonnet 4.6 (Copilot, parallel):** G3.D attempt — diagnosed audit_log table absent + applied `0050_audit_log.sql` via psql; diagnosed missing apps/api dep + shipped `8fff574`. Spent significant time on PowerShell+bash heredoc quoting before being interrupted; remaining work (the dep declarations in 02-tenancy + 13-notifications) was completed by Opus in this session. The session's diagnostic work was high-quality; its shell-execution mechanics were brittle.
- **Haiku 4.5:** n/a — small targeted operational session, no bulk sweeps warranted.
- **codex:rescue:** n/a — bug fixes on dep declarations + dockerignore drift + missing-migration are infrastructure/configuration, not load-bearing runtime code requiring adversarial review. Self-reviewed against existing RCA patterns; verified via live container health + endpoint responses.
