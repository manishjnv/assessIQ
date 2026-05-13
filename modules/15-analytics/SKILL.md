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

## Routes registered (Phase 9 — Admin Activity)
```
GET /api/admin/activity/stats?from=&to=&groupBy=
GET /api/admin/activity/heatmap?from=&to=
GET /api/admin/activity/timeline?from=&to=
GET /api/admin/activity/leaderboard?period=&page=&pageSize=
```
Each endpoint owns its full vertical slice in `src/activity/<name>.ts` (types + Zod + SQL + service + route registrar). All 4 are read-only (no audit-log writes — analytics surface).

### Phase 9 architecture decisions

**D5 — split data sources by staleness tolerance.**
- `stats` + `timeline`: read `attempt_summary_mv` (joined to `question_packs` on `pack_id`, `levels` on `level_id`). Acceptable to be up-to-24h stale; the MV's nightly refresh is fast and these aggregates don't need same-day precision. Explicit MV tenant filter required (`current_setting('app.current_tenant', true)::uuid`), enforced by `tools/lint-mv-tenant-filter.ts`.
- `heatmap` + `leaderboard`: read live `attempts` table. Heatmap needs same-day completions to surface immediately (MV staleness would hide today's activity from the visualisation). Leaderboard's week-over-week delta would silently smooth out the most recent ~24h of activity if the MV were used — unacceptable for "what's trending now" semantics. RLS on live tables; no explicit tenant filter needed inside `withTenant`.

**D6 — domain slugs returned raw.** No `domain_display_name` mapping in the DB; backend returns `question_packs.domain` slug values verbatim. Frontend maps slug → display name via a hardcoded module shared across admin and candidate Activity pages. Decision locked in commit `db020d1`.

**D7 — streak math in TS, not SQL.** Postgres window-function approach for computing "current streak" + "longest streak" over 365 daily buckets is more complex than a single TS pass and would still require a separate query for the zero-fill (since `attempts` has no row on inactive days). O(N) TS iteration over the pre-fetched `Map<date, count>` is both simpler and faster.

**D8 — Two-CTE leaderboard with LEFT JOIN.** Current-period CTE produces (assessment_id, pack_id, cnt); prior-period CTE produces (assessment_id, cnt). Outer SELECT does a LEFT JOIN so assessments active in current-period but absent from prior-period still appear with `priorCount: 0` → delta direction `'up'` and `deltaPct: null` (no baseline). Ordering by current count DESC, then pack name ASC for stable rank determinism.

**D9 — group-by column interpolation safety.** Both `stats.ts` and `timeline.ts` interpolate `groupCol` (`'qp.domain'` or `'lv.label'`) into the SQL template. This is safe: the value is derived from a Zod-validated enum that only admits two literal strings, never user input. The string is bound at TypeScript-literal level, not runtime.

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
