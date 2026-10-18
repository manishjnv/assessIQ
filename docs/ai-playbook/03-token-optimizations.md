# 03. Token optimizations

Objective: use cheaper models and fewer tokens without lowering quality. Reviewed 2026-10-18 with measured data.

## Measured facts

| Fact | Number | Source |
| --- | --- | --- |
| Fixed cost of one agent run | about 70,000 tokens, plus about 4,000 per tool call | A one-line Haiku question cost 72,785; a 3-call sweep 84,960; a 10-call sweep 85,742 |
| Cost of reading the three big logs in full | about 490,000 tokens | `docs/SESSION_STATE.md` 232k, `docs/ROADMAP.md` 146k, `docs/RCA_LOG.md` 115k |
| Roadmap section P0-Z alone | about 97,000 tokens (274 rows, median 910 characters, longest 8,985) | measured |
| Agent runs per day | about 60 | S18 to S21 footers |
| Daily token use (estimate) | about 15M; Sonnet subagents 66%, main sessions 25%, Haiku 9%, Gemini and Codex under 1% | footers and run counts |
| Rework in S21 | 5 of 31 Sonnet builds; at least 3 avoidable | S21 routing telemetry |

Counts include cached input. Check your usage page for the metric that matters (quota or dollars) before judging an idea.

## Ranked idea list

| # | Idea | Status | Estimated saving per day |
| --- | --- | --- | --- |
| 1 | Batch rows per agent; no agent for 1 to 3 tool calls (do it inline or with a script) | Rule in `CLAUDE.md`; to enforce by habit | 1.3 to 1.7M (about 10%) |
| 2 | Generated start brief `docs/NEXT.md` (about 15k tokens) so Phase 0 never reads the big logs | Planned, row 1 of `08-token-tooling-plan.md` | 0.6 to 1.0M (about 5%) |
| 3 | Cut avoidable rework: exact briefs, `git merge main` first, `pnpm verify` before reporting, plan by file ownership | Partly done (rules in `CLAUDE.md`) | 0.5 to 0.8M (about 4%) |
| 4 | Scripts instead of agents: sweep (done), roadmap recount, next free migration numbers | Sweep done; two scripts planned | about 0.4M |
| 5 | Gemini for bulk reads (done: `tools/gemini.sh`); Codex review with the diff piped by script (planned) | Gemini done; Codex wrapper planned | 0.3 to 0.5M of Claude tokens |
| 6 | Haiku 5.5 first, as a trial on display, copy, help text, wiring, docs and tests of existing behaviour; stop if non-gate rework is above 25% after 8 runs | Trial rule in `CLAUDE.md`; report script planned | saves money, not tokens |

Dropped as already done: gate scope (only security paths get a gate).

## Quality guards that never change

`pnpm verify` before every push, CI green before deploy, the deploy script checks, the signed-in smoke check, Opus (or the main model) reviews every diff, gates on security paths.

## Rules of thumb

- Do not read the big logs. Use `docs/NEXT.md`, then `grep -n "^| <ID> " docs/ROADMAP.md`.
- Never move or delete parts of the big logs. ROADMAP evidence cells cite line numbers in them.
- Agent output: ask for a diff plus a change log under 200 words, no file dumps.
- Write the real `subagent_tokens` of each agent in the handoff footer so the next review has measured data.
