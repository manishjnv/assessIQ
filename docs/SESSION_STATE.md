# Session — 2026-05-03 (G3.C 15-analytics shipped)

**Headline:** G3.C `15-analytics` shipped — `attempt_summary_mv` materialized view + 6 admin report/export routes + nightly BullMQ refresh job + lint guard + 23/23 integration tests passing.

**Commits:**
- `18fece2` — feat(dashboard/ui): phase-3 admin-dashboard pages + ui-system primitives (G3.A/G3.B) *(prior-session uncommitted work flushed)*
- `ce041e3` — feat(analytics): phase-3 G3.C attempt_summary_mv + 6 report routes + exports + cost-empty-shape + lint-mv-tenant-filter + help-seed

**Tests:** 23/23 integration tests passing (`modules/15-analytics/src/__tests__/analytics.test.ts`, testcontainers postgres:16-alpine).

**Next:** Deploy to VPS — SSH into `assessiq-vps`, apply migration `0060_attempt_summary_mv.sql` + updated `0011_seed_help_content.sql`, run initial `REFRESH MATERIALIZED VIEW attempt_summary_mv`, rebuild `assessiq-api` + `assessiq-worker` containers. Then smoke-curl cost-by-month (should return `{"items":[],"mode":"claude-code-vps",...}`). After deploy, Phase 4 `12-embed-sdk` is next unblocked item (Opus mandatory, `codex:rescue` required before push).

**Open questions:**
- `gradingCostByMonth` returns `[]` in Phase 3; populate when `grading_jobs` table ships in Phase 4 (`anthropic-api` mode).
- Phase 4: custom report builder and programmatic API access (explicitly deferred).
- Remaining 19 audit catalog entries from G3.A still deferred to G3.D parallel Sonnet sweep.

---

## Detail — G3.C what shipped at ce041e3

### New module: `modules/15-analytics`

| File | Purpose |
| --- | --- |
| `migrations/0060_attempt_summary_mv.sql` | `attempt_summary_mv` MV (joins `attempt_scores → attempts → assessments`), UNIQUE index for CONCURRENT refresh, 2 analytics indexes |
| `src/types.ts` | `HomeKpis`, `QueueSummary`, `CohortReport`, `IndividualReport`, `TopicHeatmap`, `ArchetypeDistributionItem`, `CostRow`, `AttemptExportRow`, `TopicHeatmapExportRow`, `ReportFilter`, `ExportFilter`, `ExportFilterSchema` |
| `src/repository.ts` | SQL queries over MV + live tables; `streamAttemptExportRows` + `streamTopicHeatmapCsv` use direct query + `Readable.from(lines)` (cursor-based streaming rejected — see D3 in SKILL.md); `EXPORT_ROW_CAP = 10_000` |
| `src/service.ts` | Business-layer wrappers using `withTenant()`; `gradingCostByMonth` returns `[]` early in `claude-code-vps` mode |
| `src/routes.ts` | 6 admin routes registered under `/api/admin/reports/*`; audit call for all export routes |
| `src/refresh-mv-job.ts` | BullMQ job processor using `getPool()` directly (not `withTenant()`); exports `ANALYTICS_REFRESH_MV_JOB_NAME = 'analytics:refresh_mv'` |
| `src/index.ts` | Public barrel |
| `src/__tests__/analytics.test.ts` | 23 integration tests; single global fixture seeded once; all pass |

### Key architecture decisions

- **D1** — MV RLS void: all MV queries include explicit `WHERE tenant_id = current_setting('app.current_tenant', true)::uuid`
- **D2** — Cost empty-shape: `gradingCostByMonth` returns `[]` in Phase 3; `claude-code-vps` checked in both service and route
- **D3** — No cursor streaming: `withTenant()` commits + releases client before lazy stream consumed; pre-fetch 10k rows into `Readable.from(lines[])`
- **D4** — No route duplication with 09-scoring: `cohortReport`/`individualReport` are the *service* backing 09's routes

### Wired into

- `apps/api/src/server.ts` — `registerAnalyticsRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) })`
- `apps/api/src/worker.ts` — cron `0 2 * * *` for `analytics:refresh_mv` BullMQ job

### Lint guard added

`tools/lint-mv-tenant-filter.ts` — scans all `*.ts` in `modules/15-analytics/src/` for MV queries missing the tenant filter. Run: `pnpm tsx tools/lint-mv-tenant-filter.ts`. Self-test: `--self-test`.

### Modified files in other modules

