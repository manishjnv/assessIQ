# 09-scoring — Aggregation, archetype, leaderboard

**Status: LIVE — shipped G2.B Session 3 (2026-05-01)**

## Purpose
Take per-question gradings + behavioral events and produce: total score, archetype label, cohort comparisons, leaderboard data. The number that goes back to the candidate and into the host app's HRMS lives here.

## Scope
- **In:** sum per-question scores into `attempt_scores`, derive archetype from behavioral signals, compute cohort percentiles, leaderboard projections.
- **Out:** rendering reports (10-admin-dashboard reads this), exports (15-analytics).

## Dependencies
- `@assessiq/core` — AppError, streamLogger
- `@assessiq/tenancy` — withTenant, pool
- `@assessiq/rubric-engine` — types only (scoring math is in-module)
- Reads: `gradings`, `attempt_events`, `attempt_answers`, `attempt_questions`, `attempts`, `assessments`, `users`
- Writes: `attempt_scores`

## Module layout
```
src/
  types.ts        — Zod schemas, ARCHETYPE_LABELS const, CohortPercentiles interface
  archetype.ts    — computeSignals() + deriveArchetype() (pure, no IO)
  repository.ts   — all DB access (RLS-only, no WHERE tenant_id except upsert INSERT)
  service.ts      — orchestrates: computeAttemptScore, cohortStats, leaderboard, individualReport
  routes.ts       — 4 admin Fastify routes
  index.ts        — public re-exports
```

## Decision log

### P2.D11 — archetype_signals stored in JSONB
Signals stored in `attempt_scores.archetype_signals` JSONB so the archetype label is explainable.
Shape: `{ time_per_question_p50_ms, time_per_question_iqr_ms, edit_count_total, flag_count, multi_tab_conflict_count, tab_blur_count, copy_paste_count, reasoning_band_avg, reasoning_band_distribution, error_class_counts, auto_submitted }`.

### P2.D13 — public cross-tenant leaderboard deferred
Public leaderboard (candidates seeing cohort rank) requires DPDP consent review. Deferred to Phase 3+. Current `GET /api/admin/reports/leaderboard/:assessmentId` is admin-only. `anonymize=true` parameter hides candidate PII.

### Archetype cohort gate
`cohortPercentiles === null` (< 2 prior scored attempts) → `archetype = null`. Stored as null in DB. Label is displayed as "Insufficient data" in admin UI until enough attempts accumulate.

### UPSERT idempotency
`computeAttemptScore` uses `INSERT ... ON CONFLICT (attempt_id) DO UPDATE SET ...`. Calling it multiple times is safe — always overwrites with the latest grading data.

### getCohortPercentiles query
Uses `PERCENTILE_CONT(0.25/0.75) WITHIN GROUP (ORDER BY ...)` over `attempt_scores.archetype_signals` JSONB fields. Requires `sample_size >= 2`. Returns null otherwise.

### DISTINCT ON for override-aware grading reads
`getGradingsForAttempt` uses `DISTINCT ON (g.question_id) ... ORDER BY g.question_id, g.graded_at DESC` so human overrides (newer graded_at) win over the original AI grading. No need for `override_of` column traversal in scoring.

## Public surface (API — see docs/03-api-contract.md for full detail)
```
GET  /api/admin/attempts/:id/score              → AttemptScore (compute on demand if not cached)
GET  /api/admin/reports/cohort/:assessmentId    → CohortStats
GET  /api/admin/reports/individual/:userId      → IndividualScore[]
GET  /api/admin/reports/leaderboard/:assessmentId?topN=10&anonymize=false → LeaderboardRow[]
```

## Archetype catalog (deterministic, no LLM)
| Label | Signal |
|---|---|
| `methodical_diligent` | high time, high edits, high reasoning band |
| `confident_correct` | fast, few edits, high score |
| `confident_wrong` | fast, few edits, low score (overconfidence) |
| `cautious_uncertain` | high time, many flags, mid reasoning |
| `last_minute_rusher` | < 30% of answers in first third of attempt duration |
| `even_pacer` | IQR of per-question time < cohort p25 IQR |
| `pattern_matcher` | high MCQ score, low reasoning band |
| `deep_reasoner` | moderate MCQ, high reasoning band |

