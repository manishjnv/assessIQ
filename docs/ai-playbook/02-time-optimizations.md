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

Fixed in S24: a migration file without its own BEGIN/COMMIT now runs in one transaction with its `schema_migrations` row (see `docs/06-deployment.md`). A file that needs CONCURRENTLY or VACUUM must be applied by hand.

## Pending time work

See `09-optimization-register.md` (TIME-8 to TIME-13) and `11-time-tooling-plan.md`. Summary: faster CI (Z-55), docs-only commits (Z-56), agent workflow rules (Z-57), worktree per session, flaky test fix, migrations in one transaction. The signed-in smoke gate (Z-47) is built; its injected-failure proof (Z-53) is open.

## S24 results (2026-10-18)

Measured on the owner's setup. Times are wall-clock.

| Item | Before | After | Status |
| --- | --- | --- | --- |
| CI wall time per code push | About 9 to 10 minutes (11 minutes on `0a58c457`) | 6 minutes 50 seconds (run `39137810235`) | Partly done. Target of 5.5 minutes not reached. |
| Docs-only commit wait | About 11 minutes (full CI run) | 37 seconds (`fb2cd882`) | Done. Heavy jobs skip. |
| Deploy preflight | HEAD CI had to pass; a docs-only HEAD waited for a full run | CI checked on HEAD and on the last code commit | Done. Dry run on `fb2cd88` passed. |
| Worktree setup | Manual steps | 91 to 99 seconds with `pnpm install`; `pnpm verify` about 35 seconds | Done (`tools/wt-setup.sh`, `tools/wt-clean.sh`). |
| Migration apply | One file at a time; a failed file left partial changes | One transaction per file that has no transaction control of its own | Done. Dry run on the VPS not run yet (needs ssh). |
| Flaky test | Intermittent red CI | Fixed (`05193ac1`) | Done. |

CI job times in run `39137810235`:

- `changes`: 4 seconds.
- `docs-check`: 30 seconds.
- `quality`: 1 minute 19 seconds.
- `typecheck`: 1 minute 57 seconds.
- `unit` shards: 2 minutes 36 seconds to 3 minutes 34 seconds.
- `e2e`: 6 minutes 36 seconds. This is now the longest job.

The target is not reached. Workers 1 to 2 alone saved little. Runner minutes rose, but the repository is public, so Actions minutes are free.

Two green runs exist on the new layout. The third comes with the next code push.

Follow-up (row Z-58 in `docs/ROADMAP.md`): shard the e2e job two ways.

- Each shard needs its own Postgres and Redis service.
- The phone timing check (RW-79) runs on shard 1 only.
