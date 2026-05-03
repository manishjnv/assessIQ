# 15-analytics — Reports, exports, dashboards

## Status
**LIVE** — Phase 3 G3.C shipped (see docs/SESSION_STATE.md for SHA).

## Purpose
Turn raw attempt + grading data into actionable reports for managers, L&D, and host-app integrations. Read-only over the rest of the system.

## Scope
- **In:** cohort-level reports, individual progression, topic/skill heatmap, archetype distribution, cost telemetry (empty-shape in Phase 3), exports (CSV/JSONL), dashboard tiles for admin home page, nightly MV refresh job.
- **Out:** writing scores (09 owns that), historical raw event stream (read from `attempt_events`), custom report builder (Phase 4).

## Architecture decisions

### D1 — attempt_summary_mv (migration 0060)
A materialized view that joins `attempt_scores → attempts → assessments` for performance. It is refreshed nightly by the `analytics:refresh_mv` BullMQ job (cron `0 2 * * *`). Initial populate: `REFRESH MATERIALIZED VIEW attempt_summary_mv` at deploy time.

**RLS does NOT apply to materialized views.** Every query against `attempt_summary_mv` MUST include an explicit:
```sql
WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
```
The `tools/lint-mv-tenant-filter.ts` lint enforces this invariant.

### D2 — gradingCostByMonth returns [] in Phase 3
The `grading_jobs` table (with per-call cost columns) ships in Phase 4 (`anthropic-api` mode). In Phase 3 (`claude-code-vps` mode), the service returns `[]` immediately after checking `config.AI_PIPELINE_MODE`. The route returns `{ items: [], mode: 'claude-code-vps', message: '...' }`.

### D3 — Export stream architecture
Export routes use `Readable.from(prebuilt-lines[])` rather than cursor-based streaming. Reason: `withTenant()` COMMITs the transaction (ending cursor lifetime) before the lazy stream is consumed. Pre-fetching all rows (bounded by `EXPORT_ROW_CAP = 10_000`) is safe at < 5 MB typical payload.

### D4 — No registration in 09-scoring routes
Routes `/admin/reports/cohort/:assessmentId` and `/admin/reports/individual/:userId` are owned by 09-scoring (G2.B Session 3). Module 15-analytics is the *service layer* those routes call — no route duplication here.

## Dependencies
- `00-core`, `02-tenancy`, `14-audit-log`
- Read-only (via MV + live tables): `attempt_summary_mv`, `attempts`, `gradings`, `attempt_scores`, `attempt_events`, `assessments`, `questions`, `users`

## Public surface
```ts
// Dashboard KPIs
homeKpis(tenantId): Promise<HomeKpis>
queueSummary(tenantId): Promise<QueueSummary>

// Reports (use MV)
cohortReport(tenantId, assessmentId): Promise<CohortReport>
individualReport(tenantId, userId): Promise<IndividualReport>
topicHeatmap({ tenantId, packId, from?, to? }): Promise<TopicHeatmap>
archetypeDistribution(tenantId, assessmentId): Promise<ArchetypeDistributionItem[]>

// Cost telemetry (empty-shape in Phase 3)
gradingCostByMonth(tenantId, year): Promise<CostRow[]>

// Exports (all use MV, hard-capped at EXPORT_ROW_CAP=10_000 rows)
exportAttemptsCsv({ tenantId, filters }): Promise<Readable>
exportAttemptsJsonl({ tenantId, filters }): Promise<Readable>
exportTopicHeatmapCsv({ tenantId, packId, from?, to? }): Promise<Readable>

// BullMQ job (registered in apps/api/src/worker.ts)
processRefreshMvJob(): Promise<{ duration_ms: number }>
ANALYTICS_REFRESH_MV_JOB_NAME = 'analytics:refresh_mv'
EXPORT_ROW_CAP = 10_000
```

## Routes registered (Phase 3)
```
GET /api/admin/reports/topic-heatmap?packId=&from=&to=
GET /api/admin/reports/archetype-distribution/:assessmentId
GET /api/admin/reports/cost-by-month?year=YYYY
GET /api/admin/reports/exports/attempts.csv
GET /api/admin/reports/exports/attempts.jsonl
GET /api/admin/reports/exports/topic-heatmap.csv
```
All export routes audit to `audit_log` with `action: 'attempt.exported'`.

## Lint guards
- `tools/lint-mv-tenant-filter.ts` — asserts every `attempt_summary_mv` SQL reference has the explicit tenant filter. Run via `pnpm tsx tools/lint-mv-tenant-filter.ts`. Self-test: `--self-test`.

## Help IDs (Phase 3)
- `admin.reports.cohort.distribution`
- `admin.reports.heatmap.colors`
- `admin.reports.archetype.disclaimer`
- `admin.reports.export.format`
- `admin.reports.cost.empty_in_claude_code_vps_mode`
- `admin.audit.export.format`
- `admin.audit.archives.restore_procedure`
- `admin.notifications.in_app.short_poll_interval`

## Migration
`modules/15-analytics/migrations/0060_attempt_summary_mv.sql` — creates `attempt_summary_mv` view + 3 indexes (UNIQUE on `(tenant_id, attempt_id)` required for CONCURRENT refresh).

## Tests
`modules/15-analytics/src/__tests__/analytics.test.ts` — 23 integration tests using postgres:16-alpine testcontainer. All pass.

## Open questions
- Custom report builder — defer to Phase 4 unless requested
- Programmatic access via REST (vs CSV download only) — most fields already in API; add explicit endpoints in v2 if needed
- Phase 4: populate `gradingCostByMonth` when `grading_jobs` table ships
