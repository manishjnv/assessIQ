# 05. Tools in `tools/` and `package.json`

| Command | Purpose | Notes |
| --- | --- | --- |
| `pnpm verify` | Cached eslint plus scoped typecheck of changed packages and dependents; writes a verify stamp the push hook reads | `pnpm verify:all` for the full run. About 5 seconds when clean. |
| `pnpm lint` | `eslint .` exactly as CI runs it | One error fails CI and hides the test step. |
| `bash tools/deploy.sh --dry-run` | Rehearse a deploy: preflight, drift gate, would-apply list. Changes nothing except `git fetch` on the VPS | Needs CI success on HEAD and HEAD equal to `origin/main`. |
| `bash tools/deploy.sh --yes --services "assessiq-api assessiq-frontend"` | Real deploy; the worker is added with the API | Services must match `^assessiq-[a-z-]+$`. `--skip-ci-check` and `--no-sweep` exist; avoid them. |
| `bash tools/post-deploy-sweep.sh` | Live checks: `/api/ready`, public pages 200, beacon on `/` and absent on `/admin/login`, `/take`, `/candidate/login`, new routes 401, no level-50 log lines, containers healthy | Browser User-Agent needed for the beacon check. |
| `bash tools/gemini.sh "<prompt>"` | Gemini read-only digest | See `04-model-routing.md`. |
| `bash tools/verify-signed-in.sh` | Signed-in smoke gate (Z-47), if present | Needs the local e2e stack. |
| `node tools/lint-docs.mjs` | Docs markdown lint (strict from 2026-10-29) | |
| `tools/next-brief.mjs`, `tools/roadmap-recount.mjs`, `tools/next-migration.mjs`, `tools/routing-report.mjs`, `tools/codex-review.sh` | Planned in `08-token-tooling-plan.md` | Check `ls tools` before using. |

## Local e2e stack

`apps/web/e2e/README.md` and `apps/web/e2e/local-stack.sh`. The session minter is a dev tool; never enable it on production.

## Production access

- `ssh assessiq-vps` (alias in the owner's ssh config). Repo clone at `/srv/assessiq`. Never `docker system prune`, never touch non-`assessiq-*` containers.
- Cloudflare: see `06-traps.md`. The API token is locked to the VPS IP.
