# 07-ai-grading — Multi-stage AI grading pipeline

> See `docs/05-ai-pipeline.md` for the full design. This is the implementation orientation.

## Purpose
Grade subjective and scenario answers using a multi-stage cascade across Claude Haiku → Sonnet → Opus. Provide deterministic grading for MCQ. Pattern-match KQL. Produce a *proposal* the admin reviews and accepts before it becomes a real `gradings` row.

## Scope
- **In:** the `gradeSubjective(input)` interface and three runtime implementations (`claude-code-vps`, `anthropic-api`, `open-weights`); the synchronous admin-grade handler (Phase 1); the three-stage cascade (anchor extraction → reasoning band → escalation); skill-based prompt management with sha256 versioning; structured-output enforcement via a custom MCP server (Phase 1) or Agent SDK custom tools (Phase 2); golden-set evaluation harness; CI lint that blocks ambient/non-admin invocations of the grader.
- **Out:** scoring aggregation and archetype (09), rubric authoring (08 — though we consume the rubric structure), notifications.

## Operating mode (Phase 1, current)
`AI_PIPELINE_MODE=claude-code-vps` — synchronous admin-in-the-loop grading via Claude Code CLI on the VPS, authenticated against the admin's personal Max subscription. **No async grading worker, no Agent SDK, no `ANTHROPIC_API_KEY`.** See `docs/05-ai-pipeline.md` for the compliance frame and single-user enforcement rules.

## Dependencies
- `00-core`, `02-tenancy`
- `04-question-bank` — to fetch frozen question + rubric
- `06-attempt-engine` — to fetch answers
- `08-rubric-engine` — rubric data structure
- `09-scoring` — emits "graded" event after writing all per-question gradings
- `13-notifications` — admin alerts on failures
- **Phase 1 runtime auth:** admin's Max OAuth token cached at `~/.claude/` on the VPS (no `ANTHROPIC_API_KEY`).
- **Phase 2 runtime dep (deferred):** `@anthropic-ai/claude-agent-sdk` — imported only inside `runtimes/anthropic-api.ts`, gated behind `AI_PIPELINE_MODE=anthropic-api`. CLAUDE.md rule #2 + `ci/lint-no-ambient-claude.ts` enforce this.

## Public surface
```ts
// Phase 1 — synchronous admin handler (the only entry point in v1)
handleAdminGrade(req, attemptId): Promise<GradingProposal>      // gated on active admin session
handleAdminAccept(req, attemptId, edits): Promise<Grading>      // commits the proposal

// Mode-agnostic core (delegates to the active runtime)
gradeSubjective(input): Promise<GradingProposal>                // returns proposal, never writes

// Skill management (Phase 1 — skills live under ~/.claude/skills/)
listSkills(): Promise<SkillVersion[]>                           // enumerates skills with sha256
skillSha(name): string                                          // sha256 of SKILL.md, used as version ID

// Phase 2 — async worker entry (DEFERRED until paid-API mode is enabled)
// startGradingWorker(): void
```

## Models used (latest as of project start)
- Anchor extraction: `claude-haiku-4-5` (pinned in `grade-anchors` skill frontmatter)
- Reasoning band: `claude-sonnet-4-6` (pinned in `grade-band` skill)
- Escalation: `claude-opus-4-7` (pinned in `grade-escalate` skill)

Tenant `ai_model_tier` overrides (Phase 2 only — Phase 1 is single-admin so all tenants share the cascade):
- `basic`: Haiku for everything
- `standard`: default cascade above
- `premium`: always Stage 3 (Opus)

## Data model touchpoints
Owns: `gradings` (writes only after admin accepts; 09-scoring reads). Phase 2 adds `grading_jobs` and `prompt_versions`. Partial reads of `attempts` and `questions`.

## Authentication

**Phase 1 (`claude-code-vps`):** the admin's personal Max subscription, authenticated once via `claude login` on the VPS — OAuth token cached in `~/.claude/`. The OS user that runs the backend handler must match the user that did `claude login`. **No `ANTHROPIC_API_KEY` is set.**

The compliance-defensibility of this mode rests on enforcing single-user-in-the-loop invariants (see `docs/05-ai-pipeline.md` § "Compliance frame"): no cron, no scheduler, no candidate-triggered AI call, fresh admin click required for every grading run, admin must accept before commit. The `ci/lint-no-ambient-claude.ts` build check fails if any non-admin code path imports the runtime.

