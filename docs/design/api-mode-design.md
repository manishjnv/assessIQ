# API mode for AI evaluation — design note (FU-A13)

**Status: design only, not built.** Date 2026-10-09. Owner decision OD2 (switch the engine to an API key when paid plans start) and PT1 (plan tiers) are the triggers. Nothing in this note is live.

## What

`AI_PIPELINE_MODE=anthropic-api` replaces the VPS Claude Code CLI (the owner's subscription) with a Claude API key. The flow does not change: the platform super admin clicks Grade in the platform queue, the call is synchronous and single-flight, proposals are accepted before commit (D2 / D7 / D8). Only the runtime behind `runClaudeCodeGrading` changes: `modules/07-ai-grading/src/runtimes/anthropic-api.ts` (today a stub that answers `AIG_RUNTIME_NOT_IMPLEMENTED`).

## Why

The compliance frame in `docs/05-ai-pipeline.md` allows the subscription only for the owner's ordinary use. Paid customers, or volume beyond one person, need a metered key. The queue, the audit rows and the billing meter (FU-A4) already exist, so API mode is a runtime swap plus a budget gate.

## Key handling

- One platform key, `ANTHROPIC_API_KEY`, read by `modules/00-core` config, present only in the api container env (`infra/.env`, not in git). Never per tenant, never in the database. A tenant key (BYOK) stays rejected (FR9: support cost, key leakage through tenant admins).
- The runtime reads the key once at boot. A missing key with mode `anthropic-api` fails boot, like other required env (RCA 2026-10-02, blank flag at boot).
- Logs never print the key. The grading row records `model` and `prompt_version_sha` as today, not the key id.
- The Agent SDK import stays inside `runtimes/anthropic-api.ts` (CLAUDE.md rule 2). The plain Messages API is enough for the three skills; the SDK is optional.

## Budget gate (FR7)

- Table `tenant_grading_budgets` already exists (`monthly_budget_usd`, `used_usd`, `period_start`, `alert_threshold_pct`, `alerted_at`). No row means not configured.
- Rule: in API mode, before the call, `used_usd >= monthly_budget_usd` with a row present answers 429 `AIG_BUDGET_EXHAUSTED` (code exists). No row = unlimited, as D6 says, because the super admin is the only caller and sees the cost on the row.
- Cost is added after the call, in the same transaction as the accept of the proposals, so a failed or rejected run is not charged to the tenant. A run that is charged but never accepted is still real cost; it is recorded on the job row (below), not on the tenant budget.
- The monthly window reuses the FU-A2 credit-window rule (`cycle_start`, GREATEST guard), not a second calendar.
- The alert at `alert_threshold_pct` goes to the tenant admin through the existing `budget_alert` template path; no new mail.

## Cost table

Two options were compared:

| Option | Where | Verdict |
| --- | --- | --- |
| Columns on `gradings` | `input_tokens`, `output_tokens`, `cost_usd` per grading row | Rejected. One API call grades several questions; the cost would be split by guesswork. |
| Columns on `grading_jobs` | `input_tokens`, `output_tokens`, `cost_usd`, `model`, `price_version` on the job row (one row per Grade click) | Chosen. One call, one row, exact numbers from the API usage object. |

`grading_jobs` has no writer today in claude-code-vps mode; API mode writes one row per click. `docs/02-data-model.md` gets the four columns in the same commit as the migration. The tenant budget `used_usd` is the sum of accepted job rows in the window.

## Eval re-baseline

A model change is a prompt change for the eval harness. Before the flip: run `modules/07-ai-grading/eval/` against the private golden set (VPS only, 150 cases) with the API runtime, compare bands with the blessed baseline, and bless a new baseline. The eval gate on the queue page (`admin.evaluations.queue.eval_gate`) blocks Grade until the new baseline is approved. Same rule as a skill edit.

## codex:rescue gate

The change touches `modules/07-ai-grading/**` (classifier, load-bearing) and the budget path. Per CLAUDE.md: Opus line-by-line diff review, then `codex:rescue` adversarial review before push (Sonnet takeover if codex is down), verdict recorded in the commit trailer. `ci/lint-no-ambient-claude.ts` is not touched: the call path is still the super admin's click.

## Options considered and rejected

- Per-tenant API key (BYOK): compliant, rejected for support cost and key exposure; revisit only on a customer request.
- Background grading after submit: breaks the no-ambient-AI rule; rejected.
- Cost on `gradings` rows: see table.
- A second budget object in module 19 billing: the budget table exists; one source of truth.

## Not included

Any code, migration, env change or price. Company admins triggering AI (stays 403 `AI_EVALUATION_BY_ASSESSIQ`). Streaming, caching or batch API use.

## Downstream impact when built

`docs/05-ai-pipeline.md` (runtime section, budget), `docs/02-data-model.md` (grading_jobs columns), `docs/03-api-contract.md` (429 on grade), `docs/06-deployment.md` (env var), module 19 (plan tier includes an AI answer count, FU-A4 meter), module 16 help text on the budget card, eval baseline file on the VPS.