- `modules/14-audit-log/src/types.ts` — added `'attempt.exported'` to `ACTION_CATALOG`
- `modules/16-help-system/content/en/admin.yml` — 8 new analytics help keys
- `modules/16-help-system/migrations/0011_seed_help_content.sql` — regenerated (33 rows total)
- `docs/02-data-model.md` — `attempt_summary_mv` schema documented
- `docs/03-api-contract.md` — 6 G3.C endpoints documented

---

## Agent utilization
- Opus: Main session reasoning, architecture decisions (cursor vs direct query, withTenant() lifetime), Phase 3 critique and iteration
- Sonnet: n/a — Sonnet-only by user instruction; all implementation done in main session
- Haiku: n/a — no bulk sweeps needed this session
- codex:rescue: n/a — judgment-skipped per user instruction (not on CLAUDE.md load-bearing paths)

**Commits:**
- `43c0e45` — feat(audit-log): append-only audit table + write service + 9 admin write hooks + admin query/export *(G3.A implementation; shipped without a `docs(session)` companion commit — this handoff closes that debt)*
- `<backfill>` — docs(session): G3.A 14-audit-log handoff -- multi-model orchestration verdict captured

**Tests:** 12/12 integration tests passing (testcontainers) — sourced from `43c0e45` commit body.

**Next:** G2.C `10-admin-dashboard` (Sonnet 4.6) and G3.C `15-analytics` (Sonnet 4.6) are unblocked and pending; run in parallel (different modules, no file collisions). If both have shipped by the time this is read, next single-window pick is Phase 4 `12-embed-sdk` (Opus 4.7 mandatory — security surface, `codex:rescue` required before push; pre-flight at `ad0c44d` already done).

**Open questions / explicit deferrals:**
- **Adversarial checklist item 7** — in-function authz checks across admin-only functions (defense-in-depth beyond route-layer): deferred as Phase 4+ project-wide hardening. Reviewer accepted as consistent with project route-layer-only authz pattern (all `/api/admin/*` routes go through the same tenant + MFA middleware stack).
- **S3 cold-storage archive** — `archive-job.ts` ships as a BullMQ stub; actual S3 PUT + delete logic is Phase 4 (P3.D11). `infra/aws-iam/` policy doc + `tools/provision-audit-archive-bucket.sh` not yet authored.
- **`tenant.branding.updated` hook** — deferred to G3.D sweep (no branding update function exists yet in `02-tenancy`).
- **Remaining 19 audit catalog entries** (user.\*, pack.\*, question.\*, assessment.\*, attempt.\*, api\_key.\*, embed\_secret.\*, help.content.\*) — G3.D parallel Sonnet sweep (week 10); not a Phase 3 closure blocker.
- **`tools/lint-rls-policies.ts` append-only-table extension** — Phase 4+ tooling task; today's structural guard is the Postgres REVOKE + `tools/lint-audit-log-writes.ts`.
- **Cryptographic chain** (each row hashes previous) — Phase 4-deferred; meaningful only for very-high compliance bars.

---

## Detail — what shipped at 43c0e45

### New module: `modules/14-audit-log`

| File | Purpose |
| --- | --- |
| `migrations/0050_audit_log.sql` | `audit_log` table, two-policy RLS, `REVOKE UPDATE/DELETE/TRUNCATE FROM assessiq_app`, indexes (`tenant_id, at DESC` + `entity_type, entity_id`), `tenant_settings.audit_retention_years` column (INT, default 7, CHECK 1–10) |
| `src/audit.ts` | Write helper: `ActionName` validation, JSONB redaction, `RequestContext` auto-fill, rethrow-on-failure, best-effort SIEM fan-out (post-commit, non-blocking via dynamic import) |
| `src/redact.ts` | Recursive JSONB redaction covering 10+ sensitive field patterns (password, token, secret, key, credential, ssn, email variants, etc.) |
| `src/service.ts` | `list()` with pagination + 6 filters; `exportCsv()` + `exportJsonl()` via PostgreSQL cursor (streaming, memory-bounded) |
| `src/routes.ts` | 5 admin endpoints: `GET /api/admin/audit`, `GET /api/admin/audit/export.csv`, `GET /api/admin/audit/export.jsonl`, `GET /api/admin/audit/archives` (stub), registered behind existing tenant + MFA middleware |
| `src/archive-job.ts` | BullMQ daily archive job stub — S3 Phase 4 guard; logs "S3 not configured" without failing the worker |
| `__tests__/audit.test.ts` | 12/12 integration tests (testcontainers) |

### Hook sites: 9 events across 4 modules

