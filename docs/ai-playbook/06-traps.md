# 06. Traps that already cost time

| Trap | What happens | Do this |
| --- | --- | --- |
| CRLF commit | An edit script copies Windows line endings and `git -c core.autocrlf=false commit` stores them: a 9-line edit shows 1,000 lines (RCA 2026-10-18) | Write LF. Never override `core.autocrlf`. Check `git diff --cached --stat` against the edit size. |
| Two router copies | A dependency bump changed some packages, not all: two `react-router-dom` versions, so `/admin` was blank after sign-in for 17 hours | Keep one version. The test `single-router-copy.test.ts` guards it. Bump every workspace that declares the package. |
| Sweep without sign-in | A sweep that checks only public pages cannot see a crash after login | Run the signed-in smoke spec (Z-47) and ask the owner to open `/admin` once. |
| Red CI hides tests | One lint error stopped the Test step for 2 days | Watch CI on every pushed commit. Run `pnpm lint` before push. |
| Piped deploy | `deploy.sh ... \| head` killed the run with SIGPIPE after the pull | Write output to a file, read the exit code. |
| Stale-image recreate | A build failure hidden by a pipe, then `up --force-recreate` on the old image | Check `BUILD_EXIT` before recreate (the script does). |
| Beacon check | Plain `curl` shows no Cloudflare beacon (false FAIL) | Use a browser User-Agent and `Accept: text/html`. |
| Cloudflare token | The token on `.env` lines 30 to 34 is limited to Config Settings read and write on one zone and to the VPS IP | Call Cloudflare only from the VPS over IPv4 (`curl -4`), token through ssh stdin, never on a command line or in a file. Variable names contain spaces; read the lines directly. |
| Windows python and `/tmp` | Python on Windows cannot read Git Bash `/tmp` | Pass data through stdin pipes. |
| Migration numbers | Parallel agents took the same number (0197, 0203) | The orchestrator assigns one number per agent first. The migration lint allows equal numbers only with different names. |
| Help ids | Hyphens never match; ids must start with the page's `helpPage`; a new id needs the full help DB test suite | Use `[a-z0-9_]` segments. |
| Partial mocks | `vi.mock("@assessiq/notifications")` without `notifyCandidateResultReleasedAfterCommit` or `handleAuditFanout`; tenancy mocks without `getTenantLogoMeta` | Export every function the code under test imports. |
| Worktree agents | A worktree starts from an old base: conflicts and a merge agent | `git merge main` first. Remove worktrees with `cmd /c rmdir /s /q` then `git worktree prune`; back up unmerged files first. |
| Gemini edits | Headless Gemini can edit files | Use `tools/gemini.sh` (read-only prefix, status check). |
| Codex | Sandbox cannot run commands; stdin must be closed | Text-only; `</dev/null`. |
| Big logs | Reading SESSION_STATE, ROADMAP and RCA in full costs about 490k tokens | Use `docs/NEXT.md` and grep. |
| Docs ignored by git | `docs/` is in `.gitignore` but files are tracked | `git add -f <file>`. |
| Shared VPS | Other apps run on it | Additive deploys only; enumerate before touching shared config; ask the owner before editing Caddy. |

## S24 traps (2026-10-18)

- The `pnpm verify` stamp is tied to the HEAD tree. Order: commit, then `pnpm verify` in its own command, then push in its own command. Run verify again if the stamp is stale.
- Two sessions share one clone. Another session committed during S24 (`fb2cd882`). Run `git log` before each commit.
- Git Bash rewrites `/s /q` as paths. Set `MSYS_NO_PATHCONV=1` and run `cmd.exe /d /c`.
- `gh run rerun <id> --failed` reruns only the failed jobs. The run keeps its id and gets a new attempt number.
- Skipped jobs on a docs-only commit are normal. Read the `ci-ok` result.
- Redis ECONNREFUSED lines in failed logs are noise from unmocked API tests. They are not the failing assertion.
- A migration with `CREATE INDEX CONCURRENTLY` or `VACUUM` cannot run in the one-transaction path. Apply it by hand, then insert its `schema_migrations` row. Adding your own BEGIN and COMMIT does not help.
- A docs-only commit that is force-pushed after a code change can look docs-only. The deploy check on the last code commit covers this case.

## S27 traps (2026-10-18)

- CI runs only on push to main and on pull requests to main. A CI proof from a throw-away branch needs a draft PR. Close it and delete the branch after.
- A scripted edit can add a stray control character (for example `` in a Python replace string becomes a backspace). Print `regex.source` after the edit and check the count by a second method.
- A test fixture can hold the bug it should catch. Check that fixtures describe the intended rule.
