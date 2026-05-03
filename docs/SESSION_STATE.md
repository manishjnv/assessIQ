# Session — 2026-05-03 (G2.C 10-admin-dashboard frontend live + 2 RCA entries)

**Headline:** G2.C `10-admin-dashboard` frontend is **LIVE on production** (`https://assessiq.automateedge.cloud/admin/dashboard` returns the new SPA bundle `index-CqLC_h7V.js`). Earlier feat shipped at `18fece2` + `b3601c0` (type-fix) + `4807ba5` (Dockerfile module-list update); today this session diagnosed + unblocked a multi-hour stalled deploy by patching `Dockerfile.dockerignore` (committed at `e1e27bf`) and bypassing the rsync grind via a 1.6 MB `git archive | scp | tar | docker build` path. **Phase 2 G2.C = formally closed.** Two new RCA entries appended capturing the dockerignore-drift bug and the architectural debt of `/srv/assessiq` not being a git clone.

**Commits referenced (all on `origin/main`):**

- `18fece2` — feat(dashboard/ui): phase-3 admin-dashboard pages + ui-system primitives (G3.A/G3.B) [G2.C feat — 35 files, +4404; modules/10-admin-dashboard/ + new 17-ui-system primitives Drawer/Modal/ScoreRing/Sidebar/Sparkline/StatCard/Table]
- `b3601c0` — fix(admin-dashboard): fix type errors, tests pass 17/17, vite builds 347 modules
- `4807ba5` — fix(frontend): update Dockerfile with admin-dashboard modules + skip tsc for docker build [Sonnet's Dockerfile fix; added 8 new module COPY lines but missed the matching dockerignore update]
- `72b6798` — docs(deploy): note G3.C 15-analytics containers live on VPS

**This session's commits:**

- `e1e27bf` — fix(infra): unexclude G2.C modules from frontend Dockerfile.dockerignore [Dockerfile.dockerignore — 8 module excludes commented out with `# UNEXCLUDED for G2.C` prefix; root cause for the multi-hour deploy stall]
- `<this-handoff-sha>` — docs(session): G2.C closure handoff + 2 RCA entries (dockerignore drift + git-clone-on-VPS debt)

**Tests:** 17/17 admin-dashboard tests pass (`b3601c0`); workspace typecheck clean; vite builds 347 modules in 3.91s; assessiq-frontend container healthy after restart with the new bundle.

**Live verification (`https://assessiq.automateedge.cloud`, 2026-05-03 ~16:13 UTC):**

- `assessiq-frontend` container `Up 10 seconds (healthy)` after the manual rebuild
- `GET /admin/login` → 200, 1690b SPA shell
- `GET /admin/dashboard` (NEW G2.C route) → 200, 1690b SPA shell + new JS bundle hydrates client-side
- `GET /admin/attempts` (NEW G2.C route) → 200, 1690b
- New JS bundle name confirmed: `index-CqLC_h7V.js` (replaces the prior 10-hour-old bundle)

**Next:**

1. **Browser-level smoke (you, 1 minute manual):** open `/admin/dashboard` in your existing SSO session → confirm the page renders without a JS error / blank screen / hydration failure. The HTTP 200 + correct bundle name proves the build + serve layer works; doesn't prove client-side render works. If this fails, file a follow-up RCA + open a small fix session.
2. **Phase 4 `12-embed-sdk`** is the only substantive remaining task. Sonnet 4.6 + multi-model orchestration (Haiku discovery + Copilot GPT-5 substituting for codex:rescue) is the agreed approach per the Phase 4 prompt drafted earlier; pre-flight decisions frozen at `b7dfaa9`.
3. **Architectural debt — convert `/srv/assessiq` to a git clone.** Documented in the new RCA entry below; ~30 min Sonnet session whenever scheduled. Eliminates rsync entirely; future deploys become `git pull && docker compose -f infra/docker-compose.yml up -d --build <service>`.

**Open questions / explicit deferrals:**

- **G2.C `docs(session)` handoff debt** is closed by this session — the original Sonnet G2.C session never landed its own DoD-step-4 handoff, but this session's overwrite captures the closure including the deploy unblock.
- **The other Sonnet/Copilot session that was rsync-stalled** can be safely cancelled (close the Copilot tab); its eventual rebuild would produce the same image, no corruption risk.
- **Browser-level G2.C smoke** is YOUR 1-minute task per Next #1.
- **Git-clone-on-VPS conversion** deferred to a dedicated session; documented in RCA 2.
- **Two new lint guards proposed** in RCA 1 + 2 prevention sections (Dockerfile-vs-dockerignore drift detector + `/srv/assessiq/.git` health check); Phase 4+ tooling task.

---

## What this session did

| Step | What | Time | SHA |
| --- | --- | --- | --- |
| 1 | Diagnosed VPS state — confirmed no active rsync receiver despite Sonnet UI showing "Processing" | 30s | — |
| 2 | Found `/srv/assessiq` is not a git clone — every deploy has been rsync-from-local since Phase 0 | 30s | RCA 2 |
| 3 | Killed the dead rsync (no-op — already silent on VPS); built source tarball via `git archive HEAD` (1.6 MB) | 5s | — |
| 4 | `scp` tarball to VPS in <2s; `tar -xzf` overwrote source while preserving `node_modules`/`.env`/`secrets/` | 2s | — |
| 5 | `docker compose build assessiq-frontend` failed at COPY step for `06-attempt-engine` ("not found"); subsequent investigation revealed 8 modules failing the same way | 4s | — |
| 6 | BuildKit cache prune didn't help; legacy `DOCKER_BUILDKIT=0` builder failed differently (apps/web/package.json missing) → revealed root `.dockerignore` excludes `apps/web` (correct for api build, wrong for frontend) | 2 min | — |
| 7 | Found `infra/docker/assessiq-frontend/Dockerfile.dockerignore` (BuildKit per-Dockerfile override) — its module-exclude list was stale, missing the 8 modules G2.C added to apps/web's transitive closure | 1 min | RCA 1 |
| 8 | Patched VPS `Dockerfile.dockerignore` in place (commented out 8 stale excludes) | 5s | — |
| 9 | Rebuilt assessiq-frontend on VPS — succeeded in 32s (vs the multi-hour rsync grind) | 32s | — |
| 10 | Restarted container, smoke-tested 3 routes, confirmed new JS bundle `index-CqLC_h7V.js` | 30s | — |
| 11 | Patched local `Dockerfile.dockerignore` the same way; committed + pushed | 30s | `e1e27bf` |
| 12 | Cleaned up VPS `.bak` file | 2s | — |
| 13 | Appended 2 RCA entries (dockerignore drift + git-clone-on-VPS debt); wrote this handoff | this commit | this SHA |

Total wall-clock from "do it now" → frontend live: **~5 minutes**. The Sonnet session it bypassed was at hour N+ on the rsync alone.

---

## Why the deploy stalled

Three compounding bugs surfaced by today's incident (all captured in RCA 1 + RCA 2):

1. **`Dockerfile.dockerignore` drift** (RCA 1) — Sonnet's `4807ba5` added 8 new `COPY modules/0X-` lines to the Dockerfile when G2.C made apps/web depend on them transitively, but didn't remove the matching exclude lines from `Dockerfile.dockerignore`. BuildKit honored the excludes; modules became invisible in the build context. This was the deploy-blocking bug.
2. **`/srv/assessiq` is not a git clone** (RCA 2) — Architectural debt from Phase 0 G0.A bootstrap. Every deploy has been rsync-from-local. Today the rsync target was multi-GB (source + node_modules), making the deploy multi-hour even before the Dockerfile bug was hit. The deploy-architecture fix (git-clone-on-VPS) eliminates this entire class of slow deploy.
3. **node_modules accidentally on the rsync wire** — Local Sonnet session's `pnpm install` populated 14+ workspace `node_modules` dirs locally; the rsync had no exclude for them; pnpm-lock-bleed RCA pattern (G1.A `f0b5ad9`) recurred. Fixed in passing by today's `git archive` approach which excludes everything not tracked in git.

---

## Agent utilization

- **Opus 4.7:** This session's primary orchestrator (user explicitly switched here from a stalled Copilot session). Diagnosed the VPS state, traced the dockerignore drift, executed the manual deploy, committed the fix, wrote 2 RCA entries + this handoff. Total: ~5 min wall-clock.
- **Sonnet 4.6:** n/a in this session. The original G2.C feat work (18fece2 + b3601c0 + 4807ba5) was Sonnet 4.6 in a parallel Copilot window earlier today; that work shipped clean except for the deploy step which is what this session unblocked.
- **Haiku 4.5:** n/a — small targeted diagnosis, no bulk sweeps warranted.
- **codex:rescue:** n/a — bug fix on non-load-bearing infra (`Dockerfile.dockerignore` is build-config, not runtime auth/classifier surface). Self-review covered: the patched dockerignore now matches the Dockerfile's COPY list (verified via `grep -E "COPY modules" Dockerfile` vs `grep -E "modules/0[3-9]|modules/10" Dockerfile.dockerignore`).