| Module | File | Actions wired |
| --- | --- | --- |
| `01-auth` | `src/totp.ts` | `auth.login.totp_success`, `auth.login.totp_failed`, `auth.login.locked`, `auth.totp.reset` (+ `adminResetTotp` function) |
| `02-tenancy` | `src/service.ts` | `tenant.settings.updated` (replaces `// TODO(audit)` console.warn from Phase 0) |
| `07-ai-grading` | `src/handlers/admin-override.ts` | `grading.override` (most-scrutinized action per SKILL.md) |
| `13-notifications` | `src/webhooks/service.ts` | `webhook.created`, `webhook.deleted` (dynamic import to avoid circular dep) |

**Deferred:** `tenant.branding.updated` (no branding update fn in `02-tenancy` yet → G3.D); all user.\*, pack.\*, question.\*, assessment.\*, attempt.\*, api\_key.\*, embed\_secret.\*, help.content.\* entries → G3.D sweep.

---

## Multi-model orchestration breakdown

| Model | Role | What it did |
| --- | --- | --- |
| **Haiku 4.5** | Discovery (3 parallel agents) | Phase 0 warm-start: Cluster A (project + load-bearing rules), Cluster B (audit-log contract + cross-module write surfaces), Cluster C (state + ops + Phase 3 plan) |
| **Sonnet 4.6** | Primary implementation | Full G3.A: migration, audit helper, redact, service, routes, archive stub, 9 hook sites across 4 modules, 12 integration tests, same-PR SKILL.md update |
| **Copilot GPT-5 / Codex** | Adversarial review (codex:rescue substitute) | Per user instruction: codex:rescue quota-throttled; GPT-5/Codex ran adversarial diff review against `43c0e45`. Outcome: **ACCEPTED** with 1 nice-to-have (item 7 — see below). |
| **Opus 4.7** | n/a | Avoided per user instruction (quota conservation). Orchestration ran at Copilot-default model. |

---

## Adversarial checklist — 10-item review outcome

| # | Check | Outcome |
| --- | --- | --- |
| 1 | Append-only GRANT enforcement — `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM assessiq_app` in same migration as CREATE TABLE | ✅ |
| 2 | RLS multi-tenant isolation — two-policy template, `tenant_id NOT NULL`, INSERT + SELECT both scoped to `current_setting('app.current_tenant')` | ✅ |
| 3 | Single-writer invariant — all writes via `audit()` helper; `tools/lint-audit-log-writes.ts` rejects raw SQL outside `modules/14-audit-log/src/**` | ✅ |
| 4 | PII redaction — `redact.ts` recursive JSONB, 10+ field patterns; `before`/`after` JSONB not logged at INFO level | ✅ |
| 5 | Rethrow-on-failure — `audit()` awaited at every call site; no silent `.catch()`; compliance > convenience | ✅ |
| 6 | Action catalog permanence — 28 names documented in SKILL.md as append-only; renames require versioning (e.g. `grading.override_v2`) | ✅ |
| 7 | In-function authz checks across all admin-only functions (defense-in-depth beyond route-layer) | ⚠️ **DEFERRED** — Phase 4+ project-wide hardening. Reviewer accepted: route-layer pattern (`requireAdmin` middleware on all `/api/admin/*`) is consistent across the whole project; defense-in-depth hardening is a project-wide pass, not a per-module fix. |
| 8 | Cross-tenant isolation in list/export — `list()` / `exportCsv()` / `exportJsonl()` all enforce `tenant_id` scope via parameterized queries; no cross-tenant leak path | ✅ |
| 9 | SIEM fan-out best-effort post-commit — fan-out in `audit()` is non-blocking (dynamic import avoids circular dep with `13-notifications`; failure logged, not re-thrown) | ✅ |
| 10 | No ambient AI imports — `lint:ambient-ai` passes; no `@anthropic-ai` or `claude` spawn in module 14 sources | ✅ |

**Result: 9 ✅ · 1 ⚠️ (item 7 deferred as Phase 4+ project-wide hardening).**

---

## Agent utilization

- **Opus:** n/a — avoided per user instruction (Opus 4.7 quota conservation; orchestration for this handoff session ran at Copilot-default model)
- **Sonnet 4.6:** G3.A primary implementation — migration + write service + redact + list/export service + 5 admin routes + archive-job stub + 9 admin write hooks (4 modules) + 12 integration tests + same-PR SKILL.md
- **Haiku 4.5:** 3 parallel discovery sweeps for Phase 0 warm-start (Cluster A: project + load-bearing rules; Cluster B: audit-log contract + cross-module write surfaces; Cluster C: state + ops + plan)
- **codex:rescue:** **SUBSTITUTED** by Copilot GPT-5 / Codex per user instruction (codex:rescue quota-throttled). Adversarial diff review of `43c0e45`. Verdict: **ACCEPTED** — 9/10 checks passed; item 7 (in-function authz, defense-in-depth) deferred as Phase 4+ project-wide hardening, consistent with existing route-layer authz pattern.
