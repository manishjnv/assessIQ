# 05. Tools in `tools/` and `package.json`

| Command | Purpose | Notes |
| --- | --- | --- |
| `pnpm verify` | Cached eslint plus scoped typecheck of changed packages and dependents; writes a verify stamp the push hook reads | `pnpm verify:all` for the full run. About 5 seconds when clean. |
| `pnpm lint` | `eslint .` exactly as CI runs it | One error fails CI and hides the test step. |
| `bash tools/deploy.sh --dry-run` | Rehearse a deploy: preflight, drift gate, would-apply list. Changes nothing except `git fetch` on the VPS | Needs CI success on HEAD and on the last code commit, and HEAD equal to `origin/main`. |
| `bash tools/deploy.sh --yes --services "assessiq-api assessiq-frontend"` | Real deploy; the worker is added with the API | Services must match `^assessiq-[a-z-]+$`. `--skip-ci-check` and `--no-sweep` exist; avoid them. |
| `bash tools/post-deploy-sweep.sh` | Live checks: `/api/ready`, public pages 200, beacon on `/` and absent on `/admin/login`, `/take`, `/candidate/login`, new routes 401, no level-50 log lines, containers healthy | Browser User-Agent needed for the beacon check. |
| `bash tools/gemini.sh "<prompt>"` | Gemini read-only digest | See `04-model-routing.md`. |
| `bash tools/verify-signed-in.sh` | Signed-in smoke gate (Z-47), if present | Needs the local e2e stack. |
| `node tools/lint-docs.mjs` | Docs markdown lint (strict from 2026-10-29) | |
| `bash tools/wt-setup.sh <name> [--from origin/main]` | Create a registered worktree with `pnpm install` | About 91 to 99 seconds. Use it for load-bearing writes. |
| `bash tools/wt-clean.sh <name> [--force]` | Remove a registered worktree | Refuses a dirty or ahead tree unless `--force`. `--force` writes a patch and a tar backup first. Never deletes unregistered folders. |
| CI job `changes` (`.github/workflows/ci.yml`) | Classifies the commit as docs-only or code | Docs-only means `docs/`, `*.md` and `.vale/` only. An error or an empty diff counts as code. |
| CI job `docs-check` | Runs the doc anchor, skill mount, docs lint, deploy procedure and coverage checks | Runs on every commit, docs-only included. About 30 seconds. |
| CI job `ci-ok` | One aggregate check for branch status | Fails on failure or cancel. Passes when heavy jobs skip on a docs-only commit. |
| `tools/deploy.sh` step 1 (two-commit preflight) | Checks CI success on `HEAD` and on the last code commit | Prints both SHAs. A docs-only `HEAD` deploys against the CI run of the last code change. |
| `node tools/roadmap-recount.mjs [--json]` | Counts Z.2 to Z.6 rows by the status column (closed = starts with the check mark, `closed` or `done`; Z.5 all closed; pointer rows skipped). Compares with Z.7 | Exit 0 same as Z.7, exit 1 different or file missing. Does not edit Z.7. |
| `node tools/next-migration.mjs [--count N]` | Prints the next N free migration numbers (highest `modules/*/migrations` prefix + 1, skipping numbers marked reserved in ROADMAP or SESSION_STATE) | Exit 0. Does not assign numbers to agents. Not wired into `next-brief.mjs`. |
| `node tools/routing-report.mjs [--json] [--since YYYY-MM-DD]` | Rework rate per route; Haiku 5.5 trial counts only runs on or after 2026-10-18 (or `--since`). Prints run count and files | Exit 2 on a bad date. Date comes from the `## Session — date` header. |
| `node tools/next-brief.mjs` | Writes `docs/NEXT.md` | See `08-token-tooling-plan.md`. |
| `tools/codex-review.sh` | Planned (Z-69) | Check `ls tools` before using. |

## Session time helpers (S25)

- `bash tools/test-clean.sh [--dry-run]` removes stale testcontainers and ryuk containers. It touches no other container.
- `bash tools/bg-verify.sh --install` adds a local `post-commit` hook that runs `pnpm verify` in the background. Log: `.claude/verify-bg.log`. It removes the stamp when the tree changes during the run.
- `bash tools/deploy.sh --force-all` builds every service. The default builds only the changed images (see `docs/06-deployment.md`, step 3b).

## Local e2e stack

`apps/web/e2e/README.md` and `apps/web/e2e/local-stack.sh`. The session minter is a dev tool; never enable it on production.

## Production access

- `ssh assessiq-vps` (alias in the owner's ssh config). Repo clone at `/srv/assessiq`. Never `docker system prune`, never touch non-`assessiq-*` containers.
- Cloudflare: see `06-traps.md`. The API token is locked to the VPS IP.
