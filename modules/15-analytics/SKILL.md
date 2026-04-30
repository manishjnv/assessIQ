# 15-analytics — Reports, exports, dashboards

## Purpose
Turn raw attempt + grading data into actionable reports for managers, L&D, and host-app integrations. Read-only over the rest of the system.

## Scope
- **In:** cohort-level reports, individual progression, topic/skill heatmap, archetype distribution, cost telemetry, exports (CSV/XLSX/JSON), dashboard tiles for admin home page.
- **Out:** writing scores (09 owns that), historical raw event stream (read from `attempt_events`).

## Dependencies
- `00-core`, `02-tenancy`
- Read-only access to `attempts`, `gradings`, `attempt_scores`, `attempt_events`, `assessments`, `questions`

## Public surface
```ts
// dashboard
homeKpis(tenantId): Promise<{ activeAssessments, attemptsThisWeek, awaitingReview, avgPctThisWeek }>
queueSummary(tenantId): Promise<{ inProgress, grading, awaitingReview, ready }>

// reports
cohortReport(assessmentId): Promise<CohortReport>
individualReport(userId, { from?, to? }): Promise<IndividualReport>
topicHeatmap({ tenantId, packId, from?, to? }): Promise<TopicHeatmap>
archetypeDistribution(assessmentId): Promise<{ archetype: string, count: number }[]>

// cost
gradingCostByMonth(tenantId, year): Promise<CostRow[]>

// exports
exportAttemptsCsv({ tenantId, filters }): Promise<Readable>
exportAttemptsJson({ tenantId, filters }): Promise<Readable>
```

## Performance
Reports query the live OLTP DB directly for v1. Acceptable up to ~50K attempts. Beyond that:
- Add a denormalized `attempt_summary_mv` materialized view, refreshed nightly
- Then move heavy reports to a TimescaleDB hypertable on `attempts` (Phase 3)

## Help/tooltip surface
- `admin.reports.cohort.distribution` — how to read score distributions
- `admin.reports.heatmap.colors` — interpretation guide
- `admin.reports.archetype.disclaimer` — paired with 09's
- `admin.reports.export.format` — CSV column reference

## Open questions
- Custom report builder — defer to Phase 4 unless requested
- Programmatic access via REST (vs CSV download only) — most fields already in API; add explicit endpoints in v2 if needed
