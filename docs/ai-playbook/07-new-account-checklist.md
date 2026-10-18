# 07. Checklist for a different Claude account, machine or model

Why this page exists: a second Claude account (for example when the first account's tokens run out) shares nothing with the first except what is in the repo. Private memory (`~/.claude/projects/...`) and the private global `~/.claude/CLAUDE.md` do not travel. The repo does.

## Same machine, second account (the owner's current setup)

The owner signs in with another Claude account on the SAME computer. Then local files are shared: private memory under `~/.claude/projects/`, `.env`, the ssh alias, `gh` login, `agy`, `codex`, the Cloudflare token lines and the local clone. Nothing needs copying. The repo playbook is the backup for a different machine. The account email addresses are in private memory, not in this public repo.

Risk: two sessions on one clone at the same time. This already happened (S19 to S22): one session staged files while another committed. Rules:
1. Run `git status` first. Edits you did not make mean another session is active: do not touch those files.
2. Commit with named paths (`git commit -- <paths>`), never `git add -A`. The other session's staged files stay out of your commit.
3. For long parallel work use a separate worktree or a second clone, and merge through `main`.
4. Do not both edit `CLAUDE.md`, `docs/ROADMAP.md` or `docs/SESSION_STATE.md` at once: one session owns them per hour; the other sends rows through the handoff.
5. Record who is working in the top block of `docs/SESSION_STATE.md` ("S22 running, files: ...").
6. The push hook needs a fresh `pnpm verify` stamp; any edit after verify invalidates it, so verify, commit, then push in separate commands.

## What travels (in the repo)

- `CLAUDE.md` (rules, load-bearing paths, speed rules, routing table) loads by itself.
- `PROJECT_BRAIN.md`, `docs/`, this folder, `tools/`, `.claude/settings.json` and `.claude/hooks/` (the project hooks: pre-commit gate, push gate).
- The roadmap (`docs/ROADMAP.md` section P0-Z) and the handoff (`docs/SESSION_STATE.md`).

## What does not travel (the owner provides it)

| Item | How to get it |
| --- | --- |
| Git access | `gh auth login` as `manishjnv`; push needs the noreply identity: `GIT_COMMITTER_EMAIL="257227540+manishjnv@users.noreply.github.com" GIT_COMMITTER_NAME="Manish Kumar" git commit --author="Manish Kumar <257227540+manishjnv@users.noreply.github.com>"`. Never change git config. |
| SSH to the VPS | The `assessiq-vps` alias and key in the owner's `~/.ssh`. Without it you cannot deploy; stop at "ready to deploy". |
| `.env` (gitignored) | Copy from the owner. Lines 30 to 34 hold the Cloudflare account id and token, plus R2 keys. Never print values. |
| Gemini | Antigravity login on the machine; `agy` on PATH. Test: `bash tools/gemini.sh "list the files in tools/"`. |
| Codex | `codex exec` login. Text-only here. |
| Playwright e2e | `apps/web/e2e/README.md`. |

## First 10 steps for a new account

1. `git clone` the repo; `pnpm install --frozen-lockfile`.
2. Read `CLAUDE.md`, `PROJECT_BRAIN.md`, `docs/NEXT.md` (or the top 60 lines of `docs/SESSION_STATE.md`), then `docs/ai-playbook/01` to `06`.
3. `git fetch && git status`. If the working tree has edits you did not make, another session is active: ask the owner.
4. Run `pnpm verify` and `bash tools/deploy.sh --dry-run` to prove your setup works.
5. Pick open rows from `docs/NEXT.md` (Ready for Claude). Batch 3 to 4 rows.
6. Brief each agent with `docs/agent-brief.md` (when present) and the file-ownership plan.
7. `pnpm verify` before every push; watch CI until green.
8. Deploy with `tools/deploy.sh`.
9. Write the handoff block at the top of `docs/SESSION_STATE.md`, update the roadmap rows, run `pnpm next` when the tool exists, commit with named files.
10. If tokens run out mid-task: commit what is safe, write a "what is half done" note in the handoff (files, state, next command), push, and stop. Do not leave uncommitted edits.

## Two sessions at once = two worktrees

Use one git worktree for each session that writes code. Never share one folder between two sessions.

- Folder: `.claude/worktrees/<name>`. Git, eslint, vale, markdownlint and docker already ignore this folder.
- Create one: `bash tools/wt-setup.sh <name>`. It makes branch `<name>` from `origin/main`, copies `.env` and runs `pnpm install`. Setup takes about 90 to 100 seconds.
- Start a session: open a terminal in the new folder and run `claude`.
- Finish a unit of work: run `git fetch origin && git rebase origin/main`, then `pnpm verify`, then commit and push. Run each command on its own.
- Remove one: `bash tools/wt-clean.sh <name>`. It refuses when work is not saved or pushed. Use `--force` only after you check the work. It writes a backup first.
- Unknown folders: `wt-clean.sh` lists folders under `.claude/worktrees/` that git does not know. Ask the owner before you delete one.

Memory link (manual, one time per worktree):

1. Run one Claude session in the new folder first.
2. Open `%USERPROFILE%\.claude\projects\` and find the new folder for that worktree. Do not guess its name.
3. Run `cmd /c mklink /J "<new folder>\memory" "%USERPROFILE%\.claude\projects\e--code-AssessIQ\memory"`.

Use a worktree only for load-bearing writes. Non-load-bearing UI rows run in the main folder.

## Making the first account's private knowledge portable

The private memory holds owner decisions, review-gate rules and session history. The key facts are copied into this folder and into `CLAUDE.md`. When you learn a new durable rule in any account, write it in `docs/ai-playbook/` or `CLAUDE.md`, not only in private memory.
