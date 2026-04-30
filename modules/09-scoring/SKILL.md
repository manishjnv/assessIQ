# 09-scoring — Aggregation, archetype, leaderboard

## Purpose
Take per-question gradings + behavioral events and produce: total score, archetype label, cohort comparisons, leaderboard data. The number that goes back to the candidate and into the host app's HRMS lives here.

## Scope
- **In:** sum per-question scores into `attempt_scores`, derive archetype from behavioral signals, compute cohort percentiles, leaderboard projections, "ready for promotion" flag based on tenant-defined thresholds.
- **Out:** rendering reports (10-admin-dashboard reads this), exports (15-analytics).

## Dependencies
- `00-core`, `02-tenancy`
- `06-attempt-engine` — reads `attempt_events` for behavioral signals
- `07-ai-grading` — listens for "graded" event then aggregates

## Public surface
```ts
computeAttemptScore(attemptId): Promise<AttemptScore>   // idempotent
recomputeOnOverride(attemptId): Promise<AttemptScore>   // called by override workflow

cohortStats(assessmentId): Promise<{
  attemptCount, averagePct, p50, p75, p90,
  archetypeDistribution: Record<string, number>
}>

leaderboard(assessmentId, { topN }): Promise<LeaderboardRow[]>   // anonymized for candidate view if tenant setting requires
```

## Archetype computation
Archetypes are pattern labels derived from behavioral + scoring signals — useful for L&D coaching, NOT for hiring/firing decisions. Always paired with disclaimer in admin UI.

Initial archetype catalog (extensible per tenant via config):
- `methodical_diligent` — high time per question, high edit count, high band
- `confident_correct` — low time, low edits, high score
- `confident_wrong` — low time, low edits, low score (overconfidence signal)
- `cautious_uncertain` — high time, many flags, mid score
- `last_minute_rusher` — long pause early, burst of activity at end
- `even_pacer` — uniform time distribution
- `pattern_matcher` — high MCQ score, low subjective band (knows answers, can't reason)
- `deep_reasoner` — moderate MCQ, high subjective band

Computation runs in a separate function `deriveArchetype(scoreData, eventData)` returning `{ archetype, signals: { signal_id: value } }`. Signals are stored to make the label explainable.

## Per-question score formula recap
```
mcq:         correct ? points : 0
kql:         keywordHits / expected.length * points (with min 0.2*points if any hit)
subjective:  anchor_score + reasoning_score (from 08)
scenario:    sum of step scores, with dependency penalty (downstream steps capped if upstream wrong)
```

## Data model touchpoints
Owns: `attempt_scores`. Reads: `gradings`, `attempt_events`, `attempts`, `assessments`.

## Help/tooltip surface
- `admin.scoring.archetype.disclaimer` — what archetypes are for, what they're not for
- `admin.scoring.archetype.list` — what each label means
- `admin.scoring.cohort.percentiles` — sample-size caveats
- `admin.scoring.leaderboard.privacy` — anonymization options, when to disable

## Open questions
- Tenant-defined custom archetypes — Phase 2 if requested
- Skill-area sub-scores (e.g., "MITRE knowledge: 8/10") — needs question tag rollup; planned for Phase 2
