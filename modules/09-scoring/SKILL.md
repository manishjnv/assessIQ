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
- `finalizeAttemptIfComplete(client, {tenantId, attemptId, markEvaluationReleased, releasedBy?})` (`src/finalize.ts`) — complete iff EVERY frozen question of the attempt (mcq, subjective, scenario, log_analysis, kql) has an *effective* grading (newest row per question; `admin_override` wins a `graded_at` tie) whose status is not `review_needed`. Then, in the caller's tx: `attempt_scores` rollup, `status → 'graded'` (+ `evaluation_released_at = now()` and `evaluation_released_by = releasedBy ?? NULL` in the SAME statement when asked), review-cache columns cleared, `recordGradedAttempt`. No audit row inside; callers (MCQ system row, accept, override, manual score) keep theirs. The only writer of `status='graded'`.
- `releaseAttemptInTx(client, {tenantId, attemptId, actor, trigger?})` (`src/release.ts`) — the only place a result is published: erased candidate → 422 `AIG_ATTEMPT_NOT_RELEASABLE_ERASED`; not `graded` / evaluation not released / an effective grade still `review_needed` → 409 `RESULT_NOT_READY`; flips to `released`; ONE `grading.released` audit row (actor user|system, `after.trigger` manual|auto); certificate via `issueCertificateOnRelease` inside a SAVEPOINT (a cert failure never undoes the release). No email inside — callers email after commit (module 13).
- **Auto-release gate (adversarial-review fix).** When the resolved trigger is `'auto'` (system actor, or the sweep's explicit `trigger: 'auto'`), `releaseAttemptInTx` re-reads the tenant's CURRENT setting inside its own tx — `SELECT … FROM tenant_settings … FOR SHARE` joined to the attempt — and requires `result_release_mode = 'auto'` AND `result_release_auto_since IS NOT NULL` AND `evaluation_released_at >= result_release_auto_since` (compared in SQL, exact to the microsecond); otherwise 409 `RESULT_NOT_READY` (the sweep skips + cools it down). Reason: the sweep picks candidates in an earlier read, so a switch back to manual (or manual→auto→manual→auto, which moves `auto_since` past the result) between selection and release must win. `FOR SHARE` makes a concurrent switch (02 `updateResultReleaseMode` takes `FOR UPDATE`) either already visible or queued behind this release — never both publish and switch. Lock order is attempt row → `tenant_settings` row (the switch only locks `tenant_settings`, so no cycle). Manual releases (admin click, bulk) are an explicit decision and skip the gate.

**Why.** KQL was outside the old completion gate (an attempt "graded" with KQL missing), `review_needed` grades counted as done, and release only checked erasure. Owner rule P1: a candidate sees only a complete, final score.

**Considered / rejected.** Counting only AI types (old gate); a new `attempts.status` value (the enum is read by 06/07/09/15 + frontends — state lives in `evaluation_released_*` columns instead); emailing inside the release tx (a mail failure must not roll a published result back).

**Not included.** Phase II (platform evaluation queue, send-back). 09 still must not import 07.

**Impact.** 09 now depends on `@assessiq/certification`. `finalize` clears `attempts.ai_proposals/grading_started_at` (07 migration 0100) — test DBs that finalise must apply it. `getGradingsForAttempt` gained the same admin_override tie-break.

## Callers, hand-over flag and invariants (2026-10-01, Phase II addendum)

**New files:** `src/finalize.ts` (`finalizeAttemptIfComplete`) and `src/release.ts` (`releaseAttemptInTx`, `RELEASE_ERROR_CODES`, `ReleaseActor`), exported from `index.ts`; tests `finalize.test.ts` and `release.test.ts`. `mcq.ts` delegates to `finalize.ts` (the old `mcq > 0 && other == 0` shortcut is gone).

| Caller | Calls | `markEvaluationReleased` |
|---|---|---|
| 09 `scoreMcqAndFinalizeIfComplete` (submit, timer sweep, read-time auto-submit, `handleAdminGrade` on legacy all-MCQ attempts) | `finalizeAttemptIfComplete` | `true`: an all-MCQ attempt is complete and visible to the company at once |
| 07 platform `accept`, `override`, `manual-score` (super admin routes) | `finalizeAttemptIfComplete` | `true` since 2026-10-01 (owner decision: the last accept IS the review), with `releasedBy` = the super admin and never for an erased candidate; the 07 handler default stays `false` for every other caller. A sent-back attempt is already `graded`, so finalize never re-flips it and it is not auto-released (explicit release-to-tenant) |
| 07 `handleSuperReleaseToTenant` | its own SQL (not 09) | sets `evaluation_released_at/_by` itself |
| 07 `handleAdminReleaseAttempt`, `handleAdminReleaseAll`, worker `result.auto_release` | `releaseAttemptInTx` | not applicable (`trigger` is `manual` for the first two, `auto` for the sweep) |

**Invariants.**

1. `finalizeAttemptIfComplete` is the only writer of `status = 'graded'`: it locks the attempt row, bills in the same tx and writes no audit row (callers keep theirs; a caller that hands the result over records `evaluation_released: true` on its own existing audit row). `evaluation_released_at` is set at completion time, so the auto-release rule `released_at >= result_release_auto_since` holds.
2. A result is complete only when every `attempt_questions` row has an effective grade (newest row, `admin_override` wins a tie) that is not `review_needed`. The rule is mirrored in 07 `getAttemptProgress` and 15 `results-export`; change them together.
3. `releaseAttemptInTx` is the only writer of `status = 'released'`: erased candidate 422, not ready 409, exactly one `grading.released` audit row, certificate inside a SAVEPOINT, no email inside (callers email after commit).
4. The auto gate inside `releaseAttemptInTx` re-reads the tenant mode under `FOR SHARE`.
5. `computeAttemptScoreInTx` runs inside the caller's tx for every writer (accept, override, manual score, finalize), so `attempt_scores` always matches the grades a concurrent release sees.
6. 09 never imports 07, and nothing in the module calls AI, a model or the network.

**Superseded.** The "Integration: 07-ai-grading → 09-scoring" paragraph above (a post-commit `computeAttemptScore`, log key `grading.scoring.error_after_accept`) no longer exists in code: accept rolls up inside its own locked tx.

## Score max is frozen per attempt (E12, migration 0128)

`score_max` for a question is `attempt_questions.points`, copied from `questions.points` when the attempt started (06). `scoreMcqForAttempt` (`mcq.ts`) reads `aq.points`, not `questions.points`, so editing a question's points after start cannot change the score of an attempt that is not yet graded. The same frozen source feeds 07 AI grading rows, manual-score and admin rerun, so MCQ and AI rows of one attempt always agree. Totals (`service.ts`) and 15 analytics/exports sum `gradings.score_max`, which is already per-row frozen, so they needed no change. Grading algorithm, band scoring and which grader runs are untouched.