## Integration: 07-ai-grading → 09-scoring
`handleAdminAccept` (admin-accept.ts) calls `computeAttemptScore(tenantId, attemptId)` after `acceptProposals` returns. Non-fatal try/catch — grading commit is not rolled back on scoring failure. Log key: `grading.scoring.error_after_accept`.

## Deterministic MCQ scoring (2026-10-01)
`src/mcq.ts`: `scoreMcqForAttempt(client, attemptId)` writes `gradings` rows (`grader='deterministic'`, sentinel sha `deterministic-mcq-v1`, `ON CONFLICT DO NOTHING` on the D7 unique index) for every MCQ question, judged against the FROZEN question version; `scoreMcqAndFinalizeIfComplete(client, tenantId, attemptId)` also finalises MCQ-only attempts in the caller's tx (score rollup -> `graded` -> `recordGradedAttempt` -> system audit row). No AI. Callers: 06-attempt-engine (submit, sweep, read-time auto-submit) and 07-ai-grading `handleAdminGrade`. `computeAttemptScoreInTx(client, ...)` is the tx-sharing variant of `computeAttemptScore`. Depends on `@assessiq/billing`. See docs/05-ai-pipeline.md "Deterministic MCQ scoring path".

## Data model touchpoints
Owns: `attempt_scores` (0050_attempt_scores.sql). Writes `gradings` rows with `grader='deterministic'` (MCQ only).
Reads: `gradings`, `attempt_events`, `attempt_answers`, `attempt_questions`, `attempts`, `assessments`, `users`.

## Help/tooltip surface
- `admin.scoring.archetype.disclaimer` — what archetypes are for, what they're not for
- `admin.scoring.archetype.list` — what each label means
- `admin.scoring.cohort.percentiles` — sample-size caveats
- `admin.scoring.leaderboard.privacy` — anonymization options, when to disable

## Deferred / future
- Tenant-defined custom archetypes — Phase 2+ if requested
- Skill-area sub-scores (e.g., "MITRE knowledge: 8/10") — needs question tag rollup
- Public cross-tenant leaderboard — Phase 3+ (DPDP review required, P2.D13)


## Result completion + release (SP1/SP2, 2026-10-01)

**What.** One definition of a *complete* result and one place that publishes it.
- `finalizeAttemptIfComplete(client, {tenantId, attemptId, markEvaluationReleased})` (`src/finalize.ts`) — complete iff EVERY frozen question of the attempt (mcq, subjective, scenario, log_analysis, kql) has an *effective* grading (newest row per question; `admin_override` wins a `graded_at` tie) whose status is not `review_needed`. Then, in the caller's tx: `attempt_scores` rollup, `status → 'graded'` (+ `evaluation_released_at = now()` when asked), review-cache columns cleared, `recordGradedAttempt`. No audit row inside; callers (MCQ system row, accept, override, manual score) keep theirs. The only writer of `status='graded'`.
- `releaseAttemptInTx(client, {tenantId, attemptId, actor, trigger?})` (`src/release.ts`) — the only place a result is published: erased candidate → 422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED`; not `graded` / evaluation not released / an effective grade still `review_needed` → 409 `RESULT_NOT_READY`; flips to `released`; ONE `grading.released` audit row (actor user|system, `after.trigger` manual|auto); certificate via `issueCertificateOnRelease` inside a SAVEPOINT (a cert failure never undoes the release). No email inside — callers email after commit (module 13).

**Why.** KQL was outside the old completion gate (an attempt "graded" with KQL missing), `review_needed` grades counted as done, and release only checked erasure. Owner rule P1: a candidate sees only a complete, final score.

**Considered / rejected.** Counting only AI types (old gate); a new `attempts.status` value (the enum is read by 06/07/09/15 + frontends — state lives in `evaluation_released_*` columns instead); emailing inside the release tx (a mail failure must not roll a published result back).

**Not included.** Phase II (platform evaluation queue, send-back). 09 still must not import 07.

**Impact.** 09 now depends on `@assessiq/certification`. `finalize` clears `attempts.ai_proposals/grading_started_at` (07 migration 0100) — test DBs that finalise must apply it. `getGradingsForAttempt` gained the same admin_override tie-break.
