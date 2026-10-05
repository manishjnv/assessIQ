# 15-analytics — Reports, exports, dashboards

## Status
**LIVE** — Phase 3 G3.C shipped. UI v1.1 Phase 9 Admin Activity endpoints added 2026-05-13 (4 read-only routes under `/api/admin/activity/*` in [`src/activity/`](src/activity/)). See docs/SESSION_STATE.md for SHAs.

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
Routes `/admin/reports/cohort/:assessmentId` and `/admin/reports/individual/:userId` are owned by 09-scoring (G2.B Session 3). 09-scoring has its **own** `cohortStats`/individual progress implementation in `modules/09-scoring/src/service.ts` that these routes call.

> **FU-C5 (2026-10-06): correction.** The line above used to claim "Module 15-analytics is the service layer those routes call — no route duplication here." That is false: 09-scoring's `cohortStats` does not call this module's `cohortReport`/`individualReport`. The two are an undetected duplicate, not a layering. This module's `cohortReport`/`individualReport` are exercised only by this module's own tests (dormant from the route's perspective) — see `modules/15-analytics/src/repository.ts` `queryCohortReport` comment. FU-C3 is the follow-up to route tenant-visible reads through one tenant-visibility rule (`evaluation_status`/`evaluation_released_at`) before either implementation gains a new caller.

> **FU-C2 (2026-10-06): `homeKpis`/`queueSummary` dormant metric.** `queryHomeKpis` and `queryQueueSummary` (`modules/15-analytics/src/repository.ts`) both count `attempts.status = 'pending_admin_grading'` for "awaiting review" — that status has not been written since `67ed5e2` (2026-10-01, RCA "Attempts tab Pending grading was always empty"), so this count is permanently 0. The live equivalent is `countGradingQueue` (`modules/07-ai-grading/src/repository.ts`, built for RV58), which the admin dashboard cards actually use. `homeKpis`/`queueSummary`'s awaiting-review field stays dormant/misleading until pointed at `evaluation_status` or removed under Rule A review.

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
GET /api/admin/assessments/:id/results.csv   (admin only since 2026-10-03, was admin+reviewer; LIVE, per-invited-candidate; src/results-export.ts)
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

**D8 — Two-CTE leaderboard with LEFT JOIN, grouped by `pack_id`.** Both CTEs `JOIN assessments` and `GROUP BY ass.pack_id` (catalog-wide rollup — one row per question pack regardless of how many assessment cycles share that pack). Outer SELECT LEFT JOINs current → prior on `pack_id` so packs active in current-period but absent from prior-period still appear with `priorCount: 0` → delta direction `'up'`, `deltaPct: null` (no baseline). Ordering: current count DESC, then pack name ASC for stable rank determinism. Per-assessment grouping was considered and rejected during Phase 9 review (orchestrator decision 2026-05-13) — it produced duplicate pack-name rows in the Phase 11 UI when a pack had >1 active assessment cycle.

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
- `admin.assessments.results.download_csv` (migration 16-help-system 0110)

## Migration
`modules/15-analytics/migrations/0060_attempt_summary_mv.sql` — creates `attempt_summary_mv` view + 3 indexes (UNIQUE on `(tenant_id, attempt_id)` required for CONCURRENT refresh).

## Tests
3 vitest files, postgres:16-alpine testcontainer, **88/88 green** as of Phase 9 ship:
- `src/__tests__/service.test.ts` — 3 unit tests (cost-mode gating).
- `src/__tests__/analytics.test.ts` — 43 integration tests (Phase 3 + Phase 9 paths against a shared fixture).
- `src/__tests__/activity.test.ts` — 42 integration tests covering the 4 Phase 9 endpoints, helpers (`computeStreaks`, `zeroFillRange`, `rankDomains`, `computePeriodBoundaries`, `computeDelta`), and cross-tenant RLS proofs.

The activity test file spins up its own postgres container (`aiq_activity_test`) — defer consolidation to Phase 14 cross-cut verify.

## Open questions
- Custom report builder — defer to Phase 4 unless requested
- Programmatic access via REST (vs CSV download only) — most fields already in API; add explicit endpoints in v2 if needed
- Phase 4: populate `gradingCostByMonth` when `grading_jobs` table ships

- `src/__tests__/results-export.test.ts` — 4 integration tests for the live results CSV (statuses, override precedence, per-category %, formula escaping, cross-tenant 404, reviewer/candidate gating). Passing score comes from `levels.passing_score_pct` of the assessment level.

## Results CSV: ranking, branch sort, integrity counts (2026-10-01, campus placement)

- **Columns (in order):** name, email, roll_number, branch, status, started_at, submitted_at, score, max_score, percent, result, rank, tab_switches, paste_count, fullscreen_exits, then one `<category> (%)` per category.
- **rank:** competition ranking (1,2,2,4) by percent DESC among rows with a *visible* score (released to tenant). Blank for awaiting-evaluation / not-started rows, so ranks never leak held-back results.
- **Integrity counts:** one `GROUP BY attempt_id` over `attempt_events` (`tab_blur`, `paste`, `fullscreen_exit`, matched by string, so 0 until the engine emits `fullscreen_exit`). They are signals, not scores: shown regardless of release state; blank when the candidate has no attempt.
- **`?sort=name|rank|branch`** on `GET /api/admin/assessments/:id/results.csv` (zod enum, unknown -> 400). `branch` = branch A-Z (blank last), then rank, then name. Default `name` is unchanged.
- **Why:** the placement cell needs a ranked, branch-wise list. Roll/branch come from `users.metadata` (see 03-users SKILL).
- **Not included:** no per-branch rank, no percentile, no cut-off filtering.

## Section columns in results CSV (N1a, 2026-10-02)

`results-export.ts` appends one column `Section: <name> (%)` per `settings.sections` entry (names from the assessment; none for unsectioned tests), after the existing columns. Values use the same visible-score rule as `percent`: blank unless the score is released to the tenant. Not included: per-section rank, earned/max columns.

## Reviewer role removed; CSV formula guard (2026-10-03)

- **RV60.** The option `adminOrReviewer` is removed. `results.csv` is admin only. **Why.** Owner decision RO7. **Not included.** No change to the CSV columns.
- **RV77.** The CSV formula-injection guard (a cell that starts with `= + - @` gets a leading `'`) is now on the heatmap export and the attempt exports too, with one unit test each. Before this, only `results-export.ts` had it. The escape functions are not merged into one helper (separate task).
