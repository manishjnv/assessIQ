# Plan: stop tracking public docs files in the public repo (Z-75)

**Type:** plan only. **Status:** not started. **Date:** 2026-10-19 (S31). **Execution needs the owner's yes.**
**Source:** owner Q13 (do it in a planned step); memory "public repo hygiene" (docs are gitignored, new docs need `git add -f`); ROADMAP Z.8 (history purge, separate).
**Old task or feature checked:** `.gitignore` lines 39-46 (`docs/` is ignored, tracked files stay tracked), H1 (duplicate-ID table, "44 already-committed docs"), Z-73 (docs-reading tests in CI), Z-48 (Docs lint), RCA 2026-05-03 (VPS git clone).

## Facts (checked 2026-10-19)

| Item | Fact |
|---|---|
| Tracked files in `docs/` | 107 (`git ls-files docs`). By folder: `plans` 40, `design` 22, `ai-playbook` 14, `superpowers` 2, `sessions` 2, `adr` 2, `testing` 1, `runbooks` 1, plus top-level files (`ROADMAP.md`, `SESSION_STATE.md`, `STYLE.md`, `agent-brief.md`, numbered docs 01 to 13 and others) |
| Ignore rule | `docs/` is in `.gitignore`. Files added with `git add -f` stay tracked and are public on GitHub |
| History | Removing files from the index does NOT remove them from git history. History purge is a separate row (Z.8, "run Z.8") |
| `.dockerignore` | `docs/` is excluded from images (line 59). No image needs `docs/` |
| `tools/deploy.sh` | Treats `docs/*` as "not deployable" in the diff filters (lines 58 and 103). It does not read `docs/` at run time |

## What reads `docs/` (the things that break)

| Reader | Where | What happens if `docs/` is absent in the checkout |
|---|---|---|
| CI job `docs-check` | `.github/workflows/ci.yml` (about lines 496-545) | `lint:doc-anchors` and `lint:deploy-procedure` already skip when files are absent (they use `existsSync`); `lint:docs` (`tools/lint-docs.mjs`) guards with `existsSync` for the help and email folders. **Must be verified one by one** |
| CI step "Docs-reading tests" (Z-73) | `ci.yml` about line 531 | `next-brief`, `next-migration`, `roadmap-recount`, `routing-report` tests read `docs/ROADMAP.md`, `SESSION_STATE.md` and so on. They would FAIL. Fix: skip them when `docs/ROADMAP.md` is absent, or remove the step |
| Workflow `docs-lint.yml` | triggers on `docs/**`, runs Vale on `docs` and `README.md` | Nothing to lint. The workflow should lint `README.md` only, or be removed. It becomes a required check on 2026-10-29 (Z-48, Z-54): decide before that date |
| Unit tests with docs comments | `audit-writes.test.ts`, `rubric-engine.test.ts`, `notifications.test.ts` | They mention `docs/` in comments only (checked). No read at run time. `aptitude-seed-migration.test.ts` reads `docs/exam-content/` only when present |
| Dev tools | `tools/next-brief.mjs`, `next-migration.mjs`, `roadmap-recount.mjs`, `routing-report.mjs`, `ci-green-streak.sh`, `codex-review.sh` | They read the local `docs/`. They keep working on a machine that has the files |
| `README.md` and code comments | many links to `docs/...` | Links become dead on GitHub. Fix with a short note in the README that internal docs are not public |

## What the next VPS `git pull` does

- `/srv/assessiq` is a git clone (RCA 2026-05-03). When a commit removes tracked files, `git pull` **deletes those files from the working tree** on the VPS.
- So `/srv/assessiq/docs/` would lose all 107 tracked files at the next pull. Untracked and ignored files in `docs/` stay.
- Nothing at run time needs `docs/` on the VPS (not in the images, not read by `deploy.sh`). But `docs/06-deployment.md` is the deploy procedure that a human reads on the VPS.
- **Warn the owner before the first pull after the change.** Keep a copy of the docs on the owner's machine (the working tree here keeps them) and, if the owner wants, copy the folder to `/srv/assessiq-docs/` on the VPS first (additive, outside the clone).

## Safe order

1. **Decide the scope with the owner.** Option A: stop tracking all 107 files. Option B: stop tracking all except `README`-linked reference pages the owner wants public (for example `docs/STYLE.md`, `docs/adr/README.md`). Recommendation: A.
2. **Make CI independent of `docs/`.** In one commit, with `docs/` still tracked: (a) make the four docs-reading tests skip when `docs/ROADMAP.md` is absent; (b) check each `lint:*` guard in `docs-check` with a temporary checkout that has no `docs/` (run them in a scratch clone); (c) change `docs-lint.yml` to lint `README.md` only. Push. CI must be green.
3. **Back up.** Copy the docs folder to the owner's machine (already there) and make a tarball: `tar czf docs-backup-<date>.tgz docs` outside the repo.
4. **Stop tracking.** `git rm -r --cached docs` (the files stay on disk). Commit. Because `docs/` is in `.gitignore`, nothing re-adds them by accident. Update `.gitignore` comment (remove "Files already tracked stay tracked").
5. **Push and watch CI.** The docs-check job must stay green with no `docs/` in the checkout.
6. **VPS.** Before the next `git pull` on the VPS: copy `/srv/assessiq/docs` to `/srv/assessiq-docs-<date>/` (a new folder, additive). Then pull. Then run `bash tools/post-deploy-sweep.sh`.
7. **Local tools.** The owner's machine keeps `docs/`. New docs still need no `git add` at all (they are ignored).
8. **Do NOT** purge history in this step (Z.8 is separate and needs "run Z.8").

## Side effects to accept

- Pull requests and CI can no longer check docs. Docs-only commits will not exist; `docs-check` still runs on code commits.
- Session handoff files (`SESSION_STATE.md`) will no longer be in git. The next session's start brief (`NEXT.md`) is generated locally. A fresh clone has no docs. Treat the owner's machine as the source of truth, and keep a nightly or weekly tarball.
- The `Adversarial-Review:` push hook and the verify gate are not affected (they read commits and paths).

## Rollback

- `git revert` the "stop tracking" commit. `git checkout <sha-before> -- docs` restores the files from history (still there). On the VPS, restore from `/srv/assessiq-docs-<date>/`.

## Not included

- Any `git rm`, any history purge, any VPS change (all need the owner's yes).
- Changing what the live `/terms` and `/privacy` pages say.

## Owner decision needed

- Option A or B. Date. Yes for the VPS copy-then-pull step.
