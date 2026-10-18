# AI playbook: how any Claude account or model works on AssessIQ

Status: written 2026-10-18. This folder is the portable memory of the project. Another Claude account, another machine or a new model has no access to the first account's private memory (`~/.claude/projects/...`), so everything a new session needs is here and in the repo.

## Start here (10 minutes)

1. Read `CLAUDE.md` in the repo root. Claude Code loads it by itself. It holds the hard rules, the load-bearing paths and the speed rules.
2. Read `PROJECT_BRAIN.md`, then `docs/NEXT.md` if it exists (generated brief of open work). If it does not exist yet, read the top block of `docs/SESSION_STATE.md` (`sed -n '1,60p'`).
3. Read this folder in order: `01` speed rules, `02` time savings, `03` token savings, `04` model routing, `05` tools, `06` traps, `07` new account checklist.
4. Never read `docs/SESSION_STATE.md`, `docs/ROADMAP.md` or `docs/RCA_LOG.md` in full. They hold about 490,000 tokens. Open one row with `grep -n "^| Z-39 " docs/ROADMAP.md`.

## Files

| File | Type | What it holds |
| --- | --- | --- |
| `01-speed-rules.md` | Reference | The owner's rules for quick, safe sessions |
| `02-time-optimizations.md` | Reference | Time savings built on 2026-10-18, with measured results |
| `03-token-optimizations.md` | Explanation | Measured token facts, the ranked idea list, status of each |
| `04-model-routing.md` | Reference | Which model does which work, Gemini and Codex use, review gate |
| `05-tools.md` | Reference | Every script in `tools/` with its command |
| `06-traps.md` | Reference | Mistakes that already happened, and how to avoid them |
| `07-new-account-checklist.md` | How-to | Steps for a different Claude account or machine |
| `08-token-tooling-plan.md` | How-to | The plan (session S23) to build the remaining token tools |

## Rules for this folder

- Keep each file short. Update the status lines when work lands.
- Do not copy secrets here. Say where a secret lives, never what it is.
- The source of truth for open work is `docs/ROADMAP.md` (section P0-Z). This folder explains how to work, not what to build.