**Phase 2 (`anthropic-api`, deferred):** `ANTHROPIC_API_KEY` env var. Anthropic ToS prohibits using Max OAuth auth in this mode — must be paid API credits. For tenants on Bedrock/Vertex: set `CLAUDE_CODE_USE_BEDROCK=1` or `CLAUDE_CODE_USE_VERTEX=1` and provide cloud credentials.

## Determinism
- `temperature: 0.0` (set in skill frontmatter for Phase 1; SDK option for Phase 2)
- Skills versioned by sha256 of `SKILL.md`; the version ID is stored in every `gradings` row and audit log entry
- Phase 1: malformed/missing tool call → mark `gradings.status='review_needed'`, surface to admin who grades manually or retries
- Phase 2: SDK retries on transient errors (network, 5xx, rate limit) with exponential backoff before falling through to `review_needed`

## Eval harness
`modules/07-ai-grading/eval/` holds 50 hand-graded answers per question type. CI runs the eval on every prompt change; fails if model agreement with golden set drops below 85%. Used to validate prompt edits before publishing.

## Help/tooltip surface
- `admin.grading.queue` — explanation of grading job lifecycle, typical times
- `admin.grading.retry` — when to retry a failed job
- `admin.grading.review_needed` — what triggers it (low confidence, schema violation, content policy)
- `admin.grading.cost` — model tier cost implications

## Open questions
- Per-pack model overrides — defer; tenant-level is enough for v1
- Self-hosted models for sensitive deployments (e.g., Llama via Bedrock) — design supports it via SDK provider switch; not built v1

## Decisions captured (2026-05-01)

