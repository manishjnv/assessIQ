# 11. Time and gate tooling plan (session S24, not built yet)

Goal: cut daily waiting (about 100 minutes of CI and deploy waits) to about 35 to 40 minutes, and remove push blocks from two sessions on one clone, without lowering any check. Items and status: `09-optimization-register.md` (TIME-8 to TIME-13, GATE-1 to GATE-3).

## Measured base (CI run 2026-10-18)

| Job | Steps | Time |
| --- | --- | --- |
| quality | Typecheck 102 s, Lint 15 s, Test (vitest) 462 s, API tests 33 s, web tests 10 s, then about 40 small repo-guard steps | about 10.5 min |
| e2e | containers 14 s, browser install 21 s, seed 9 s, build and serve 17 s, E2E specs 410 s, phone timing 79 s | about 9.8 min |

Wall time is the longer job. `main` has no branch protection, so renaming jobs does not block merges; `tools/deploy.sh` reads the workflow conclusion.

## Rows

| # | Deliverable | Contract in short | Acceptance |
| --- | --- | --- | --- |
| 1 | Z-55 faster CI | Separate typecheck job; unit tests in 3 vitest shards; e2e workers 1 to 2 (else 2 shards with their own Postgres and Redis); Playwright browser cache; `ci-ok` aggregator | 3 green runs; measured wall time before and after; target 5.5 to 6.5 min |
| 2 | Z-56 docs-only commits | `changes` job; heavy jobs skipped when only `docs/`, `*.md`, `.vale/` changed; always-run `docs-check` job (doc anchors, skill mount, `lint:docs`, deploy-procedure lint, vitest-coverage lint); `deploy.sh` also requires CI success on the last code commit | A docs-only push finishes CI in under 2 min; a broken doc anchor still fails |
| 3 | ~~Scoped verify stamp~~ **Deferred by the owner (2026-10-18): skip this row.** Do not build it; revisit after a week of worktree use | See `10` step 2 | n/a |
| 4 | Flaky tests | Find real flakes from the last 40 CI runs; fix causes | 5 clean local runs in a row |
| 5 | `tools/wt-setup.sh`, `tools/wt-clean.sh` | See `10` step 1 | Create, verify and clean a test worktree; record setup time |
| 6 | Migration in one transaction in `deploy.sh` | `psql -1` for files without their own BEGIN or COMMIT | A failing file rolls back (tested on a throw-away container) |
| 7 | Z-57, Z-53, Z-54 | Workflow rules in docs; prove the second-router injection fails; flip Docs lint `fail_on_error` only on or after 2026-10-29 after 3 green runs | Docs updated; RCA entry |

Add to row 7 (small, about 30 min): GATE-4, a gate checklist file `docs/ai-playbook/gate-checklist.md` with the threat model and attack vectors for auth, tenancy, grading, audit log and infra, and the rule "one gate per batch of at most 3 security rows, log what it found" in `CLAUDE.md`.

## Results (session S25, 2026-10-18)

- Measured CI wall time on a code push: 6m50 (`39137810235`) to 4m09 (`d60c0b85`), 3m45 (`84305460`) and 3m58 (`8eb0a949`, retries 0). The longest jobs are now e2e shard 2 (about 3m24, the serial admin-workflow group) and e2e shard 1 (3m29 with `signed-in-smoke`).
- Z-58: e2e matrix `shard-1`, `shard-2`, `phone`. Each leg has its own Postgres and Redis. Test count is the same as before. The phone check (RW-79) is a separate leg, off the critical path.
- Z-59: `signed-in-smoke` runs in CI. Deploy step 1b is removed. A deploy still needs CI success on HEAD and on the last code commit; the checked SHAs are printed. Why safe: the spec fails when a second router copy is injected (Z-53).
- Z-60: red-run causes in `12-red-ci-analysis.md`. `tools/test-clean.sh` removes stale testcontainers and ryuk containers only. Playwright retries are 0 in CI.
- Z-61: per-image deploy markers on the VPS. The first reviewer pass (Sonnet takeover, Codex is down) rejected diffing against the VPS HEAD, rename blindness, a fail-open diff and `*.md` skipping inside app folders. All fixed.
- Z-62: `tools/bg-verify.sh` background verify after commit. The 4th unit shard was not built: unit shards take 3m00 to 3m17, below e2e.
- Not included: scoped verify stamp (GATE-2, deferred), affected-only tests, image registry, auto-deploy, TIME-13 (shipped earlier in `05193ac1`, not touched).
- Downstream: `ci-ok` needs list is unchanged (a matrix job reports one result). Artifact names now include the matrix leg.

## Not changed

No product code, no migration, no deploy unless the preflight dry run is needed. Opus reviews every workflow and hook diff line by line. A broken workflow blocks every deploy.

## Full session prompt

Regenerate it from this page, `09`, `10` and the speed rules in `CLAUDE.md`. The previous orchestrator wrote one on 2026-10-18; its content is the table above.
