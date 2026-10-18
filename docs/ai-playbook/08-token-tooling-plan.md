# 08. Token tooling plan (session S23; all six rows built by S27)

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

## Z-66 routing report

Script: `tools/routing-report.mjs`. Test: `tools/__tests__/routing-report.test.ts`.

Run it from the repo root:

1. Run `node tools/routing-report.mjs` for the table.
2. Run `node tools/routing-report.mjs --json` for machine-readable output.

What it reads:

- `docs/SESSION_STATE.md` and every `docs/sessions/*.md`. Missing files are skipped.
- Footer telemetry: `Sonnet · task · reworked: Y (why)`. Packed lines with several items are split.
- Prose footers: `Sonnet: task 117k tokens (reworked: N)`. Each part with a `reworked:` label is one run.
- Tokens: `tokens: 87000` or `117k tokens`. A run with no token figure counts as unknown.
- `Haiku 5.5` counts as Haiku.

What it prints:

- Per route: runs, reworked Y count, rework rate, and known tokens.
- Haiku 5.5 trial: runs, non-gate rework rate, and the stop rule result.
- A task that contains `gate`, `review` or `takeover` is gate work. Gate work is left out of the non-gate rate.

Footer line template, use it from now on:

`- <Opus|Sonnet|Haiku> · <task, max 6 words> · reworked: <Y|N> (<why if Y>) · tokens: <subagent_tokens from the Agent result>`

Stop rule: STOP the Haiku 5.5 trial if non-gate rework is above 25% after 8 runs. Until 8 Haiku runs exist, the script prints `TOO FEW RUNS (n of 8)`. At exactly 25%, the trial continues.

Limits:

- Older footers rarely carry token figures, so most token totals show `n/a`.
- The script counts every Haiku run as trial data. No footer line marks a run as "Haiku 5.5" by date.
- The script has no dedupe. A run that is written twice in the same file counts twice.

## Z-64 result

Script: `tools/next-brief.mjs`. Writes `docs/NEXT.md` (generated, gitignored, never hand-edited). Test: `tools/__tests__/next-brief.test.ts`.

Run it from the repo root: `node tools/next-brief.mjs`. It prints the output size in bytes and an estimate in tokens (bytes / 4). It caps the file at about 30k tokens. Open Z-rows shrink first, then RCA entries, then board lines.

Measured on 2026-10-18 at HEAD `ce3be562`. Tokens are bytes / 4, labelled estimate.

| Reading set | Bytes | Estimate tokens |
| --- | --- | --- |
| BEFORE: PROJECT_BRAIN + 01-architecture-overview + SESSION_STATE + ROADMAP + RCA_LOG | 2,048,254 | ~512,000 |
| AFTER: PROJECT_BRAIN + 01-architecture-overview + NEXT.md + RCA_LOG (RCA kept) | 517,618 | ~129,400 (-75%) |
| AFTER without RCA (possible later) | 52,677 | ~13,200 (-97%) |

Notes:

- RCA_LOG.md is the largest part of the AFTER set (about 116k estimate tokens). Phase 0 keeps it for now, as the contract says. Dropping it from Phase 0 is the next saving.
- `docs/NEXT.md` is about 10 KB (about 2.6k estimate tokens).
- Open-row rule: a row counts when its status cell begins `pending` or `partly`. Status cells that begin `PARTIAL` or `PART 1` are not listed. Check these rows by hand.
- RCA order: the file is mixed (newest-first block, then 2026-10-18 entries appended in ascending order). The script sorts by date. Same-day ties keep file order, so the "5 newest" among 2026-10-18 entries is not a true time order.