Mirror of `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" — full rationale, alternatives rejected, and downstream impact live in the doc; the rule each decision pins is summarized here so a session reading only this SKILL.md sees the contract. **Future grading-related code or migration changes cite the decision number from the doc, not from here.**

### D1 — `AI_PIPELINE_MODE` allowed values

`claude-code-vps` (Phase 1 default; admin Max OAuth at `~/.claude/`), `anthropic-api` (Phase 2; `ANTHROPIC_API_KEY` required and only allowed in this mode), `open-weights` (future). Single static dispatch in `modules/07-ai-grading/index.ts` selects the runtime by mode at process start. `ANTHROPIC_API_KEY` MUST be unset in `claude-code-vps` mode (defense-in-depth via `00-core/src/config.ts` Zod schema). The Agent SDK import is allowed only in `runtimes/anthropic-api.ts` regardless of mode (D2 lint).

### D2 — Definition of "ambient" + lint contract

**"Ambient" = any code path that fires a Claude Code invocation without a fresh, just-now admin click.** The future `ci/lint-no-ambient-claude.ts` lint MUST encode the contract below; subsequent edits go through `codex:rescue` (load-bearing path).

Allowed call sites for `claude` spawn / `runClaudeCodeGrading` import: only `handlers/admin-grade.ts` and `runtimes/claude-code-vps.ts`. The handler verifies `req.session.admin` + `AI_PIPELINE_MODE === "claude-code-vps"` + heartbeat <60s + single-flight (D7).

Static rejection patterns (each is a build fail):
1. `claude` CLI invocation outside the two allowed files.
2. `@anthropic-ai/claude-agent-sdk` import outside `runtimes/anthropic-api.ts`.
3. Cron / scheduler / `setInterval`/`setTimeout` callbacks transitively importing the grading runtime.
4. BullMQ `Worker` / `Queue.process` callbacks transitively importing the grading runtime (Phase 2 widens this to allow `apps/worker/grading-consumer.ts` only under `AI_PIPELINE_MODE=anthropic-api`, gated by codex:rescue at first ship).
5. Webhook handlers transitively importing the grading runtime.
6. Candidate routes (`/take/*`, `/me/*`, `/embed/*`) transitively importing the grading runtime.
7. Background-worker entrypoints (`apps/worker/**`) transitively importing the grading runtime (Phase 1: empty allow-list).

### D3 — `grading_jobs` state machine + Phase ownership

Phase 1: **no `grading_jobs` table.** In-flight grading is tracked by the in-process single-flight mutex (D7) plus `attempts.status = pending_admin_grading → graded`. Manual re-trigger only — no auto-retry.

Phase 2: `pending → in_progress → done | failed`. BullMQ producer writes `pending` on `attempt.submitted`; worker claims to `in_progress`; success writes `gradings` row + flips to `done` in one transaction; failure writes `error_class` + `error_message` and leaves the attempt at `pending_admin_grading` for manual retry. Exponential backoff up to 3 attempts on transient errors only. Idempotency key: `(attempt_id, prompt_version_sha)` — UNIQUE constraint in Phase 2.

### D4 — Prompt SHA pinning at row level

`gradings` table carries three columns (added with Phase 2 grading work):
- `prompt_version_sha text NOT NULL` — `anchors:<8-hex>;band:<8-hex>;escalate:<8-hex|->`.
- `prompt_version_label text NOT NULL` — human-readable from skill frontmatter `version:`.
- `model text NOT NULL` — concatenated model identifiers.

`skillSha(name)` reads `~/.claude/skills/<name>/SKILL.md` and returns the first 8 hex chars of the sha256; full hash also lands in `/var/log/assessiq/grading-audit.jsonl`. Drift between stored SHA and current SHA surfaces a "skill version drift" badge in the admin panel; re-grading writes a NEW row, never updates the old (auditable-AI invariant). Re-grading is opt-in per row.

### D5 — Eval-harness baseline contract

Directory layout (ships with first runtime work):

```
modules/07-ai-grading/eval/
├── cases/<id>.{input,expected}.json   # 50 per question type, ≥10 adversarial per type
├── runs/<ISO>/                        # per-run actuals + run.json manifest
├── baselines/<YYYY-MM-DD>.json        # blessed baseline + admin signature
├── run-eval.ts
└── compare.ts
```

Blessing: `pnpm aiq:eval:run` → admin reviews → `pnpm aiq:eval:bless --run <ISO>` writes baseline signed with sha256(baseline + admin user-id).

Failure thresholds:
- **Hard fail** (block deploy): band-classification agreement < 85%; OR Stage-1 anchor F1 < 0.80; OR any adversarial case where Stage 2 returned band 4 (silent injection).
- **Soft fail** (admin must explicitly bless): agreement dropped ≥ 3 percentage points from prior baseline; per-error-class F1 dropped ≥ 10%; new error classes introduced.

CI integration: Phase 1 — manual only (no Max OAuth in CI). Phase 2 — runs in CI on every skill or `runtimes/*` change, gated behind capped `ANTHROPIC_API_KEY_EVAL`.

### D6 — Phase 2 budget enforcement (deferred)

`tenant_grading_budgets` table (Phase 2 migration): `tenant_id PK FK`, `monthly_budget_usd numeric(10,2)`, `used_usd numeric(10,2) DEFAULT 0`, `period_start date`, `alert_threshold_pct numeric(5,2) DEFAULT 80`, `alerted_at timestamptz NULL`. RLS uses the `tenants`-style PK-equals policy.

Enforcement: pre-call check in `runtimes/anthropic-api.ts` rejects if `used_usd >= monthly_budget_usd`. Exhaustion → HTTP 429 → `grading_jobs.status='failed'` with `error_class='budget_exhausted'` → admin notification → attempt stays `pending_admin_grading`. Daily BullMQ rollover job (non-AI) resets per period boundary. Phase 1: N/A.

### D7 — Single-flight semantics for Phase 1

In-process `Map<attemptId, Promise>` mutex in `handlers/admin-grade.ts`. **At most one grading subprocess per API process.** Same-attempt second click → 409 `grading_in_progress`. Different-attempt while busy → also 409. No queueing, no merging, no auto-retry. Single-replica is sufficient for Phase 1 (capacity is admin-time-bound, not request-bound). Phase 2 sidesteps via BullMQ `concurrency: 1` + job-level locking.

### D8 — Anthropic ToS compliance frame

The compliance frame in `docs/05-ai-pipeline.md` § "Phase 1 — Compliance frame" is the canonical, load-bearing argument for the entire Phase 1 architecture. Cite verbatim in any change touching Phase 1 grading code or its lint.

Summary: Anthropic's consumer ToS allows individual subscribers to script their own Claude Code use; it forbids Max-subscription auth in *products* serving other people. Phase 1 stays inside the line by enforcing single-admin-in-the-loop, no ambient triggers, accept-before-commit, and per-invocation audit.

If asked: *"the admin uses their personal Anthropic Max subscription via Claude Code as a productivity tool to assist their grading work. AssessIQ does not call Anthropic APIs."*

Any "small refactor" that moves grading into a worker, adds auto-retry, or lets candidates trigger inference must propose `AI_PIPELINE_MODE=anthropic-api` first (paid API, with D6 budget enforcement) — never silently undermine Phase 1's frame.

### Carry-forward (out of scope, flagged)

`docs/01-architecture-overview.md:30–80` is stale: still shows BullMQ grading queue + Agent-SDK worker. Pre-2026-04-29 architecture, superseded by the sync-on-click flow in `docs/05-ai-pipeline.md`. A future architecture-overview rewrite session redraws this; not in Window D scope.
