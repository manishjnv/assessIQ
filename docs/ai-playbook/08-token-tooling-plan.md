# 08. Token tooling plan (session S23, not built yet)

Goal: cut token use per day by about 20% without lowering quality. Only tooling, scripts and rules. No product code, migration or deploy. Evidence in `03-token-optimizations.md`.

Constraints: do not move, split or delete parts of `docs/SESSION_STATE.md`, `docs/RCA_LOG.md` or `docs/ROADMAP.md` (ROADMAP evidence cites their line numbers). The saving comes from not reading them. No gate is needed (nothing here is a security path).

## Rows

| # | Deliverable | Contract in short | Acceptance |
| --- | --- | --- | --- |
| 1 | `tools/next-brief.mjs`, `pnpm next`, `docs/NEXT.md` | Reads ROADMAP P0-Z tables and the Z.7 counts, the first SESSION_STATE block, RCA entries of the last 7 days. Writes sections: counts, Ready for Claude (cap 40 one-line rows), Needs the owner (cap 30), latest handoff, recent RCA, known traps, how to open a full row. Under 60 KB; skips lines that look like secrets | Runs in under 5 seconds; 5 rows match ROADMAP by hand; size cap enforced; unit test (happy path plus oversize failure) |
| 2 | `tools/roadmap-recount.mjs` | Counts closed and open per section by the status-column rule used in Z.7; prints the roadmap's own figures and the difference; `--write-z7` prints text only | Fixture test with known counts |
| 3 | `tools/next-migration.mjs --count N` | Lists the next N free migration numbers across `modules/*/migrations`; prints the pinned help seed count | Fixture test |
| 4 | `docs/agent-brief.md` and `CLAUDE.md` edits | One-page brief template; Phase 0 list becomes `PROJECT_BRAIN.md`, `docs/NEXT.md`, architecture overview; `pnpm next` in the Phase 6 handoff; no agent for 1 to 3 tool calls; batch rows per agent | Owner confirms the wording |
| 5 | `tools/codex-review.sh <range> <threat-file>` | Builds the prompt and the diff inside the script (diff never typed in chat), runs `codex exec ... </dev/null`, prints the last 40 lines, exits 3 if the working tree changed, exits 2 above a 60 KB diff | One real run recorded with its time |
| 6 | `tools/routing-report.mjs` | Parses the routing telemetry lines in SESSION_STATE; per model: runs, reworked, rate, rate excluding gate-found revisions | Fixture test; Haiku trial rule applied after 8 runs |

## Measure before and after

Record the size in tokens of the old Phase 0 reading set (PROJECT_BRAIN, architecture overview, SESSION_STATE, ROADMAP, RCA_LOG, about 540k) against the new set (PROJECT_BRAIN, NEXT.md, architecture overview, under 30k). Put both in the handoff.

## Full session prompt

Ask the owner or the orchestrator to regenerate it from this page and `03-token-optimizations.md`. The previous orchestrator session wrote one on 2026-10-18; its content is the table above plus the rules in `01-speed-rules.md`.
