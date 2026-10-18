# 10. Gate optimizations

Reviewed 2026-10-18 with evidence. Items and status: `09-optimization-register.md` (GATE-1 to GATE-7). Rule: keep every check that stops a real failure; remove only friction.

## The three kinds of gate

| Group | Examples | Cost | Value | Verdict |
| --- | --- | --- | --- | --- |
| Cheap automatic gates | `pnpm verify` (5 s clean), CI green before deploy, deploy script preflight (HEAD equals origin, CI success, drift gate, build exit code), single-router lockfile test, signed-in smoke gate | Seconds to minutes | Caught a 2-day red CI, a React typing error, and a 17-hour blank admin page | Keep, no change |
| AI review gates | Sonnet takeover (Codex is text-only), `Adversarial-Review:` trailer on pushes touching security paths | About 170k tokens each (estimate, no per-gate measurement) | Found a retake race (`6985d3e`), a timer lock (`7ef8826`), takedown error masking | Keep for security paths only: `01-auth`, `02-tenancy`, `07-ai-grading`, `14-audit-log`, `infra/**`, and rows that decide who sits a test or gets marks or time. Display, UI and docs rows skip it |
| Hooks | `.claude/hooks/precommit-gate.sh` (secrets, TODO markers, invariants), `.claude/hooks/push-adversarial-gate.sh` (verify stamp, trailer) | Seconds, but they block when the shared tree changes | Backstop for the rules above | Keep; fix the shared-tree friction |

## Why pushes were blocked (found 2026-10-18)

- The push hook skips the verify requirement for docs-only pushes, but it checks the whole commit range `@{u}..HEAD`.
- A docs-only commit that sat in the same range as another session's unpushed code commits made the range contain code, so verify was required.
- The stamp is the HEAD tree hash plus a hash of `git diff HEAD` (all tracked uncommitted changes of anyone). Another session's edit invalidated it every time.
- A verify run on a tree with many changed packages took over 5 minutes.

## The steps

1. **GATE-1 worktree per session** in `.claude/worktrees/<name>` (already ignored by git, eslint, vale, markdownlint, docker). `tools/wt-setup.sh` and `tools/wt-clean.sh`. Private memory is keyed by the folder path: link the new folder's `memory` to the main one with a Windows junction.
2. **GATE-2 scoped stamp:** file set F = files in the push range; stamp = HEAD tree hash plus hash of `git diff HEAD -- F`. Unrelated edits keep it valid; edits to pushed files invalidate it. Keep the old behaviour unless `VERIFY_STAMP_SCOPED=1`. Needs the owner's yes.
3. **GATE-3 flaky tests:** fix by waiting on conditions. Known: `AttemptSubmitModal` "N and P keys", structured-case editor, `result-flow.test.ts` mock lacks `handleAuditFanout` (165 noisy log lines). No blind retries (they hide real failures).
4. **GATE-4 gate checklist template:** one file with the threat model and attack vectors per security area, so one gate per batch finds more at lower cost. Log what each gate found. Needs the owner's yes.
5. **GATE-5 push after each batch:** whoever commits, pushes, so no push drags another session's code.
6. **GATE-6 token tools** from `08-token-tooling-plan.md`, then re-measure.

## What must not change

`pnpm verify` before push, CI green before deploy, the deploy script checks, the AI gate on security paths, diff review by the main model, the docs-reading lints (doc anchors, skill mount, deploy procedure) on every commit including docs-only ones.
