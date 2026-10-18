# 02. Time optimizations (built 2026-10-18)

All items below are on `main` and in use. Measured on the owner's setup.

| Item | Before | After | How to use |
| --- | --- | --- | --- |
| API image build on the VPS | about 25 minutes | 37 seconds | Automatic. The Dockerfile keys the install layer on package manifests only, uses a BuildKit pnpm cache, and `COPY --chown`. See `infra/docker/assessiq-api/Dockerfile`. |
| CI duration | about 15 minutes | 9 minutes 38 seconds | The `e2e` job runs in parallel with `quality` (no `needs:`). A green workflow still needs both jobs green. |
| Deploy | manual steps, error prone | frontend in 2 min 3 s; API and worker in 1 min 4 s | `bash tools/deploy.sh --dry-run`, then `--yes --services "assessiq-api assessiq-frontend"`. |
| Post-deploy sweep | a Haiku agent (about 85k tokens) | a script (0 tokens) | Runs inside `deploy.sh`; or `bash tools/post-deploy-sweep.sh`. |
| Lint and typecheck before push | CI found errors 10 minutes later | about 5 seconds when clean, 1 to 8 minutes with changes | `pnpm verify`. A stamp file lets the push hook skip a repeat. |
| Lockfile guard | a blank admin page lived 17 hours | CI fails at once | `tools/__tests__/single-router-copy.test.ts` fails when two router versions exist. |

## What `tools/deploy.sh` does (7 steps, fails before any restart)

1. Local preflight: HEAD equals `origin/main`, CI for that commit is `success`.
2. VPS preflight: `/srv/assessiq` is a git clone with no tracked changes.
3. Pull with `--ff-only`.
4. Drift gate: database-only migrations must be on the known allowlist; lists pending files.
5. Apply pending migrations, one file at a time, with a checksum row. Re-applies the help seed (safe: `ON CONFLICT DO NOTHING`).
6. Build the services on the VPS; checks `BUILD_EXIT=0` before going on.
7. Recreate only the named services (`--no-deps --force-recreate`), wait for healthy, run the sweep.

Known gap: migrations are not wrapped in one transaction. A failed file stops the deploy and leaves partial changes. Prefer idempotent `DO $$ ... IF NOT EXISTS` migrations (the project style).

## Still open (see ROADMAP)

- Z-47: run the signed-in smoke spec before each deploy (`tools/verify-signed-in.sh`).
- A worktree setup script for build agents (merge main, install, assigned numbers).
