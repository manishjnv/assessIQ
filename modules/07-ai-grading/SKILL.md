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
- **Anthropic API** via `@anthropic-ai/claude-agent-sdk`

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
