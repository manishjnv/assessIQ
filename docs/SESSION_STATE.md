# Session — 2026-05-03 (RCA-driven tooling hardening)

**Headline:** Edge-routing CI lint + shared-mount sed PreToolUse hook shipped — converts five "manual discipline" RCAs from the past 4 days into harness-enforced gates. No module code, no shared-VPS deploy.
**Commits:** *(commit-pending — orchestrator to commit at session exit)* — `chore(tooling): edge-routing lint + shared-mount sed hook + RCA prevention`
**Tests:** typecheck pass, edge-routing self-test 7/7 pass, edge-routing repo scan green (22 files / 70 mounts), no-sed-shared-mount hook 8/8 synthetic tests pass, synthetic violation test exits 1 as required.
**Next:** Phase 2 G2.A Session 1.a (`modules/07-ai-grading` scaffold) is the next coding task — its working tree is already pre-staged from an earlier session, awaiting its own commit + `codex:rescue` adversarial pass per the load-bearing-paths rule.
**Open questions:**

- The Deliverable 3 typecheck failure documented in the prior session-state's "Open questions" line 59 (`question_id: 'string | undefined' vs 'string | null'`) does NOT reproduce against the current working tree — `pnpm -r typecheck` reports clean across all 15 workspaces. The seam at `modules/11-candidate-ui/src/types.ts:121` already has `question_id?: string | null` (optional + nullable) and `useIntegrityHooks.ts:60` normalizes via `?? null` at the producer boundary. Whoever fixed it didn't update SESSION_STATE.md. This handoff drops the stale claim — Deliverable 3 is a no-op.
- The `permissions.defaultMode: bypassPermissions` removal in `.claude/settings.json` (pre-existing in the working tree) is intentional cleanup per memory observation 436 (the value lives in gitignored `.claude/settings.local.json` now). Included in this session's commit as tangentially-related tooling cleanup.

---

## What shipped

### Deliverable 1 — `tools/lint-edge-routing.ts` (new, 671 lines)

CI lint that prevents the third edge-routing fallthrough incident. Walks `apps/api/src/server.ts` plus all module-side route registration files for `app.<verb>("/<path>", ...)` and `app.route({ method, url })` mounts. Reads the canonical `@api path ...` line from `docs/06-deployment.md` § "Current live state" — single source of truth, no hardcoded duplicate list. Coverage rule: a non-`/api/*` mount passes if either (a) Caddy path-match (`/foo/*`, `/foo*`, exact `/foo`) covers it, or (b) any matcher entry shares its first path segment (so `GET /take/:token` is OK when `/take/start` is in the matcher — codified intent for split SPA/API behavior). Self-test ships 7 fixtures including a regression guard for the 2026-05-03 `/take/*`-missing case; production mode reads from disk.

**Wiring:**
- `.github/workflows/ci.yml` step 9c — self-test + repo scan, both required-pass.
- `package.json` — `lint:edge-routing` and `lint:edge-routing:self-test` scripts.

**Verified:**
- `pnpm tsx tools/lint-edge-routing.ts --self-test` → exit 0, all 7 fixtures pass.
- `pnpm tsx tools/lint-edge-routing.ts` → exit 0 on current main (22 files scanned, 70 route mounts checked, canonical matcher: `@api path /api/* /embed* /help/* /take/start`).
- Synthetic violation test (temp-add `app.get("/foo/bar", ...)` to server.ts) → lint output `mount "/foo/bar" — not covered by Caddy @api matcher`, exit 1.

**Prevents:** 2026-05-02 `/help/*` fallthrough, 2026-05-03 `/take/*` fallthrough RCA pattern class (third incident would be process failure).

### Deliverable 2 — `.claude/hooks/no-sed-shared-mount.sh` (new)

Bash PreToolUse hook on the Bash tool. Reads tool-input JSON via stdin (jq with sed fallback). Two-phase AND check before blocking:

1. **Editor pattern** — `\bsed[[:space:]]+(-[a-zA-Z]*[[:space:]]+)*-i([^a-zA-Z]|$)`, plus `awk -i inplace`, `perl -pi`, `ruby -pi`, `gawk -i inplace`, `python -m fileinput -i`. The trailing `([^a-zA-Z]|$)` terminator on the `-i` flag prevents over-firing on hypothetical combined flags like `sed -in...`.
2. **Path target** — `/opt/ti-platform/`, `/etc/`, `/srv/` (excluding `/srv/assessiq/`), `/var/log/` (excluding `/var/log/assessiq/`), `/var/backups/` (excluding `/var/backups/assessiq/`). Trailing slash is mandatory so `/opt/ti-platform-foo` doesn't false-match.

Exit 2 with stderr citing all three RCA dates and showing the truncate-write recovery procedure. Override: `ALLOW_SHARED_MOUNT_SED=1 <command>` prefix passes through (escape hatch for genuinely necessary in-place edits).

**Wiring:** `.claude/settings.json` PreToolUse Bash hooks array, ordered AFTER `precommit-gate.sh` (cheaper/more frequent checks first, targeted VPS guard second).

**Verified — 8/8 synthetic tests:**

