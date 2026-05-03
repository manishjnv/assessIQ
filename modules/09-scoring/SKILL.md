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

## Data model touchpoints
Owns: `attempt_scores` (0050_attempt_scores.sql).
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
