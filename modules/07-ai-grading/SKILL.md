# 07-ai-grading — Multi-stage AI grading pipeline

> See `docs/05-ai-pipeline.md` for the full design. This is the implementation orientation.

## Purpose
Grade subjective and scenario answers using a multi-stage cascade across Claude Haiku → Sonnet → Opus. Provide deterministic grading for MCQ. KQL answers are not auto-graded today: there is no KQL grader in code, and an admin scores them by hand. A design note for running the query exists at `docs/design/2026-10-02-kql-execution-grading.md` (design only, not built). Produce a *proposal* the admin reviews and accepts before it becomes a real `gradings` row.

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
- **Phase 1 runtime auth:** admin's Max OAuth token cached at `~/.claude/` on the VPS (no `ANTHROPIC_API_KEY`). **Auth-mount pattern (2026-05-09):** container runs as `USER root` with whole-directory bind mounts `/root/.claude:/home/node/.claude:rw` + `/root/.claude.json:/home/node/.claude.json:rw`. Per-file mounts are a maintenance trap — every claude version bump can add new state files (`.credentials.json` added in v2.1.137) that per-file mounts silently miss. See `docs/06-deployment.md` § "Claude CLI state mount pattern" and `docs/RCA_LOG.md` 2026-05-09.
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

## Status — Phase 2 G2.A live as of 2026-05-03 (1.b)

The implementation slot reserved by D1-D8 is now LIVE in `claude-code-vps` mode. Phase 1 G2.A Session 1.b shipped:

- **Runtime** at `src/runtimes/claude-code-vps.ts` — real `runClaudeCodeGrading` body. Spawns `claude -p` with `--allowed-tools mcp__assessiq__submit_*`, `--disallowed-tools Bash,Write,Edit,Read,Glob,Grep`, `--output-format stream-json`, `--max-turns 4`, 120s timeout per stage. Stage 1 → submit_anchors; Stage 2 → submit_band; Stage 3 (when `band.needs_escalation === true` OR `input.force_escalate === true`) → grade-escalate. Reconciliation: ≥2-band Stage 2/3 disagreement → `escalation_chosen_stage='manual'` (admin sees both); <2 → Stage 3 wins. D4 SHA pinning composes `anchors:<8hex>;band:<8hex>;escalate:<8hex|->`.
- **Helpers** at `src/{single-flight,skill-sha,stream-json-parser,score}.ts` — D7 in-process `Map<attemptId>` mutex; sha256 + minimal regex frontmatter parser; line-delimited JSON splitter + `parseToolInput` with EXACT `mcp__assessiq__<short>` prefix match (rescue Finding #2 fix).
- **9 admin handlers** at `src/handlers/admin-*.ts` — grade / accept / override / rerun / queue / claim+release / grading-jobs (D3 stub) / budget. All RLS-scoped via `withTenant`. Override-vs-replace structurally enforced (zero `UPDATE gradings` statements; INSERT-only with `override_of` FK + `override_reason`).
- **Routes registrar** at `src/routes.ts` — 10 endpoints under `/api/admin/{attempts,gradings,dashboard,grading-jobs,settings}/*`. Override uses `adminFreshMfa(5min)` chain.
- **3 in-repo skills** at `prompts/skills/grade-{anchors,band,escalate}/SKILL.md` (Haiku/Sonnet/Opus, temperature 0.0, frontmatter `version: v1`).
- **MCP server** at `tools/assessiq-mcp/` — stdio JSON-RPC via `@modelcontextprotocol/sdk` v1, 2 echo tools.
- **Eval harness** at `eval/` — manual run/compare/bless flow with CI guard (exits 0 when CI=true per D5).
- **Lint sentinel correction** — allow-list paths fixed to include `src/` prefix (Session 1.a defect: list referenced `modules/07-ai-grading/runtimes/...` but actual scaffold is `modules/07-ai-grading/src/runtimes/...`). Self-test 8/8 still passes.

Phase 3 critique fixes applied inline:
- **C1** — routes validate `proposal.attempt_id === URL attemptId` (defense vs cross-attempt-within-tenant spoof).
- **H2** — `deriveStatus` distinguishes AI runtime failures (`AIG_*` codes → review_needed) from legitimate rubric error_classes (flow through score-ratio).
- **Rescue #2** — parser uses exact `mcp__assessiq__` prefix match, not loose `endsWith`.
- **Rescue #3** — `acceptProposals` validates each `proposal.question_id ∈ attempt_questions` for the URL attemptId.

Tests: 102/102 passing across 7 vitest files in 12.5s (testcontainer Postgres for handlers + mock-spawn for runtime + tmpdir for eval). Override-never-replaces invariant has a load-bearing testcontainer integration test.

Adversarial sign-off: sonnet-takeover (in lieu of codex:rescue per user preference) — verdict REVISED, 3 of 4 findings accepted + applied, 1 (admin-grade.ts spawn-allow-list tightening) deferred as a separate contract change for a future rescue pass.

What's still NOT live in 1.b:
- `prompt_versions` table (D3 — Phase 3+; SHAs persist on `gradings` rows directly per D4).
- `grading_jobs` table (D3 — Phase 2+ when `anthropic-api` mode lands).
- Real `anthropic-api` runtime (deferred to Phase 3+).
- Open-weights runtime (deferred to Phase 4+).
- Bulk re-grading of Phase 1 attempts (separate task).
- `/srv/assessiq/scripts/grading-audit-hook.mjs` PostToolUse audit script (referenced in `infra/admin-claude-settings.example.json` as `TODO(phase-2-audit)`).

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

> **FU-A10 (2026-10-06): parked, API mode only.** Not built. `tenant_grading_budgets` has no migration today; `GET /api/admin/settings/billing` (`src/routes.ts:538`) always returns a zero-cost stub. See `docs/05-ai-pipeline.md` D6 and FR7 review (2026-10-03): folded into the billing AI meter (PT1-2), not a standalone budget table.

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

## Audit-write coverage (G3.D, doc-backfilled 2026-05-13)

All 5 admin-mutating handlers in `src/handlers/admin-*.ts` write one `audit_log` row inside the same `withTenant` transaction as the domain mutation via `auditInTx(...)`. Eight call sites total across the module — `admin-accept` (1, `grading.accepted`), `admin-claim-release` (2, `grading.claimed` + `grading.released`), `admin-override` (1, `grading.override`), `admin-rerun` (1, `grading.retry`), `admin-generate` (3, all `question.ai_generated`). Coverage-grep guard in `src/__tests__/audit-writes.test.ts` pins those counts; adding a new admin-mutating handler without an audit write fails the test.

Why this matters: Phase 1 grading's compliance frame in [docs/05-ai-pipeline.md § Compliance frame](../../docs/05-ai-pipeline.md) hinges on every inference-triggering action being admin-attributable. The audit row + `gradings.graded_by` + `gradings.prompt_version_sha` are the three-way receipt that the call ran inside the human-in-the-loop boundary. See [docs/11-observability.md § 29](../../docs/11-observability.md) for the full per-site contract.


## Completion gate, manual score, release (SP1/SP2, 2026-10-01)

- `handleAdminAccept` no longer owns the gate: it calls 09 `finalizeAttemptIfComplete` (billing + cache clear moved inside it; whether the completion also hands the result to the tenant is the caller's `markEvaluationReleased` input — see "Release on the last accept" below). A partial accept, a `review_needed` grade or an ungraded KQL question keeps the attempt `pending_admin_grading`.
- `handleAdminOverride` refuses a published result (409 `RESULT_ALREADY_PUBLISHED`), recomputes `attempt_scores` in the same tx (the old never-called `recomputeOnOverride` seam) and finalises when the override completes the result. Still exactly one `grading.override` audit row, reason text never in audit. `score_earned` must be finite and within `0 … original.score_max` (else 422 `AIG_INVALID_BODY`, `details.score_max`) — an unbounded override flowed straight into the rollup and the published percentage/pass/certificate tier.
- **Every gradings writer locks the attempt row first** (`SELECT … FROM attempts WHERE id = $1 FOR UPDATE`): accept, override, manual-score and 09 release share that lock, so the order is always attempt row → everything else. `handleAdminAccept` takes it before writing anything and refuses a published result (409 `RESULT_ALREADY_PUBLISHED`, nothing written; unknown attempt → 404 `AIG_ATTEMPT_NOT_FOUND`), so an accept can no longer add a `review_needed` grade between a Release's flagged-grade check and its commit. The handler also rejects a proposal whose `attempt_id` differs from `attemptId` (422; the route already did with 400) so the lock cannot be sidestepped by writing grades onto another attempt.
- **`attempt_scores` is rolled up inside the accept tx.** `finalizeAttemptIfComplete` rolls up when it flips the status; when it does not (partial accept, or a re-run accepted on an already-`graded`, unpublished result) `acceptProposals` calls `computeAttemptScoreInTx` itself, under the attempt lock, before the audit row. There is no post-commit recompute any more: it left a window in which a Release could publish a stale total (and a late recompute then changed a published score). A rollup error now rolls the whole accept back — same semantics as override and manual-score.
- **The accept payload is bounded** (`assertScoresInRange`, handler only): every proposal needs `0 < score_max <= 1000` and `0 <= score_earned <= score_max`, finite, for the proposal's own `score_earned` AND for `edits.score_earned`; otherwise 422 `AIG_INVALID_BODY` with `details {question_id, score_max}`, before any tx is opened (one bad proposal rejects the whole request). The body is client-echoed (ACCEPT_BODY_SCHEMA is `z.number()`), so an unchecked value reached `gradings`, the rollup and the published percentage/tier; `>= 10^4` also overflowed `NUMERIC(6,2)` as a 500. The bound lives in the handler, not the route zod, so the answer stays the specified 422 (a route bound would be a 400 without details). **Not included / deferred to Phase II:** binding each proposal to what the server actually produced (`attempts.ai_proposals`) — in Phase II accept becomes super-admin only, which makes that the natural place; until then the bound above only guarantees sane numbers, not that they match the rubric. A proposal with `score_max = 0` (malformed rubric; previously stored as `review_needed`) is now rejected with 422 — score it with manual-score.
- `POST /api/admin/attempts/:id/questions/:questionId/manual-score` (`adminFreshMfa`, body `{score_earned, reason 1..500}`) — first human score for an ungraded question (KQL has no grader). `admin_override` row, `override_of` NULL, sha/label `manual:v1`, model `manual`, `score_max = questions.points`; audit `grading.override` `{kind:'manual_first_score'}`. 409 if the question already has a grade, 409 if released. No AI call.
- `handleAdminReleaseAttempt` delegates to 09 `releaseAttemptInTx`, then emails via 13 `sendResultReleasedEmail` after commit (static imports; the old `new Function` dynamic imports are gone). `POST /api/admin/assessments/:id/release-all` releases every ready, non-erased result of an assessment, one tx each → `{released[], skipped[{id,code}]}`.
- Audit pins: the release audit is pinned in 09 `release.test.ts`; `admin-claim-release.ts` no longer writes `grading.claimed` (Phase II — see "Platform evaluation queue" below).
- New dependency: `@assessiq/notifications`.
## Platform evaluation queue — AI evaluation only by the super admin (Phase II, 2026-10-01)

**What changed.** The owner (whose Claude subscription runs Claude Code on the VPS) is the only person who evaluates written answers; tenants review and publish. The AI trigger is unchanged in kind (admin click, sync, single-flight, heartbeat; D2/D7/D8 and `lint:ambient-ai` untouched) — only WHO clicks changed.

- **Tenant routes** `POST /api/admin/attempts/:id/{grade,accept,rerun}`, `…/questions/:qid/manual-score`, `POST /api/admin/grading-jobs/:id/retry` → **403 `AI_EVALUATION_BY_ASSESSIQ`** for every caller (kept so a stale client gets a clear error; no handler is reachable from them). `GET /api/admin/attempts/:id` (`handleAdminClaimAttempt`) is **read-only**: the old claim (`submitted → pending_admin_grading`) and its `grading.claimed` audit row are gone (attempts simply stay `submitted` until finalised; nothing depended on the persisted `pending_admin_grading`). The payload adds `evaluation_status` (`awaiting_evaluation` | `ready_to_publish` | `published`, derived in `repository.deriveEvaluationStatus` from `status` + `evaluation_released_at`), `evaluation_released_at/_note/_sent_back_at` and `score` (`attempt_scores` summary). For tenants `ai_proposals` and `grading_started_at` are ALWAYS null, and while `awaiting_evaluation` `gradings` is `[]` and `score` null (one place: `loadAttemptReview`). The attempts list and dashboard queue rows carry `evaluation_status` too (the queue still lists only pre-graded rows).
- **Tenant override** `POST /api/admin/gradings/:id/override` passes `requireEvaluationReleased` → 409 `EVALUATION_NOT_RELEASED` unless status `graded` AND `evaluation_released_at` set (checked under the attempt lock, after the published check → `RESULT_ALREADY_PUBLISHED`). **Send back** `POST /api/admin/attempts/:id/send-back {note 1..500}` (adminOnly, `handleAdminSendBack`): only `graded` + released; clears `evaluation_released_at/_by`, stores `evaluation_note` + `evaluation_sent_back_at`, status stays `graded` (so NO re-billing — billing is only on the finalize flip); audit `grading.sent_back` WITHOUT the note.
- **Platform routes** (`src/routes-super.ts`, chains injected by `apps/api routes/admin-super-evaluations.ts`): `GET /api/admin/super/evaluations[?tenant_id]` (queue, all tenants, oldest first, NO candidate PII, `counts{pending, older_than_24h}`), `GET …/:attemptId` (blind review payload + `tenant_id/tenant_name` + evaluation meta, no side effects), `POST …/:attemptId/{grade,accept,rerun}`, `…/questions/:qid/manual-score` and `…/gradings/:gid/override` (fresh MFA), `…/:attemptId/release-to-tenant` and bulk `POST …/release-to-tenant {attempt_ids[1..200]}`. **Tenancy:** a super session carries the PLATFORM tenant, so every per-attempt route calls `resolveEvaluationTenant(attemptId)` (read-only system-role lookup → 404 unknown; `assertTenantActive` → 409 for suspended) and runs the existing handler with that tenantId + the super's userId inside `withTenant`; the only RLS-bypassing code is READ ONLY (`BEGIN READ ONLY` + `SET LOCAL ROLE assessiq_system`). Audit rows land in the TARGET tenant's log with the super admin as actor.
- **Handlers' `markEvaluationReleased` is an input, default FALSE (fail-closed)** for accept / manual-score / override. **Superseded 2026-10-01 for the platform routes:** they now pass `true` — the accept / manual score / override that completes an attempt also releases it (see "Release on the last accept" below). **release-to-tenant** (`handleSuperReleaseToTenant`, audit `grading.evaluation_released`) stays as the recovery step — requires `graded`, every question effectively graded and none `review_needed`, candidate not erased (422), not already released/published (409). `handleAdminOverride` also takes `expectedAttemptId` (the platform route passes the URL's attempt so a mismatched grading id → 404).
- Known gaps (deliberate): `handleAdminGrade` still accepts only pre-graded statuses, so a SENT-BACK attempt (status `graded`) is re-evaluated with override / manual-score / the attempt-level **Re-run AI** (see below), not "Grade all"; `grade` writes no audit row (pre-existing, proposal-only).
- Audit pins: `admin-claim-release.ts` now has ZERO audit sites (read-only GET + 09 release delegate); new sites `admin-send-back.ts` (`grading.sent_back`) and `super-evaluations.ts` (`grading.evaluation_released`). Tests: `super-evaluation.test.ts` (queue, cross-tenant lifecycle, refusals, routes) + the updated pins in `audit-writes` / `handlers` / `completion-gate`.

## Release on the last accept + Re-run AI for sent-back attempts (owner decision, 2026-10-01)

**What changed.**

- **The platform routes pass `markEvaluationReleased: true`** (`routes-super.ts`: accept, manual-score, override). The call that COMPLETES a pre-graded attempt (finalize flips it to `graded`) also sets `evaluation_released_at = now()` and `evaluation_released_by = <the super admin>` in the same statement and tx, so the company sees it as `ready_to_publish` at once and the Auto-mode sweep (`released_at >= result_release_auto_since`) can publish it. 09 `finalizeAttemptIfComplete` got an optional `releasedBy`; the handlers always pass their `userId` (used only when the hand-over happens). The handler default stays `false`, and so does every non-platform caller.
- **No new audit call site.** The hand-over is recorded as `after.evaluation_released: true` on the call's own audit row (`grading.accepted` / `grading.override`, key present only when it happened). Accept already wrote its row after finalize; manual-score and override now run rollup + finalize BEFORE their audit row (same tx, so atomicity is unchanged) so the row can say so.
- **Never auto-released:** a sent-back attempt (already `graded`, `evaluation_released_at` NULL; finalize does not re-flip it) — the evaluator uses release-to-tenant, which stays as the single and bulk recovery action; an erased candidate (`isAttemptCandidateErased`, same gate as release-to-tenant, so the completed attempt stays `graded` and unreleased, and release-to-tenant still answers 422).
- **Re-run AI (`POST …/rerun` on a `graded`, unreleased attempt).** `handleAdminRerun` then behaves like Grade all: it holds the `grading_started_at` marker for the run (cleared on success or error) and caches the returned proposals in `attempts.ai_proposals`, so the page can poll and a proxy timeout loses nothing; on a pre-graded attempt it is unchanged (stateless, per-question Opus helper). It now resolves the rubric with the same `resolveGradingRubric` as Grade all (synthesised / holistic fallback; extracted from `admin-grade.ts`, behaviour-identical) — before, a re-run failed on every rubric-less scenario / log_analysis / subjective question. release-to-tenant clears `ai_proposals` so unaccepted proposals do not resurface after a later send-back.
- **Accepting a re-run result writes NEW rows (D7 fix).** The idempotency key `(attempt, question, prompt_version_sha) WHERE override_of IS NULL` made accept skip a re-run whenever the prompts had not changed (the SKILL used to list it as a known gap). On an already-`graded` attempt a proposal generated AFTER the question's newest grading (any grader, compared in SQL via `isProposalNewerThanGradings`) is now written as a new `grader='ai'` row with `override_of` = the same-sha row it supersedes, which satisfies the partial unique index; newest wins and `attempt_scores` is recomputed in the same locked tx (unchanged). A proposal at or before the newest grading is a replay / stale tab and is skipped as before, so it can never overwrite a newer grade or a human override. Pre-graded attempts keep the plain D7 skip. `accept` now answers `attempt.status = 'graded'` for an already-graded attempt (it used to say `pending_admin_grading`, which the audit row also recorded).

**Why.** Owner decision: accepting each grade is already the review; a separate "Release to company" click per attempt was ceremony.

**Considered and rejected.** Releasing inside `release-to-tenant` only (no change); a new audit action or extra audit call site (the audit-writes pins count call sites per file); auto-releasing a sent-back attempt on its next accept (finalize would have to re-flip a graded attempt: billing risk); relaxing the D7 unique index or suffixing `prompt_version_sha` (the SHA is the reproducibility pin); keying the supersede rule on a new request flag (more API surface than a timestamp comparison needs).

**Not included.** Forcing Stage 3 on Re-run AI (the per-question Re-run keeps `forceEscalate`); a retry of a stalled marker beyond the page's existing 10-minute rule; touching the tenant routes, the worker or `lint-no-ambient-claude.ts`.

**Impact.** 09 `finalize.ts` (`releasedBy`); 10 `AttemptGradingPanel` / `evaluation-detail` (notice, success state, Re-run AI); 16 help rows (0118); the owner test script (T3.11–T3.12 no longer click Release to company after Accept all). `docs/03` (accept status, rerun caching), `docs/05` and the audit payload shape change with it.

## Scoring and result release: file map and invariants (2026-10-01)

**New files** (behaviour is in the two sections above and in `docs/05-ai-pipeline.md` § Platform evaluation queue):

- `src/routes-super.ts`: the platform routes (`/api/admin/super/evaluations*`); chains are injected by `apps/api/src/routes/admin-super-evaluations.ts`. It reuses the zod body schemas exported from `routes.ts`.
- `src/handlers/super-evaluations.ts`: queue list, `resolveEvaluationTenant`, `assertInEvaluationQueue`, the blind review payload, release-to-tenant (single and bulk). It holds the module's only RLS-bypassing code, a `READ ONLY` system-role transaction (`withSystemReadOnly`).
- `src/handlers/admin-send-back.ts` (tenant send-back), `admin-manual-score.ts` (first human score, e.g. KQL), `admin-release-all.ts` (bulk publish). `admin-claim-release.ts` is now a read-only review loader (`loadAttemptReview`, audiences `tenant` and `platform`) plus the publish call into 09.
- `src/repository.ts` additions: `deriveEvaluationStatus`, `getAttemptProgress`, `listSuperEvaluationQueue` (with `SUPER_QUEUE_LIMIT` 500). `src/types.ts` error codes: `AI_EVALUATION_BY_ASSESSIQ`, `EVALUATION_NOT_RELEASED`, `EVALUATION_NOT_COMPLETE`, `EVALUATION_ALREADY_RELEASED`, `RESULT_ALREADY_PUBLISHED`, `AIG_QUESTION_ALREADY_GRADED` (`NOT_IN_EVALUATION_QUEUE` is a literal in `super-evaluations.ts`).

**Invariants** (keep them when you touch this module):

1. **Lock the attempt row first.** Accept, override, manual score, send-back, release-to-tenant and the 09 release all start with `SELECT … FROM attempts … FOR UPDATE`; the lock order is the attempt row, then anything else.
2. **Billing in the same tx as the status flip, once per attempt.** Only 09 `finalizeAttemptIfComplete` flips to `graded` and bills. Send-back keeps `graded`, so it never re-bills.
3. **Exactly one `auditInTx` row per mutation,** in the same tx and in the attempt's own tenant log. Free text (override reason, send-back note) is never in `after`.
4. **A published result is final.** Accept, override, manual score, send-back and release-to-tenant answer 409 `RESULT_ALREADY_PUBLISHED` once `status = 'released'`.
5. **Fail-closed hand-over.** Accept, override and manual score default to `markEvaluationReleased = false`; `evaluation_released_at` is set only by release-to-tenant, by 09's all-MCQ completion, and (2026-10-01) by the platform routes' completing accept / manual score / override — never for an erased candidate and never for an attempt that was already `graded` (a sent-back one).
6. **Blind evaluation.** The platform payload and queue carry no candidate name or email; erased candidates are never listed, released or emailed.
7. **No new AI call site.** The platform routes call the existing `handleAdminGrade` / `handleAdminRerun`, and only after `assertInEvaluationQueue` has passed. `ci/lint-no-ambient-claude.ts` was not edited; the worker and module 06 do not import `@assessiq/ai-grading`.
8. **No new cross-tenant write path.** Per-attempt platform routes resolve the tenant from the database, then run inside `withTenant(<that tenant>)`.
9. **The queue predicate lives in three places** (`listSuperEvaluationQueue`, `assertInEvaluationQueue`, `apps/api/src/jobs/evaluation-queue-alert.ts`); change them together.

**Considered and rejected.** A new `attempts.status` value for the hand-over (columns instead); tenant-triggered AI (the compliance frame). **Not included.** Async grading, API mode, per-tenant AI. **Impact.** 06 `result.ts` reads the evaluation columns; 15 results CSV and candidate stats key on `evaluation_released_at` / `released`; 10 admin-dashboard shares `AttemptGradingPanel` between the platform evaluate page and the company review page.

## numeric / multi_select are never sent to AI (2026-10-02)

Only the "non-MCQ" evaluation-queue predicates changed: `q.type <> 'mcq'` became `q.type NOT IN ('mcq','numeric','multi_select')` in `repository.ts` (super-admin queue lateral join) and `handlers/super-evaluations.ts` (`assertInEvaluationQueue`), so an attempt made only of deterministic types never enters the queue. `AI_GRADEABLE_TYPES` (`admin-grade.ts`, `admin-rerun.ts`) is an allowlist (subjective / scenario / log_analysis) and needed no change. The lint guard `ci/lint-no-ambient-claude.ts` is untouched.

## Least-AI tiers 1-2: rule + reuse (SP5, 2026-10-02)

`handleAdminGrade` now resolves each AI-gradeable question through `src/least-ai.ts` BEFORE the runtime. Both tiers return ordinary `GradingProposal`s tagged `source: 'rule' | 'reuse'` (optional field, absent = AI) and are cached in `attempts.ai_proposals` like AI ones. D8 is unchanged: no `insertGrading` here, the evaluator's Accept still writes the row (as `grader='ai'`, `model='rule'|'reuse'`). The runtime is never called for a question a tier resolves; if every question resolves, no AI call happens.

- **Tier 1 rule:** all string leaves of the answer, whitespace stripped, < 3 chars -> band 0, "No answer given", sha `rule:blank-v1`. Never awards marks, no keyword matching. Off-topic detection is out of scope (needs AI).
- **Tier 2 reuse key:** same tenant (RLS) + `question_id` + `attempt_questions.question_version` + same points + identical normalised answer (trim, collapse whitespace, case-fold, structure kept) + source grading pinned to the CURRENT `grade-band` (and `grade-anchors` when stage 1 ran) skill sha. Source must be `grader='ai'`, `status` correct/incorrect/partial, the newest grading of its question (so an overridden or re-evaluated grade is NOT reused), on a graded/released attempt. Matching sources that disagree on score -> no reuse. Skills unreadable -> no reuse. Proposal sha is `reuse:<source sha>` (distinct from AI so a later Re-run is not idempotent-skipped); reason "Same answer as an earlier accepted grade", `reused_from_grading_id` points at the source.
- **Why admin overrides are not sources:** an override row is one human's judgment with a reason, and a superseded AI grade is no longer final; only an untouched accepted AI grade is safe to repeat.
- **Not touched:** `admin-rerun.ts` (explicit Re-run stays AI), prompts/skills, the lint guard. UI: `GradingProposalCard` shows a "Rule" / "Reused" chip.

## Erased candidates (E3, 2026-10-02)

Release / release-all / release-to-tenant already refuse an erased candidate (422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED`). `handleAdminManualScore` and `handleAdminOverride` now also refuse (409 `CANDIDATE_ERASED`, via `isAttemptCandidateErased`). Accept / grade / rerun are deliberately NOT guarded: an erased candidate's already-submitted attempt may still complete (billing invariant) but is never handed over (see super-evaluation.test.ts).

## High-stakes two-model vote (E1, 2026-10-02)

`assessments.settings.high_stakes` (default off; set at create or `PATCH /api/admin/assessments/:id/grading`). `loadGradingData` in admin-grade / admin-rerun reads it and passes `GradingInput.high_stakes`. In `claude-code-vps.ts`: Stage 3 always runs; ANY band difference (>=1) -> `escalation_chosen_stage="manual"` (Stage 2 band primary, deriveStatus -> `review_needed`); equal bands -> `"3"`; Stage 3 failure/malformed -> `error_class=AIG_ESCALATION_FAILURE` (review, excluded from Accept-all by `isAiFailure`). Non-high-stakes behaviour is unchanged (>=2 -> manual; failure -> legacy `escalation_failure`). `least-ai.ts` skips tier 2 (reuse) under high_stakes; tier 1 (blank -> band 0) stays. The super-admin evaluation payload exposes `attempt.high_stakes` (badge). `anthropic-api.ts` has no escalation path, so it is unchanged. Still proposal-only: D8 and no-ambient-AI untouched.

## Eval gate and override quality (E2, 2026-10-02)

`src/eval-gate.ts`: `assertEvalGate()` (before any AI spawn in grade-all and re-run) and `getEvalGateStatus()`. A prompt set is approved iff a baseline in `eval/baselines/` has the same `skill_shas` (anchors, band, escalate). `AI_EVAL_GATE` = off | warn (default) | enforce (409 `AIG_EVAL_GATE`; unknown value = enforce). Super routes: `GET /api/admin/super/eval-gate`, `GET /api/admin/super/grading-quality?days=` (view `grading_override_quality`, migration 0140). CLI `harvest-overrides` writes gitignored `eval/cases-private/` (student answers: never commit). The eval MUST run inside the api container (`docker exec ... assessiq-api`); the baselines mount is rw (`a789ab5`). Do not set `enforce` before the first bless. Full steps: eval/README.md and docs/06-deployment.md "Batch 5 deploy". Also: migration 0142 `generation_batches` (E6) is owned here; `admin-generate.ts` updates it best-effort.

## Dashboard queue counts (RV16, 2026-10-03)

`GET /api/admin/dashboard/queue` (`handleAdminQueue`) returns `{ items, counts }`. `counts` comes from `countGradingQueue` in `src/repository.ts`: one RLS-scoped `COUNT(*) FILTER` query that returns `in_queue`, `awaiting_evaluation` and `ready_to_publish`. The list `items` is capped (the dashboard sends `?limit=50`), so the cards must read `counts`, not the list length. `listGradingQueue` now also includes `auto_submitted` attempts (timer expiry), as the platform queue (`listSuperEvaluationQueue`) already did. **KEEP IN SYNC:** `listGradingQueue`, `countGradingQueue` and `deriveEvaluationStatus` must use the same status rules; change one and check the other two. No dedicated index: one tenant's attempts bound the scan (add a partial index on `attempts (tenant_id, status)` past about 100,000 attempts, task N22). Test: `handlers.test.ts` case 5.3.

## Generation plan, topic focus, attempts status list (2026-10-03)

- **RV64.** `handlers/admin-generate.ts` has ONE `runGenerationPlan` for sharded, single-call and chunked paths: concurrency 2, `allSettled`, citation filter, topic de-dup against existing and merged questions on every path, difficulty gate, insert, one `auditInTx` (real mode, model, de-duplicated skill shas), finalize only in `finally`. `stderr_tail` is aggregated with `--- chunk: <label> ---` headers. Chunked concurrency went from 3 to 2. Review: Sonnet takeover accept; fixes in `a7ea234`.
- **RV62.** `topicFocus` flows route body (max 200 chars, no control characters, else 400 `INVALID_PARAM`) to the runtime input. The wizard has no field yet; the skills must read it (deploy event). Details: docs/05.
- **RV58.** `GET /api/admin/attempts?status=` takes a comma-separated list; each value is checked against the status enum, a bad value gives 400 `AIG_INVALID_BODY` (`routes.ts`, `handlers/admin-attempts-list.ts`, `repository.ts`). Module 15 `homeKpis` / `queueSummary` keep the old filter with a comment (no callers).
- **SP7.** The "needs evaluation" predicate in `repository.ts` and `handlers/super-evaluations.ts` excludes `structured_case` (commit `860bfc3`).