| # | Command | Expected | Actual |
|---|---|---|---|
| 1 | `sed -i s/foo/bar/ /opt/ti-platform/caddy/Caddyfile` | BLOCK (2) | 2 ✓ |
| 2 | `sed -i s/foo/bar/ /srv/assessiq/.env` | ALLOW (0) | 0 ✓ |
| 3 | `sed s/foo/bar/ /opt/ti-platform/caddy/Caddyfile > /tmp/new` | ALLOW (0) | 0 ✓ |
| 4 | `perl -pi -e s/foo/bar/g /etc/nginx/nginx.conf` | BLOCK (2) | 2 ✓ |
| 5 | `ALLOW_SHARED_MOUNT_SED=1 sed -i ... /opt/ti-platform/...` | ALLOW (0) | 0 ✓ |
| 6 | `git status` | ALLOW (0) | 0 ✓ |
| 7 | `awk -i inplace { print } /var/log/syslog` | BLOCK (2) | 2 ✓ |
| 8 | `awk -i inplace { print } /var/log/assessiq/app.log` | ALLOW (0) | 0 ✓ |

**Prevents:** 2026-04-30 + 2026-05-02 + 2026-05-03 inode-trap RCA pattern class. Three incidents in 4 days; manual discipline gate has demonstrably failed.

### Deliverable 3 — pre-existing 11-candidate-ui typecheck failure

**Status: no-op.** The failure documented in the prior session-state handoff does not reproduce against the current working tree. Investigation: `modules/11-candidate-ui/src/types.ts:121` defines `CandidateEventInput.question_id?: string | null` (optional + nullable). `modules/11-candidate-ui/src/hooks/useIntegrityHooks.ts:33-63` accepts `string | null | undefined` at the `emit()` boundary and normalizes via `?? null` at the wire-encoding step. The seam is already aligned end-to-end with the `string | null` invariant; there is no `string | undefined` leakage to fix. `pnpm -r typecheck` reports clean across all 15 workspaces, including `apps/web` and `modules/11-candidate-ui`.

The prior session-state's claim is removed from this handoff's "Open questions."

### Documentation updates

- **`docs/06-deployment.md` § "Current live state"** — canonical Caddyfile snippet updated to include `/take/start` in the `@api path` matcher (the live VPS state per the 2026-05-03 inode-trap recovery; the doc was previously stale). Section heading bumped to Phase 1 G1.D, explanation paragraph added describing the deliberate `/take/start` (API) vs `/take/:token` (SPA) split. Lint reads from this section, so doc accuracy is now load-bearing.
- **`docs/RCA_LOG.md`** — prepended a "## 2026-05-03 — preventive guardrails added" entry covering both deliverables. Format follows CLAUDE.md rule #5: what / why now / considered-and-rejected (six options, including warning-only lint, hardcoded matcher list, log-only hook, AST parsing, precommit-only enforcement, and single-file path scoping) / NOT included (docker-closure lint, vitest-toSatisfy ESLint rule, ambient-AI lint changes) / downstream impact (future SKILL.md reminders can drop, doc snippet now load-bearing for lint).

### Out of this session's scope (explicit)

- `modules/07-ai-grading/` (Session 1.a) — scaffold present in working tree as untracked files. Awaits its own commit + `codex:rescue` adversarial pass.
- The pre-existing working-tree changes to `modules/00-core/src/config.ts` (open-weights enum), `tools/lint-rls-policies.ts` (tenant_grading_budgets PK=tenant_id special-case), `pnpm-lock.yaml`, and the `lint:ambient-ai` scripts in `package.json` / step 9a in `.github/workflows/ci.yml` are all Session 1.a supporting glue. Surgically NOT staged for this session's commit per the user's brief "Out of scope: modules/07-ai-grading/."

### Adversarial review

Skipped per the user's brief — pure tooling, no security/auth/classifier surface. Both deliverables are dev/CI guards that don't touch any load-bearing path under `modules/01-auth/`, `modules/02-tenancy/`, `modules/07-ai-grading/`, or `modules/14-audit-log/`. Both are also static — neither calls `claude`, `anthropic`, or any external service. Skip decision logged here per CLAUDE.md rule #9 doc-detail requirement.

---

## Agent utilization

- **Opus 4.7 (1M)**: Phase 0 warm-start parallel reads (PROJECT_BRAIN + SESSION_STATE + RCA_LOG + 06-deployment + lint-rls-policies + precommit-gate); Phase 3 diff critique (no bounces); cross-module type-seam audit for Deliverable 3 (verified seam already aligned, dropped phantom-fix temptation); orchestration of partial-stage-via-back-edit to surgically exclude pre-existing Session 1.a hunks from the commit; same-PR doc detail in RCA_LOG.md (~95 lines covering five rejected alternatives) + SESSION_STATE.md overwrite.
- **Sonnet**: 2 parallel Phase 1 calls — Sonnet A (`tools/lint-edge-routing.ts` + `docs/06-deployment.md` matcher update + ci.yml + package.json wiring; 671 lines + 7-fixture self-test; reported all gates green) and Sonnet B (`.claude/hooks/no-sed-shared-mount.sh` + `.claude/settings.json` hook wiring; 8 synthetic tests all pass; reported actual exit codes).
- **Haiku**: n/a — no bulk live-prod sweeps in scope (no deploy this session).
- **codex:rescue**: n/a — judgment-skip per user's brief, pure dev tooling with no security/auth/classifier surface (CLAUDE.md rule allows scaling rigor to change magnitude; skip logged here per rule #9).
