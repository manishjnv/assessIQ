# Phase 3 — Operate Kickoff Plan

> **Generated:** 2026-05-03 by Opus 4.7 after parallel doc-discovery sweeps (3 Haiku Explore agents, one per module cluster).
> **Phase scope:** Modules `13-notifications`, `14-audit-log`, `15-analytics`.
> **Outcome:** AssessIQ is *operable* end-to-end. **(14)** Every state-changing admin action — login, role grant, settings change, grading override, webhook config, API-key issue/revoke — writes a tenant-scoped, append-only `audit_log` row with actor + before/after + IP + UA; admins query the trail via `/admin/audit` and export CSV/JSONL; daily archival job moves >retention rows to S3 cold storage. **(13)** The Phase 0 dev-emails JSONL stub is replaced with a real SMTP driver (AWS SES default; per-tenant `tenants.smtp_config` override); outbound webhooks fire from the BullMQ `webhooks:queue` with HMAC-SHA256 signatures, the canonical 5-attempt `[1m,5m,30m,2h,12h]` retry, and admin replay UI; in-app notifications surface in the admin shell via short-poll; all 7 declared templates ship. **(15)** Read-only reports + exports + dashboard tiles consume `attempt_scores` (09), `gradings` (07), `attempt_events` (06), and `audit_log` (14) to render cohort/individual/topic-heatmap/archetype-distribution surfaces; `attempt_summary_mv` ships eagerly so the 50K-attempt threshold is a deploy-time non-event; `gradingCostByMonth` returns honest empties in `claude-code-vps` mode and lights up automatically when `anthropic-api` runtime ships. Public-facing leaderboard scope stays Phase 4-deferred per a fresh DPDP frame restated below.
> **Window:** Week 9–10 per `PROJECT_BRAIN.md` § Build phases.

This plan is the source of truth for Phase 3 across multiple VS Code sessions. Every session reads this doc as part of its Phase 0 warm-start (`CLAUDE.md` § Phase 0 reading list — Phase 3 sessions inherit the same warm-start, swapping in this file).

---

## Discovery summary (consolidated)

Three Haiku discovery agents reported on 2026-05-03 against `13`, `14`, and `15`. Consolidated facts below; line citations preserved so future sessions can verify without re-reading the agents' output.

### Repo state at Phase 3 start

- **Phase 0 fully shipped** (G0.A core + G0.B-2 02-tenancy + G0.B-3 17-ui-system + G0.C-4 01-auth + G0.C-5 03-users + admin login).
- **Phase 1 fully shipped through G1.D:** `04-question-bank`, `16-help-system` + Tooltip primitive, `05-assessment-lifecycle` + 13's stub assessment-invitation extension, `06-attempt-engine` + `apps/worker` BullMQ scheduler + take-backend + admin worker observability, `11-candidate-ui` (per Window α merge). Production has 5 `assessiq-*` containers healthy (api, worker, postgres, redis, frontend).
- **Phase 2 G2.A Session 1.a shipped (commit `7eea75b`):** `modules/07-ai-grading` structural scaffold — D2 lint sentinel (load-bearing), migrations `0040_gradings.sql` + `0041_tenant_grading_budgets.sql`, types + Zod schemas, `runtime-selector.ts` + three runtime stubs (all 503 `RUNTIME_NOT_IMPLEMENTED`). `AI_PIPELINE_MODE` enum extended to all three D1 values. `lint:ambient-ai` is a required CI check. Sonnet adversarial rescue ran; three findings adjudicated.
- **Phase 2 G2.A Session 1.b in flight (window α):** real `claude-code-vps` runtime body — spawn `claude -p`, parse stream-json, extract tool-use, compute `skillSha()`, score math. Plan presented; awaiting user approval on three open questions (stream-json tool-name namespacing; skill-frontmatter parsing strategy; Stage 3 escalation trigger alignment with `BandFindingSchema.needs_escalation`). **G2.A Session 1.b does NOT block Phase 3** — it touches only `modules/07-ai-grading/runtimes/` + `runtime-selector.ts` + 1.b tests; Phase 3 modules are non-AI lanes per CLAUDE.md rule #1.
- **Phase 2 G2.B + G2.C unshipped.** `08-rubric-engine`, `09-scoring`, `10-admin-dashboard` not started. Phase 3 G3.C (15-analytics) consumes `attempt_scores` from 09; if 09 has not shipped by the time G3.C opens, G3.C either (a) waits for G2.B Session 3 to land, or (b) ships a temporary `attempt_scores`-empty fallback path. **Recommended:** open G3.A + G3.B in parallel as soon as G2.A 1.b lands; open G3.C after G2.B Session 3 (`09-scoring`) merges. The Phase 2 plan and Phase 3 plan can run concurrent windows on `main` so long as their commit windows don't collide.
- **No Phase 3 module has any code yet.** All three module directories contain a `SKILL.md` only (verified 2026-05-03 via Glob). EXCEPTION: `modules/13-notifications/src/email-stub.ts` ships from Phase 0 G0.C-5 + Phase 1 G1.B-3 with `sendInvitationEmail` and `sendAssessmentInvitationEmail`; Phase 3 G3.B preserves these as the public surface and replaces the JSONL-write body with real SMTP.

### Module contracts (extracted, not invented)

- **`13-notifications` — depends on `00-core`, `02-tenancy`, `14-audit-log` (must ship first or in lockstep — every webhook delivery audited per SKILL.md:13), BullMQ + Redis (`webhooks:queue`), SMTP provider via `SMTP_URL` (envvar declared, provider unselected — see P3.D9). Phase 3 swap-in.** Existing Phase 0 stub interface (verbatim from `modules/13-notifications/src/email-stub.ts:58-149`):
  - `sendInvitationEmail({ to, role, invitationLink, tenantName? }): Promise<void>` → template_id `invitation.user`
  - `sendAssessmentInvitationEmail({ to, candidateName, assessmentName, invitationLink, expiresAt, tenantName }): Promise<void>` → template_id `invitation.assessment`
  - Existing callers (Grep): `modules/03-users/src/invitations.ts` (admin/reviewer/candidate invitations from Phase 0 G0.C-5); `modules/05-assessment-lifecycle/src/email.ts` + `modules/05-assessment-lifecycle/src/service.ts.inviteCohort` (Phase 1 G1.B-3 cohort invitations).
  - Phase 3 declared surface (SKILL.md:18-31) ships in this phase: `sendEmail({ to, template, vars })`, `emitWebhook({ tenantId, event, payload })`, `notifyInApp({ tenantId, userId?, role?, message })`, `listWebhookEndpoints(tenantId)`, `createWebhookEndpoint(input)`, `deleteWebhookEndpoint(id)`, `sendTestEvent(endpointId, eventName)`, `listDeliveries({ endpointId?, status? })`, `replayDelivery(id)`. Tables: `webhook_endpoints` (live since Phase 0 schema, standard `tenant_id` RLS — `docs/02-data-model.md:636-644`), `webhook_deliveries` (live, JOIN-RLS via `endpoint_id → webhook_endpoints.tenant_id` — `docs/02-data-model.md:646-658`), `email_log` (declared in module map at `:27` but **schema NOT in `docs/02-data-model.md`** — Phase 3 G3.B migration adds it). Email templates declared in SKILL.md:40-48: 7 names (`invitation_admin`, `invitation_candidate`, `totp_enrolled`, `attempt_submitted_candidate`, `attempt_graded_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin`); all 7 ship in Phase 3 per P3.D14. Webhook delivery contract verbatim (`docs/03-api-contract.md:289-325`): HMAC-SHA256 of raw body keyed by endpoint secret, headers `X-AssessIQ-{Event,Delivery,Signature,Timestamp}`, 5-min timestamp tolerance, retry policy `[1m, 5m, 30m, 2h, 12h]`. Worker observability inheritance per `docs/11-observability.md` § 13 — Phase 3 webhook delivery uses the existing `runJobWithLogging` wrapper + `JOB_RETRY_POLICY['webhook.deliver']` table entry; admin observability lands via the existing `/api/admin/worker/{stats,failed,failed/:id/retry}` surface (no new endpoints).
- **`14-audit-log` — LOAD-BEARING per `CLAUDE.md` § Load-bearing paths.** Depends on `00-core`, `02-tenancy`. Owns `audit_log` table (schema verbatim in `docs/02-data-model.md:618-634` — `BIGSERIAL PRIMARY KEY`; `tenant_id NOT NULL REFERENCES tenants(id)`; `actor_user_id UUID REFERENCES users(id)` nullable; `actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','api_key','system'))`; `action TEXT NOT NULL`; `entity_type TEXT NOT NULL`; `entity_id UUID`; `before JSONB`; `after JSONB`; `ip INET`; `user_agent TEXT`; `at TIMESTAMPTZ NOT NULL DEFAULT now()`. Indexes: `(tenant_id, at DESC)` and `(entity_type, entity_id)`). Public surface (SKILL.md:18-27): `audit({tenantId, actorUserId?, actorKind, action, entityType, entityId?, before?, after?, ip?, userAgent?})`, `list({tenantId, filters: {actor?, action?, entityType?, entityId?, from?, to?}, page, pageSize})`, `exportCsv({tenantId, filters})`. Phase 3 G3.A adds `exportJsonl(...)` per P3.D17. Storage discipline (load-bearing per SKILL.md:68-72): app role gets INSERT only (no UPDATE/DELETE grant), the GRANT lives in the same migration as CREATE TABLE; backup includes audit_log with a documented restore runbook in `docs/06-deployment.md`; cryptographic chain + WORM bucket explicitly Phase 4-deferred. Action catalog (SKILL.md:29-61, 28 names) is **the public contract for SIEM integrations and is permanent once shipped** — new actions are append-only, renames require versioning (e.g., `grading.override_v2`). Retention default 7 years, `tenant_settings.audit_retention_years` (NEW column, Phase 3 migration adds — does NOT exist in current `02-data-model.md:49-58`) overrides per-tenant in `[1, 10]`. Daily BullMQ archive job (`assessiq-cron:audit_log:archive`) reads >retention rows, gzip-streams to S3 cold storage `s3://assessiq-audit-archive/<tenant_id>/<YYYY>/<MM>/<batch_id>.jsonl.gz`, deletes from hot table only after successful S3 PUT (per P3.D11). Boundary with operational logs + behavioral telemetry quoted verbatim in `docs/11-observability.md` § 2: `audit_log` is "state changes a compliance auditor needs to see" with 7y retention — distinct from `/var/log/assessiq/*.log` (14d) and `attempt_events` (90d).
- **`15-analytics` — depends on `00-core`, `02-tenancy`, read-only access to `attempts` (06), `gradings` (07), `attempt_scores` (09 — must ship before G3.C opens), `attempt_events` (06), `assessments` (05), `questions` (04), `audit_log` (14 — lights up cost-telemetry's "audit feed" view).** Owns ZERO writable tables (verified: `modules/15-analytics/` contains only `SKILL.md`). Owns ONE materialized view per P3.D18: `attempt_summary_mv` ships eagerly in G3.C migration `0060_attempt_summary_mv.sql` — refreshed nightly via the `assessiq-cron:analytics:refresh_mv` BullMQ job, 50K-attempt threshold becomes a deploy-time non-event. Public surface (SKILL.md:14-32): dashboard helpers `homeKpis(tenantId)`, `queueSummary(tenantId)` (the latter overlaps the existing G2.A `/api/admin/dashboard/queue` endpoint per P2.D15 — resolution at P3.D15: 15 is the *service layer* called by 07's existing handler, not a duplicate HTTP surface); reports `cohortReport(assessmentId)`, `individualReport(userId, {from?, to?})`, `topicHeatmap({tenantId, packId, from?, to?})`, `archetypeDistribution(assessmentId)`; cost `gradingCostByMonth(tenantId, year)`; exports `exportAttemptsCsv({tenantId, filters})`, `exportAttemptsJson({tenantId, filters})` (JSONL per P3.D19). Cross-module overlap with 09-scoring's `cohortStats` + `leaderboard`: 09 owns the per-attempt + per-cohort math primitives; 15 wraps them into report shells + adds topic heatmap + cost telemetry + exports + dashboard tiles. P2.D13 leaderboard scope (tenant-private, admin-only) is restated as P3.D13 here with the public-leaderboard deferral made explicit + DPDP-framed.

### Allowed APIs (cite-only — do not invent)

- **`audit({...})` helper** — single writer for `audit_log` rows. Implementation in `modules/14-audit-log/src/audit.ts`; never INSERT into the table by any other path. The Postgres `assessiq_app` role gets `INSERT` only on `audit_log` (no `UPDATE`, no `DELETE`); the `GRANT` is in the same migration as `CREATE TABLE` (P3.D10).
- **Append-only invariant enforcement** — `REVOKE UPDATE, DELETE ON audit_log FROM assessiq_app;` immediately after `CREATE TABLE` in `modules/14-audit-log/migrations/0050_audit_log.sql`. The `assessiq_system` BYPASSRLS role retains UPDATE/DELETE for the daily archive job (deletes only post-S3-PUT confirmation per P3.D11).
- **Webhook signature verification (host-side, restated for spec stability)** — `expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"); if (!timingSafeEqual(received, expected)) reject(); if (Math.abs(Date.now() - Date.parse(timestamp)) > 5*60*1000) reject();` (`docs/03-api-contract.md:319-322`). Phase 3 G3.B preserves this contract exactly — the host-side signing snippet in the doc is a tenant-facing public surface and renaming or re-shaping it breaks integrations.
- **BullMQ worker pattern** — webhook delivery + audit archive both use the existing `runJobWithLogging` wrapper from `apps/api/src/worker.ts` (`docs/11-observability.md` § 13.1). Each gets a `JOB_RETRY_POLICY[name]` entry: `webhook.deliver` → `attempts: 5, backoff: literal[1m, 5m, 30m, 2h, 12h]` (P3.D12 — literal-list, NOT BullMQ-default exponential, to match the documented host-facing schedule); `audit.archive` → `attempts: 3, backoff: exponential base 60s` (idempotent — re-run on already-archived batches is a S3-existence check no-op); `email.send` → `attempts: 5, backoff: exponential base 5s` (transient SMTP failures only).
- **PII redaction allowlist** — `LOG_REDACT_PATHS` from `@assessiq/core` per `docs/11-observability.md:94-119`. Phase 3 webhook + email + audit-archive code MUST route every log line through this redactor. Specifically: never `log.info({ payload: webhook.payload }, ...)` (leaks candidate-answer text), never `log.info({ body: emailRecord.body }, ...)` (leaks invitation token), never `log.info({ before, after }, 'audit.write')` (leaks settings JSONB / branding URLs / role data).
- **Audit-log boundary (operational logs vs business audit vs behavioral telemetry)** — `docs/11-observability.md:22-34` is canonical. Phase 3 cross-module wiring respects this: a failed login writes both `auth.log` (operational) AND `audit_log` (business audit) — they answer different questions and have different retention. Adding "wrap audit calls in a logger" or "make the logger write audit rows" is a category error and Phase 3-bounce-condition.
- **`tenant_settings.audit_retention_years`** — new column added by `modules/14-audit-log/migrations/0050_audit_log.sql` in the same file as `CREATE TABLE audit_log`. Defaults to 7, CHECK constraint `audit_retention_years BETWEEN 1 AND 10`. Read by the daily archive job to compute the cutoff per tenant; null-coalesces to 7 for tenants whose `tenant_settings` row is absent (extremely unusual).
- **Cross-tenant SIEM forwarding via webhook** — per P3.D16, audit events can be webhook-fanned-out to tenant-supplied SIEM endpoints by registering a `webhook_endpoints` row with `events ⊇ ['audit.*']` and `13-notifications.emitWebhook({tenantId, event: 'audit.<action>', payload})` on every audit write. The fan-out is opt-in per tenant; absence of subscribed endpoints means audit writes don't fire 13.
- **Materialized view refresh** — `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv;` runs nightly via the `assessiq-cron:analytics:refresh_mv` BullMQ job (P3.D18). `CONCURRENTLY` requires a UNIQUE index on the MV — `0060_attempt_summary_mv.sql` adds `(tenant_id, assessment_id, attempt_id)`.

### Anti-patterns to refuse

- **Any UPDATE or DELETE on `audit_log` from app code.** The Postgres GRANT is the structural backstop; CI lint `tools/lint-audit-log-writes.ts` (new in G3.A — see Session 1's What-to-implement) scans `modules/**/src/**/*.ts` for raw SQL or pg query strings touching `audit_log` outside `modules/14-audit-log/src/**` and rejects.
- **Any `audit_log` write outside the `audit()` helper.** Single-writer invariant.
- **Catching `audit()` failures silently.** The helper returns `Promise<void>` — callers MUST `await` and let exceptions bubble. If audit write fails, the operation should fail too (compliance > convenience). G3.A's lint scans for `.catch(...)` directly on `audit(...)` calls and rejects.
- **Logging `audit_log.before`/`after` JSONB at INFO level.** The `LOG_REDACT_PATHS` allowlist covers many leaf names (settings, branding, password, token, etc.) but the JSONB blobs themselves are unbounded — the primary control is "don't log them."
- **Skipping audit on `grading.override`.** D8 compliance frame in `docs/05-ai-pipeline.md:24-36` requires it; load-bearing rule per CLAUDE.md. The `grading.override` write is the most-scrutinized audit action (SKILL.md:53 explicit comment).
- **Cross-tenant webhook delivery / email send / audit query.** Every `webhook_deliveries` row, every `email_log` row, every `audit_log` query is RLS-scoped. The CI tenancy guard (CLAUDE.md rule #4) bounces diffs that bypass `app.current_tenant`.
- **No-`tenant_id` table additions.** `email_log` (Phase 3 G3.B migration) MUST carry `tenant_id NOT NULL REFERENCES tenants(id)` + standard two-policy RLS. `tools/lint-rls-policies.ts` enforces.
- **Webhook auto-retry on client 4xx errors.** Per P3.D12, retry only on 5xx and network errors (timeout, connection refused). Retrying on 401/403/410/422 is wasted effort and a bad-citizen pattern. The BullMQ job decides retry-vs-permanent-fail by inspecting the response status code in the job processor.
- **Heavyweight chart libraries in 15-analytics or 10-admin-dashboard.** Per Phase 2 G2.C's existing decision (P2.D18) — `Sparkline`, `ScoreRing`, `ArchetypeRadar` are pure SVG. Adding `recharts` / `chart.js` / `d3` is a bundle-budget bounce.
- **PDF export libraries.** Phase 3 ships CSV + JSONL only; PDF (Puppeteer / wkhtmltopdf) is Phase 4-deferred per P3.D19. The dependency surface and security blast radius of headless Chromium isn't worth the export-format ergonomics.
- **Real-time WebSocket / SSE for in-app notifications.** Phase 3 ships short-poll only (P3.D13). WebSocket / SSE is Phase 4 — adds connection-state plumbing, reconnect logic, and Caddy edge config for `/ws` upgrade that doesn't exist today.
- **Any `claude` / `@anthropic-ai` / Agent SDK import in `modules/{13,14,15}/**`.** D2 lint enforces. Phase 3 modules are non-AI lanes per CLAUDE.md rule #1; webhook handlers, audit writes, and analytics rollups must NOT transitively pull the grading runtime.
- **BullMQ jobs that import the grading runtime.** `webhook.deliver`, `audit.archive`, `email.send`, `analytics.refresh_mv` all run in the same `assessiq-worker` container as Phase 1's `assessment-boundary-cron` and `attempt-timer-sweep` — none of them touch grading. D2 rejection pattern 7 enforces.
- **`if (domain === "soc")` anywhere in 13/14/15.** Domain lives in question packs, not code (PROJECT_BRAIN.md non-negotiable principle #2).
- **Public-facing leaderboard / candidate-visible cross-tenant ranking in Phase 3.** P3.D13 explicitly defers; surfacing it now is a Phase 3-bounce condition pending DPDP review (legal sign-off + per-tenant opt-in + anonymization-by-default UX).
- **TimescaleDB hypertable migration in Phase 3.** Defer until measured 50K-attempts threshold per P3.D22; ships in a future phase. The `attempt_summary_mv` covers the v1 → v2 transition without forcing the timescale install.
- **`SQL UPDATE` on `webhook_endpoints.events[]` arrays from a route handler without checking the diff against tenant-allowed events.** Cross-tenant event subscription is an RLS-protected surface but P3.D16's audit fan-out makes the events array a privilege boundary too — admin can't subscribe their endpoint to `audit.*` without explicit "I agree to receive audit events" capability check (handler enforces; future migration may carve `audit_*` into a separate scope column).
- **PDF rendering of audit log.** Phase 4 only. JSONL + CSV only.

---

## Decisions captured (2026-05-03)

Twenty-two decisions, in two groups: D1–D8 are restatements of `docs/05-ai-pipeline.md` § "Decisions captured (2026-05-01)" — load-bearing for *every* AssessIQ session and quoted here as the canonical pin point even though Phase 3 modules don't touch the AI runtime; P3.D9–P3.D22 are new resolutions surfacing during the discovery sweep, all confirmed at orchestrator-default pending user review.

| # | Decision | Source |
| --- | --- | --- |
| **D1–D8** | All eight load-bearing AI-pipeline decisions still apply. Phase 3 modules are non-AI lanes per CLAUDE.md rule #1, but D1's `AI_PIPELINE_MODE` interacts with P3.D21 (cost-telemetry empty-shape contract); D2's lint applies to every Phase 3 source file (no `claude` imports anywhere); D8's compliance frame anchors P3.D11's audit-of-grading.override invariant. | `docs/05-ai-pipeline.md:529–829` (verbatim source); `docs/plans/PHASE_2_KICKOFF.md` § Decisions captured § D1–D8 (verbatim restatement) |
| **P3.D9** | **SMTP provider for Phase 3 = AWS SES (default), with per-tenant `tenants.smtp_config` JSONB override.** Rationale: SES is cheapest at scale (~$0.10 per 1K emails), supports India region (Mumbai), DPDP-friendly residency, IAM-driven secret management vs API-key-in-env. Sendgrid considered (100/day free, faster onboarding) but per-message cost above free tier is 4–8× SES; Mailgun considered (similar pricing to SES) but lacks the AWS-IAM auth seam already used by other AssessIQ infrastructure (S3 audit archive in P3.D11 uses the same IAM); self-hosted postfix considered (zero cost) and **rejected** — running an open SMTP relay on the shared Hostinger VPS is a deliverability and security headache (PTR records, SPF/DKIM/DMARC, IP reputation) that Phase 3 should not absorb. `tenants.smtp_config` JSONB shape: `{ provider: 'ses' | 'sendgrid' | 'mailgun' | 'smtp', credentials_enc: bytea, from_address: string, reply_to?: string }` — per-tenant override is rare (most tenants use platform default); credentials encrypted at rest with `ASSESSIQ_MASTER_KEY` (AES-256-GCM) per the existing `embed_secrets` / `webhook_endpoints.secret_enc` pattern. Decision is reversible — Phase 4 can add additional providers without schema change. | Cluster A GAP #1; orchestrator-default |
| **P3.D10** | **`audit_log` GRANT enforcement in same migration as CREATE TABLE.** `modules/14-audit-log/migrations/0050_audit_log.sql` ships: (a) `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (already present from earlier migrations — defensive); (b) `CREATE TABLE audit_log (...)` with the exact schema from `docs/02-data-model.md:618-634`; (c) the two indexes; (d) standard RLS template (two policies); (e) `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM assessiq_app;` after the CREATE so the app role gets INSERT + SELECT only; (f) `ALTER TABLE audit_log SET (autovacuum_vacuum_scale_factor = 0.01);` so the high-volume INSERT pattern doesn't accumulate dead tuples (no UPDATE/DELETE means no dead tuples normally, but the daily archive's DELETE batch makes autovacuum tuning load-bearing); (g) `tenant_settings.audit_retention_years INT NOT NULL DEFAULT 7 CHECK (audit_retention_years BETWEEN 1 AND 10)` ALTER on the existing tenant_settings table. The migration's Phase 3 lint contract: `tools/lint-rls-policies.ts` already accepts `audit_log` as standard tenant_id-bearing; G3.A also extends `tools/lint-audit-log-writes.ts` (new) to assert that no module outside `modules/14-audit-log/src/**` imports raw SQL strings or pg query strings referencing `audit_log`. | Cluster B GAP #1, #3; orchestrator-default |
| **P3.D11** | **Cold-storage S3 strategy — single bucket, tenant-prefixed, lifecycle to Glacier after 30 days, restore via admin export.** Bucket: `s3://assessiq-audit-archive` (single platform-global; tenant data segmentation lives in the prefix not the bucket because IAM policy by prefix is sufficient and per-bucket sprawl breaks free-tier quotas). Object key: `<tenant_id>/<YYYY>/<MM>/<batch_id>.jsonl.gz` (batch_id = uuidv7 of the daily run). Lifecycle: Standard → Standard-IA at 30d → Glacier Flexible Retrieval at 90d (cost optimization for compliance-only access). Encryption: SSE-S3 (AWS-managed) for v1; SSE-KMS with per-tenant CMK is Phase 4 (when a tenant explicitly requests). Daily archive job (`assessiq-cron:audit_log:archive`) reads `audit_log WHERE at < now() - tenant_settings.audit_retention_years * interval '1 year'`, batches into 10MB chunks, gzips, S3 PUT with `If-None-Match: *` (idempotency safety), only after 200 OK does the job DELETE the rows from the hot table. The DELETE runs as `assessiq_system` (the `BYPASSRLS` role retains UPDATE/DELETE); `assessiq_app` never deletes. Restore procedure: admin clicks "restore archive" in `/admin/audit/archives/:date`; the worker S3 GETs the object, gunzips, streams to the admin's CSV/JSONL download (audit_log rows are NEVER re-INSERTed into the hot table — the archive is a one-way trip). Cost model: at 100 audit rows/day/tenant × 100 tenants × 365 days = ~3.6M rows/yr ≈ ~3.6 GB raw / ~360 MB gzipped — Glacier storage is ~$0.004/GB/month, total annual cost <$5/year per the pessimistic model. **Bucket creation + IAM policy ship as a `infra/aws-iam/` policy doc + a `tools/provision-audit-archive-bucket.sh` script that the user runs once during deploy** (Phase 3 doesn't auto-provision AWS resources; the human stays in the loop per CLAUDE.md rule #8 additive-only on shared infra — AWS account is shared infra). | Cluster B GAP #4; orchestrator-default |
| **P3.D12** | **Webhook retry policy = literal `[1m, 5m, 30m, 2h, 12h]` schedule, NOT BullMQ-default exponential.** Rationale: the schedule is documented in `docs/03-api-contract.md:324` as the host-facing retry contract. Tenants and host-app integrators read this doc and configure their endpoint dedupe windows accordingly; switching to exponential silently breaks the contract. Implementation: a custom `delay` function in the BullMQ job options that returns the exact next-attempt delay based on `attemptsMade`. Retry only on 5xx + network errors (timeout, connection refused, DNS failure); 4xx is permanent failure and writes `webhook_deliveries.status='failed'` immediately. After all 5 attempts exhaust, the row stays at `status='failed'` with `last_error` populated and the admin replay UI surfaces it (clicking "Replay" enqueues a fresh delivery row, never UPDATEs the existing one — append-only delivery history). | Cluster A GAP #3; orchestrator-default |
| **P3.D13** | **In-app notification delivery = short-poll (every 60s when admin tab is active), via `GET /api/admin/notifications?since=<cursor>` returning `{ items: InAppNotification[], cursor: string }`. WebSocket / SSE explicitly deferred to Phase 4.** `InAppNotification` shape: `{ id: uuid, tenantId: uuid, audience: 'user'|'role'|'all', userId?: uuid, role?: 'admin'|'reviewer', kind: 'webhook.failed'|'budget.exhausted'|'audit.archive.failed'|'attempt.ready_for_review'|'invitation.accepted', message: string, link?: string, read_at: timestamptz|null, created_at: timestamptz }`. Owns table `in_app_notifications` (Phase 3 G3.B migration). RLS: standard tenant_id direct. Notification trigger sites: 13's webhook delivery final-failure handler writes `kind='webhook.failed'`; 14's audit-archive permanent-fail writes `kind='audit.archive.failed'`; 03's invitation accept (Phase 0) writes `kind='invitation.accepted'`; 07's grading-needs-review writes `kind='attempt.ready_for_review'`. Phase 4 adds WebSocket upgrade for sub-minute push when the user demand surfaces. **Public-facing leaderboard scope (P2.D13 deferral) restated: candidate-visible cross-tenant leaderboards remain Phase 4-deferred pending DPDP review** — Wipro/India residency requires per-tenant explicit opt-in + anonymization-by-default + a documented data-processing-agreement clause; ramming it through in Phase 3 is a compliance bounce. | Cluster A GAP #4; Cluster C GAP for public-leaderboard; orchestrator-default |
| **P3.D14** | **All 7 declared email templates ship in Phase 3 G3.B.** Templates live at `modules/13-notifications/templates/<name>.{html,txt}`. List: `invitation_admin`, `invitation_candidate`, `totp_enrolled`, `attempt_submitted_candidate`, `attempt_graded_candidate`, `attempt_ready_for_review_admin`, `weekly_digest_admin`. Templating engine: Handlebars (per SKILL.md:41); strict variable allowlist per template (no arbitrary helper invocation, no `{{{triple-stash}}}` raw-HTML escape — every var goes through HTML-escape). Per-tenant template override is Phase 4 — the `tenants.smtp_config` JSONB has a forward-compat `template_overrides?: Record<string, {html?, txt?}>` slot that's read but currently always empty. The existing `sendInvitationEmail` and `sendAssessmentInvitationEmail` Phase 0/1 callers MUST keep working — Phase 3 G3.B preserves the function signatures and routes them through the new `sendEmail(...)` core internally. Caller migration (G3.B follow-up): callers can opt into `sendEmail({ to, template: 'invitation_admin', vars: {...} })` for richer invocation but the legacy two functions stay as thin shims with backward-compatible templates. **Per-user notification preferences (digest vs immediate) stay Phase 4-deferred** per SKILL.md:61. | Cluster A GAP #5, #6; orchestrator-default |
| **P3.D15** | **`/api/admin/dashboard/queue` ownership stays with 07-ai-grading per P2.D15.** 15-analytics' `queueSummary(tenantId)` is a *service-layer* function called BY 07's existing handler, not a duplicate HTTP surface. Resolution: 07's `handlers/admin-queue.ts` is refactored in G3.C to import `queueSummary` from `@assessiq/analytics` and merge the result into its existing payload. Same for `homeKpis(tenantId)` — called by 10-admin-dashboard's `/admin/dashboard/summary` handler (which today doesn't exist; G2.C ships it; G3.C adds the `homeKpis` integration). 15 owns no HTTP routes for these two helpers; the new HTTP surface 15 DOES own (G3.C): `GET /api/admin/reports/topic-heatmap`, `GET /api/admin/reports/archetype-distribution/:assessmentId`, `GET /api/admin/reports/cost-by-month?year=YYYY`, `GET /api/admin/reports/exports.csv`, `GET /api/admin/reports/exports.jsonl`. The pre-existing `/api/admin/reports/cohort/:assessmentId` and `/api/admin/reports/individual/:userId` were claimed by 09-scoring (Phase 2 G2.B Session 3 routes per the Phase 2 plan); G3.C wraps them with richer 15-side data via service-layer composition (no route re-registration). | Cluster C GAP #2, #6, #7, #8, #9; orchestrator-default |
| **P3.D16** | **SIEM forwarding via webhook fan-out is in-scope for Phase 3.** Audit events can be webhook-fanned-out to tenant-supplied SIEM endpoints. Mechanism: `webhook_endpoints.events` array accepts entries matching `audit.<action>` (e.g. `audit.grading.override`, `audit.user.role.changed`) or the wildcard `audit.*`. Every `audit()` write triggers `13-notifications.emitWebhook({tenantId, event: 'audit.<action>', payload: {actorUserId, action, entityType, entityId, before, after, ip, userAgent, at}})` AFTER the audit row is committed (post-commit fan-out — never block the audit write on webhook delivery). The fan-out is opt-in: tenants without a registered `webhook_endpoints` row matching `audit.*` see zero behavioral change. Phase 3 G3.A ships the helper; G3.B's webhook delivery worker handles delivery. Capability gate (P3.D17 governance): subscribing an endpoint to `audit.*` requires fresh-MFA + an explicit "I am subscribing this endpoint to receive sensitive audit events; I am responsible for the receiving system's security" admin attestation modal in module 10's webhook UI (G3.B ships the backend gate; module 10's UI ships in a Phase 3 follow-up or is wired in G3.B if module 10 is mature enough by then — see Routing summary). | Cluster B GAP #2; Cluster A GAP #8; orchestrator-default |
| **P3.D17** | **Audit export formats: CSV (default) + JSONL (alternative) ship in G3.A. PDF deferred to Phase 4.** Two endpoints: `GET /api/admin/audit/export.csv?from=&to=&actor=&action=&entityType=&entityId=` and `GET /api/admin/audit/export.jsonl?...` (same query parameters). Both return `Readable` streams (no whole-result buffering — auditors download multi-month exports that can be GB-scale post-Phase 4 traffic). CSV columns (fixed order, never re-ordered without a `v` query param bump): `at, tenant_id, actor_kind, actor_user_id, actor_user_email, action, entity_type, entity_id, ip, user_agent, before_json, after_json` (the JSONB blobs serialized as escaped-JSON strings inside the CSV cell — auditors paste the column into `jq` or Excel; the alternative of CSV-flattening the JSONB would silently lose nested data). JSONL: one row per line, identical field set, JSONB blobs as native nested JSON. Streaming via PostgreSQL cursor (`DECLARE cur ... FETCH 1000`) so memory stays bounded. PDF (Puppeteer / wkhtmltopdf) is Phase 4 — the dependency surface and security blast radius of headless Chromium isn't worth the export-format ergonomics in Phase 3. The `exportCsv(...)` helper in SKILL.md:26 also ships the JSONL variant; helper signatures: `exportCsv({tenantId, filters}): Promise<Readable>`, `exportJsonl({tenantId, filters}): Promise<Readable>`. | Cluster B GAP #5, #6, #8, #9; orchestrator-default |
| **P3.D18** | **`attempt_summary_mv` materialized view ships eagerly in G3.C.** Migration `modules/15-analytics/migrations/0060_attempt_summary_mv.sql` defines: `CREATE MATERIALIZED VIEW attempt_summary_mv AS SELECT ats.tenant_id, ats.attempt_id, a.assessment_id, a.user_id, a.status as attempt_status, a.submitted_at, ats.total_earned, ats.total_max, ats.auto_pct, ats.archetype, ats.computed_at, asm.pack_id, asm.level_id, asm.name as assessment_name FROM attempt_scores ats JOIN attempts a ON a.id = ats.attempt_id JOIN assessments asm ON asm.id = a.assessment_id;` + `CREATE UNIQUE INDEX attempt_summary_mv_pk ON attempt_summary_mv (tenant_id, attempt_id);` + `CREATE INDEX attempt_summary_mv_assessment_idx ON attempt_summary_mv (tenant_id, assessment_id);` + `CREATE INDEX attempt_summary_mv_archetype_idx ON attempt_summary_mv (tenant_id, archetype);`. RLS on materialized views isn't directly supported in Postgres 16 — the read path enforces tenant scope via `WHERE tenant_id = current_setting('app.current_tenant')::uuid` in the service layer (15's repository) and the linter `tools/lint-mv-tenant-filter.ts` (new in G3.C) asserts this. Daily refresh via the `assessiq-cron:analytics:refresh_mv` BullMQ job at 02:00 UTC: `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv;` (CONCURRENTLY requires the UNIQUE index — present). Real-time-ish reports (queueSummary, homeKpis) bypass the MV and query live tables; rolled-up reports (cohortReport, topicHeatmap, archetypeDistribution, exports) read from the MV. Refresh cadence is nightly, NOT real-time — the slight staleness (max 24h) is acceptable for L&D reporting per the no-objection in PROJECT_BRAIN.md scale model (`docs/01-architecture-overview.md:142-150`). TimescaleDB hypertable migration triggered at 50K-attempt threshold per P3.D22. | Cluster C GAP #5, #11, #12, #22; orchestrator-default |
| **P3.D19** | **Export formats for analytics = CSV + JSONL (matches audit exports per P3.D17 — single mental model). PDF Phase 4 deferred.** Same column-and-streaming contract as audit exports. CSV columns for `exportAttemptsCsv`: `tenant_id, assessment_id, assessment_name, user_id, user_email, attempt_id, status, submitted_at, total_earned, total_max, auto_pct, archetype, computed_at`. CSV columns for `exportTopicHeatmapCsv` (helper added in G3.C — wraps `topicHeatmap` for the export endpoint): `tenant_id, pack_id, topic, attempts_count, attempts_correct, hit_rate_pct, mean_band, p50_band`. The `archetypeDistribution` and `gradingCostByMonth` endpoints are JSON-only (no CSV variant) — the data shapes are inherently row-narrow and CSV would just be a one-line table. | Cluster C GAP #18, #19, #20; orchestrator-default |
| **P3.D20** | **Cross-module audit-write wiring sweep = G3.A's Session 1 includes a "wire critical audit sites" deliverable; remaining catalog entries land as a Phase 3 follow-up.** "Critical" in this context = the 9 highest-stakes entries from the catalog: `auth.login.totp_success`, `auth.login.totp_failed`, `auth.login.locked` (G3.A wires into `modules/01-auth/src/totp.ts` + `sessions.ts` — the TOTP verify + lockout paths shipped in Phase 0 G0.C-4); `auth.totp.reset` (G3.A wires into the admin force-reset path); `grading.override` (G3.A wires into `modules/07-ai-grading/src/handlers/admin-override.ts` — coordinated with G2.A 1.b's window α — but only if 1.b has merged, otherwise 1.b's Definition of Done absorbs the audit wiring); `tenant.settings.updated`, `tenant.branding.updated` (G3.A wires into `modules/02-tenancy/src/service.ts.updateTenantSettings` — replaces the Phase 0 `// TODO(audit)` console.warn); `webhook.created`, `webhook.deleted` (G3.A wires into 13-notifications' webhook CRUD — coordinated with G3.B's parallel-window for those handlers; G3.A ships the audit() calls inline so G3.B's PR can land them clean). The remaining catalog entries (user.*, pack.*, question.*, assessment.*, attempt.*, api_key.*, embed_secret.*, help.content.*) ship as a single follow-up sweep session **G3.D** in week 10 (Phase 3 follow-up; not a Phase 4 promotion — adding audit calls is mechanical and low-risk once the helper API is live; one Sonnet subagent per module-block, parallel dispatch, single coordinated PR per module). G3.D is listed in this plan's Routing summary; it does NOT block the Phase 3 closure since the load-bearing audit infrastructure (helper + table + GRANT + lint + the 9 critical sites) is live by end of G3.A. | Cluster B GAP B5; orchestrator-default |
| **P3.D21** | **Cost telemetry empty-shape contract for `claude-code-vps` mode.** `gradingCostByMonth(tenantId, year): Promise<CostRow[]>` returns `[]` (empty array) when `config.AI_PIPELINE_MODE === 'claude-code-vps'`, with a one-time INFO log per year-query: `gradingCostByMonth: cost telemetry not available in claude-code-vps mode (admin Max OAuth, no per-call cost)`. The `/api/admin/reports/cost-by-month?year=YYYY` endpoint returns `200 { items: [], mode: 'claude-code-vps', message: 'No cost telemetry in this pipeline mode — see docs/05-ai-pipeline.md D6 for context' }`. When mode flips to `anthropic-api` (Phase 3+ per D1), the function reads from `grading_jobs.cost_input_tokens / cost_output_tokens` (which exist as columns in the Phase 2 (deferred) shape per `docs/02-data-model.md:606-607`) and `tenant_grading_budgets.used_usd`. `CostRow` shape: `{ month: string (YYYY-MM), currency: 'USD', input_tokens: number, output_tokens: number, estimated_cost_usd: number, model: string }`. Module 10's billing page (Phase 2 G2.C) renders the empty-state copy gracefully — admin sees "No cost telemetry in claude-code-vps mode" without an error. | Cluster C GAP #15, #16, #17; orchestrator-default |
| **P3.D22** | **TimescaleDB hypertable migration trigger = measured 50K-attempts (per-VPS, not per-tenant) sustained over 30 days. Phase 4 work; Phase 3 only ships the materialized view.** Detection: a future `tools/scale-watch.ts` (Phase 4) reads `SELECT COUNT(*) FROM attempts WHERE created_at > now() - interval '30 days'` weekly and emails the admin when threshold passes. The migration is a one-time `SELECT create_hypertable('attempts', 'created_at', migrate_data => true)` after `pg_extension timescaledb` install on the VPS. The `attempt_summary_mv` from P3.D18 stays in place after the hypertable migration — MVs and hypertables coexist in Postgres + Timescale. The current Hostinger VPS has Postgres 16 vanilla; `timescaledb` install is an additive deploy event with the user in the loop per CLAUDE.md rule #8. **Phase 3 ships zero Timescale-related code or migrations.** | Cluster C GAP #10; orchestrator-default |

### User-blocking questions

**One soft escalation, no hard blocks.** P3.D9 (SMTP provider = AWS SES) is the only decision the user may want to overrule — Sendgrid is a simpler onboarding path if speed-to-first-real-email matters more than long-term cost optimization, and the user's existing AWS account state (or absence) determines the IAM-setup overhead. If the user picks Sendgrid, P3.D11's S3 audit-archive is unaffected (S3 is independent of email provider) and the only Phase 3 G3.B change is swapping `aws-sdk/client-ses` for `@sendgrid/mail` in the SMTP driver and the `tenants.smtp_config.provider` enum default. All other 13 decisions (P3.D10, P3.D12–P3.D22) are confirmed at orchestrator-default; D1–D8 are pinned by user confirmation on 2026-05-01.

---

## Session plan

Three groups, three sessions in the load-bearing run + one optional follow-up sweep: **G3.A** (one session, blocking, **codex:rescue mandatory** — 14-audit-log is on the load-bearing-paths list per CLAUDE.md), **G3.B** (one session, parallel-safe with G3.A — the email-stub interface is stable and the migrations don't collide), **G3.C** (one session, requires G3.A + G3.B + Phase 2 G2.B Session 3 09-scoring to have merged — reads from 14's audit_log + 09's attempt_scores). **G3.D** is the cross-module audit-write wiring sweep per P3.D20 — runs in week 10 after G3.A merges; explicitly NOT a blocker for Phase 3 closure.

```
Phase 2 G2.A 1.b ─┐ (window α — independent)
                  │
Phase 2 G2.B S3 ──┼──▶ G3.C
                  │
G3.A ─────────────┼──▶ G3.C
       │           │
       └─▶ G3.D    │ (audit-wiring sweep — week 10, non-blocking)
                  │
G3.B ─────────────┘
       (parallel with G3.A — webhook CRUD audit hooks coordinate)
```

### Group G3.A — Audit-log foundation (single session, blocking, **codex:rescue mandatory**)

#### Session 1 — `14-audit-log` (LOAD-BEARING — codex:rescue mandatory before push)

##### What to implement

1. **Migration `modules/14-audit-log/migrations/0050_audit_log.sql`** — per P3.D10, the table + GRANT + tenant_settings ALTER all in one atomic file so the load-bearing append-only invariant ships indivisibly:
   - `CREATE EXTENSION IF NOT EXISTS pgcrypto;` (defensive — already present from earlier migrations)
   - `CREATE TABLE audit_log (...)` with the exact schema from `docs/02-data-model.md:618-634` (BIGSERIAL PK, tenant_id NOT NULL, actor_user_id nullable, actor_kind CHECK enum, action TEXT, entity_type TEXT, entity_id UUID nullable, before JSONB, after JSONB, ip INET, user_agent TEXT, at TIMESTAMPTZ DEFAULT now())
   - `CREATE INDEX audit_log_tenant_at_idx ON audit_log (tenant_id, at DESC);`
   - `CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);`
   - Standard two-policy RLS (`tenant_isolation` USING + `tenant_isolation_insert` WITH CHECK)
   - `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM assessiq_app;` — load-bearing append-only enforcement
   - `ALTER TABLE audit_log SET (autovacuum_vacuum_scale_factor = 0.01);` — high-INSERT, occasional-DELETE-batch tuning
   - `ALTER TABLE tenant_settings ADD COLUMN audit_retention_years INT NOT NULL DEFAULT 7 CHECK (audit_retention_years BETWEEN 1 AND 10);` — per-tenant override per P3.D10
2. **Module skeleton at `modules/14-audit-log/src/`:**
   - `types.ts` — Zod schemas for `AuditWriteInput` (matches the helper signature), `AuditRow` (matches the table), `AuditFilter` (the `list()` filter shape), `ActorKind` enum (`'user'|'api_key'|'system'`); ActionName branded string (TypeScript brand for compile-time safety against typo-introducing new actions); the canonical action catalog as a frozen TypeScript object (`AUDIT_ACTIONS`) — adding a new action requires a typescript edit + a CI lint-passing test that the action is in the catalog.
   - `audit.ts` — the `audit({...})` helper. Implementation: opens a per-call DB connection (or reuses the request-context tx if present), `INSERT INTO audit_log (...)` returning nothing. Throws `AuditWriteError` on failure (callers MUST `await` and let exceptions bubble — silent catch is a CI lint reject, see below). Reads `requestId`, `tenantId`, `userId`, `ip`, `ua` from the request-context AsyncLocalStorage when not passed explicitly (most callers will pass `actorUserId` and `tenantId` explicitly because the audit-write site knows them; `ip`/`ua` default from the request context). Logs to `streamLogger('app').info({ action, entityType, entityId }, 'audit.write')` at INFO — never logs `before`/`after` JSONB (PII redaction primary control).
   - `service.ts` — `list({...})`, `exportCsv({...})`, `exportJsonl({...})` per P3.D17. `list` uses standard pagination (page/pageSize/total); `exportCsv`/`exportJsonl` use Postgres cursor streaming.
   - `webhook-fanout.ts` — per P3.D16: post-commit hook that calls `13-notifications.emitWebhook({tenantId, event: 'audit.<action>', payload})` for every audit row. Wired into `audit()` AFTER the INSERT commits. If 13-notifications hasn't shipped its `emitWebhook` yet (G3.B is parallel; coordinated commit window — see DoD), the call short-circuits to a no-op + INFO log.
   - `routes.ts` — Fastify plugin. `GET /api/admin/audit` (list with filters), `GET /api/admin/audit/export.csv` (streaming CSV), `GET /api/admin/audit/export.jsonl` (streaming JSONL), `GET /api/admin/audit/archives` (list of S3 archives — read from S3 ListObjects per tenant prefix), `POST /api/admin/audit/archives/:date/restore` (admin requests an archive download — worker S3 GETs and streams to the response). All admin-gated.
   - `archive-job.ts` — daily archive worker per P3.D11. BullMQ repeating job `audit_log:archive` registered in `apps/api/src/worker.ts` via the existing scheduler. Reads `audit_log WHERE at < now() - tenant_settings.audit_retention_years * interval '1 year'` per tenant, batches into 10MB chunks, gzips, S3 PUT with `If-None-Match: *` (idempotency safety; second run on same data is a no-op), only after 200 OK does the job DELETE the rows from the hot table (running as `assessiq_system` BYPASSRLS role — the SQL transaction is `SET LOCAL ROLE assessiq_system; DELETE FROM audit_log WHERE id IN (...); RESET ROLE;` so the GRANT enforcement still holds for app code).
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers Postgres + a mock S3 (use `aws-sdk-client-mock` or a moto container). Cases: helper writes a row with all required fields; helper rejects on bad ActionName (TypeScript-level check, but runtime guard for dynamic action names); RLS isolation cross-tenant (tenant A insert + tenant B SELECT returns zero); GRANT enforcement (app role can INSERT but `UPDATE` returns "permission denied"); archive job batches correctly; archive job is idempotent (re-run on same data is no-op due to `If-None-Match: *`); archive job DELETEs only after S3 PUT succeeds; export CSV streams the right columns with JSONB blobs as escaped-JSON strings; export JSONL streams the right shape; webhook fan-out fires post-commit (using a stub 13-notifications module); webhook fan-out short-circuits to no-op when 13's `emitWebhook` doesn't exist (Phase 3 G3.B coordination).
3. **Cross-module wiring — the 9 critical audit sites per P3.D20:**
   - `modules/01-auth/src/totp.ts:verify()` — on success: `audit({tenantId, actorUserId: userId, actorKind: 'user', action: 'auth.login.totp_success', entityType: 'session', entityId: sessionId})`; on failure: `auth.login.totp_failed`; on lockout (5 fails / 15 min trip): `auth.login.locked` with `entityType: 'user', entityId: userId, after: {locked_until: <ts>}`
   - `modules/01-auth/src/totp.ts:adminResetTotp()` (or wherever the admin-force-reset path lives) — `auth.totp.reset` with `entityType: 'user', entityId: targetUserId, before: {totp_enrolled_at: <ts>}, after: {totp_enrolled_at: null}`
   - `modules/02-tenancy/src/service.ts:updateTenantSettings()` — replace the existing `// TODO(audit)` console.warn with real `audit({tenantId, actorUserId, actorKind: 'user', action: 'tenant.settings.updated', entityType: 'tenant', entityId: tenantId, before: <previous>, after: <new>})`. `tenant.branding.updated` similarly.
   - `modules/07-ai-grading/src/handlers/admin-override.ts` (G2.A 1.b's window α) — `audit({tenantId, actorUserId, actorKind: 'user', action: 'grading.override', entityType: 'gradings', entityId: <new gradings.id>, before: <original gradings row>, after: <override row>})`. **Coordination note:** if G2.A 1.b has not yet merged when G3.A's Session 1 opens, the audit wiring for `grading.override` ships in 1.b's PR instead and G3.A's commit references the cross-PR coordination explicitly.
   - `modules/13-notifications/src/handlers/{create,delete}-webhook.ts` (G3.B's parallel-window territory) — `webhook.created`, `webhook.deleted`. **Coordination note:** these handlers don't exist until G3.B ships them; G3.A's Session 1 ships the audit() calls as inline patches that G3.B's PR will absorb cleanly. G3.B's PR includes the audit calls as pre-existing context (rebased over G3.A's merged commit).
4. **CI lint `tools/lint-audit-log-writes.ts`** — new lint, scans `modules/**/src/**/*.ts` for: (a) raw SQL or pg query strings touching `audit_log` outside `modules/14-audit-log/src/**` (rejects); (b) `.catch(...)` directly on `audit(...)` calls (rejects — silent catches break the compliance > convenience invariant); (c) `audit_log` table reads outside the helper's `service.ts` (rejects — single-reader-via-helper invariant for query consistency). Wired into `.github/workflows/ci.yml` step 9d as a required check.
5. **`apps/api/src/server.ts` wiring.** Imports + calls `registerAuditRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. New deps in `apps/api/package.json`: `@assessiq/audit-log: workspace:*`. Worker container picks up the daily archive job via `apps/api/src/worker.ts` registering `audit_log:archive` with the existing scheduler.
6. **Restore runbook in `docs/06-deployment.md`** — per P3.D11 + SKILL.md:71. New section: "§ Audit-log archive restore". Documents: (a) admin clicks "restore archive" in `/admin/audit/archives/:date`; (b) worker reads the `audit_log_archives` registry table for the S3 object key; (c) S3 GET, gunzip, stream; (d) audit rows NEVER re-INSERT into the hot table — archive is one-way; (e) common failure modes (S3 throttling, IAM permission rotation, gunzip integrity check failure).
7. **`infra/aws-iam/audit-archive-bucket-policy.json`** — IAM policy doc for the bucket per P3.D11. The user runs `tools/provision-audit-archive-bucket.sh` once during deploy to apply.
8. **`tools/lint-rls-policies.ts`** — extends `TENANT_RLS_TABLES` to include `audit_log` (standard tenant_id-direct policy). Also adds `audit_log_archives` (the registry table tracking S3 archive metadata — `{id, tenant_id, period_start, period_end, s3_key, byte_count, row_count, created_at}`, standard RLS).

##### Documentation references

- `modules/14-audit-log/SKILL.md` — public surface.
- `docs/02-data-model.md:618-634` — `audit_log` schema verbatim.
- `docs/03-api-contract.md:153-157` — admin audit endpoints.
- `docs/11-observability.md:22-34` (§ 2 boundary) — operational logs vs business audit vs behavioral telemetry.
- `docs/05-ai-pipeline.md:24-36` (D8 compliance frame) — `grading.override` audit invariant.
- `CLAUDE.md` rules #1, #4, #5, #8, #9; § Load-bearing paths (modules/14-audit-log/** is on the list).
- `PROJECT_BRAIN.md` non-negotiable principle #4 (auditable AI).
- `docs/01-architecture-overview.md:158` (data residency / DPDP).
- D1–D8 + P3.D10, P3.D11, P3.D16, P3.D17, P3.D20 in this plan.

##### Verification checklist

- [ ] `modules/14-audit-log/migrations/0050_audit_log.sql` applies clean to a fresh Phase 2 production DB; `tools/lint-rls-policies.ts` passes.
- [ ] `pnpm -r typecheck` green across all packages including `@assessiq/audit-log`.
- [ ] `pnpm --filter @assessiq/audit-log test` green — all testcontainer integration cases pass including: helper INSERT, GRANT-enforced UPDATE failure, RLS cross-tenant isolation, archive idempotency, archive DELETE-only-after-S3-PUT, export streaming, webhook fan-out post-commit, webhook fan-out no-op when 13 absent.
- [ ] `tools/lint-audit-log-writes.ts` passes against the current tree, fails against synthetic violation fixtures (raw SQL touching audit_log outside the helper; silent `.catch()` on audit; cross-module audit_log SELECT bypassing helper).
- [ ] App-role GRANT enforcement: `psql -U assessiq_app -c "UPDATE audit_log SET action='x' WHERE id=1"` returns `ERROR: permission denied for table audit_log`. Same for DELETE.
- [ ] The 9 critical audit sites: each writes a row when its triggering action runs (verified via integration test that exercises the auth + tenancy + grading paths).
- [ ] Webhook fan-out fires the right event-name shape for each audit action (mocked 13-notifications captures the call).
- [ ] Archive job: 7-day-old rows in a synthetic dataset get archived to mock S3, hot-table DELETE happens only after PUT, second job run is a no-op.
- [ ] Restore runbook procedure works end-to-end against mock S3 in the integration suite (admin restore returns the archive content as a stream).
- [ ] CSV export: synthetic 100-row dataset exports to a properly-quoted CSV with JSONB blobs as escaped-JSON strings, columns in the canonical order (P3.D17).
- [ ] JSONL export: same dataset exports to one-row-per-line JSONL with native nested JSON.
- [ ] No `claude` / `@anthropic-ai` imports anywhere in `modules/14-audit-log/**` (D2 lint enforces).
- [ ] **codex:rescue verdict logged in handoff (mandatory per CLAUDE.md § Load-bearing paths — module 14 is on the list).**

##### Anti-pattern guards

- **NEVER** UPDATE or DELETE an audit_log row from app code. The Postgres GRANT is the structural backstop; CI lint catches at write time; codex:rescue catches at review time.
- **NEVER** write audit_log rows outside the `audit()` helper. Single writer. The lint enforces.
- **NEVER** catch `audit()` failures silently — `.catch(() => {})` on an `audit(...)` call is a CI bounce. Compliance > convenience.
- **NEVER** log `audit_log.before`/`after` JSONB at INFO. PII redaction primary control: don't include the field. The redaction allowlist is defense-in-depth only.
- **NEVER** skip writing audit on `grading.override`. D8 compliance frame requires it; load-bearing rule per CLAUDE.md.
- **NEVER** bypass tenant_id scope on audit query. Cross-tenant audit leak = compliance incident. RLS scopes every read.
- **NEVER** re-INSERT archived rows back into the hot table. Archive is a one-way trip; restore is a stream-to-admin download only.
- **NEVER** rename or remove an action catalog entry once shipped. New actions append-only; renamed actions require versioning (e.g., `grading.override_v2`). Public contract for SIEM integrations.
- **NEVER** allow the daily archive DELETE to run before S3 PUT confirmation. Order: gzip → PUT → 200 OK → DELETE. Reverse order = data loss on S3 throttle.
- **NEVER** subscribe a `webhook_endpoints` row to `audit.*` events without the fresh-MFA + attestation modal (P3.D16 capability gate; G3.B's UI work covers it but G3.A's backend MUST enforce regardless of UI state).
- **NEVER** `claude` / `@anthropic-ai` / Agent SDK imports. Phase 3 modules are non-AI lanes per CLAUDE.md rule #1.
- **NEVER** add the `audit_log` table or any audit code to `apps/worker/**` outside the registered archive job. The archive job is the ONLY audit-related work running in the worker container.

##### DoD

1. **Pre-commit:** Phase 2-style deterministic gates pass (tests, secrets-scan, RLS linter, TODO/FIXME count, `lint:ambient-ai`, the new `lint-audit-log-writes`). **Phase 3:** Opus reviews the diff line-by-line — this is the largest single Phase 3 surface and the most security-sensitive (load-bearing per CLAUDE.md). **codex:rescue mandatory** — `modules/14-audit-log/**` is on the load-bearing-paths list. Log verdict in handoff.
2. Commit `feat(audit-log): phase-3 audit_log table + helper + GRANT + RLS + archive job + admin export + critical wiring`. Noreply env-var pattern.
3. Deploy: enumerate VPS first per CLAUDE.md rule #8; provision the S3 audit-archive bucket via `tools/provision-audit-archive-bucket.sh` (one-time, user-in-the-loop on AWS account access); apply migration `0050_audit_log.sql`; rebuild + recreate `assessiq-api` with `--no-deps --force-recreate`; rebuild + recreate `assessiq-worker` to pick up the daily archive job; smoke-test by exercising one of the 9 critical audit sites (e.g., login as admin, verify the row appears via `SELECT * FROM audit_log ORDER BY at DESC LIMIT 1`); verify the GRANT via `psql -U assessiq_app -c "UPDATE audit_log SET action='x' WHERE id=1"` returns permission denied.
4. Document: `docs/02-data-model.md` flips `audit_log` to Status: live with a link to migration `0050`; adds the `tenant_settings.audit_retention_years` and `audit_log_archives` schema; `docs/03-api-contract.md` ships the formalized `/admin/audit/*` endpoints (list + export.csv + export.jsonl + archives + restore); `docs/11-observability.md` § 2 cross-references the new helper + cites G3.A as the live ship date; `docs/06-deployment.md` adds § "Audit-log archive restore" runbook + the S3 bucket provisioning section; `modules/14-audit-log/SKILL.md` resolves P3.D10–P3.D11, P3.D16, P3.D17, P3.D20; appends entry to `docs/RCA_LOG.md` if any incident surfaces during deploy. **Append PROJECT_BRAIN.md § Build phases entry: "Phase 3 G3.A — `14-audit-log` table + helper + archive + critical wiring live (2026-MM-DD); 9 critical audit sites wired (auth.login.*, auth.totp.reset, tenant.{settings,branding}.updated, grading.override, webhook.{created,deleted}); G3.D sweep covers remaining catalog."**
5. Handoff: SESSION_STATE entry. **codex:rescue verdict line in the agent-utilization footer.**

---

### Group G3.B — Notifications real SMTP + webhooks + in-app (single session, parallel-safe with G3.A)

#### Session 2 — `13-notifications`

##### What to implement

1. **Migration `modules/13-notifications/migrations/0055_email_log.sql`** — defines `email_log` per Cluster A GAP #4 (the table is in the data-model module-map at line 27 but has no schema defined). Shape: `{id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL REFERENCES tenants(id), to_address text NOT NULL, subject text NOT NULL, template_id text NOT NULL, body_text text, body_html text, status text NOT NULL CHECK (status IN ('queued','sending','sent','failed','bounced')), provider text, provider_message_id text, attempts int NOT NULL DEFAULT 0, last_error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()}`. Standard tenant_id-direct RLS. Indexes: `(tenant_id, created_at DESC)`, `(tenant_id, status) WHERE status IN ('queued','failed','bounced')` (partial — only the actively-monitored states).
2. **Migration `modules/13-notifications/migrations/0056_in_app_notifications.sql`** — per P3.D13. Shape: `{id uuid PK DEFAULT uuidv7(), tenant_id uuid NOT NULL REFERENCES tenants(id), audience text NOT NULL CHECK (audience IN ('user','role','all')), user_id uuid REFERENCES users(id), role text CHECK (role IN ('admin','reviewer')), kind text NOT NULL, message text NOT NULL, link text, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()}`. Standard RLS. Index: `(tenant_id, audience, created_at DESC) WHERE read_at IS NULL` (partial — unread notifications are the hot read).
3. **Migration `modules/13-notifications/migrations/0057_tenants_smtp_config.sql`** — IF the column doesn't exist (it's listed in `docs/02-data-model.md:371` as Phase 1 G1.B Session 3 work; verify presence first, skip migration if present). Shape: `tenants.smtp_config jsonb DEFAULT '{}'::jsonb`. Validation lives in app-layer Zod schema (P3.D9 shape: `{provider, credentials_enc, from_address, reply_to?, template_overrides?}`).
4. **Module skeleton at `modules/13-notifications/src/`:**
   - `types.ts` — Zod schemas for `EmailRecord`, `WebhookEndpoint`, `WebhookDelivery`, `InAppNotification`, `SmtpConfig`, `EmailTemplateName` (literal union of the 7 template names). Re-exports `SendInvitationEmailInput` + `SendAssessmentInvitationEmailInput` from the existing stub interface so consumers are unchanged.
   - `email/index.ts` — `sendEmail({ to, template, vars, tenantId? }): Promise<void>`. Resolves SMTP driver: read `tenants.smtp_config` for the tenant; fall back to platform default (`process.env.SMTP_*`). Writes `email_log` row with `status='queued'`. Enqueues `email.send` BullMQ job. The job processor opens the SMTP connection (via `@aws-sdk/client-ses` or `@sendgrid/mail` per the resolved provider), sends, updates `email_log.status='sent'` + `provider_message_id`, or on failure `status='failed'` + `last_error`. Retry per the `JOB_RETRY_POLICY['email.send']` table (5 attempts, exponential base 5s, transient-only retry).
   - `email/templates/{invitation_admin,invitation_candidate,totp_enrolled,attempt_submitted_candidate,attempt_graded_candidate,attempt_ready_for_review_admin,weekly_digest_admin}.{html,txt}` — all 7 templates ship per P3.D14. Handlebars templating with strict allowlist (no `{{{triple-stash}}}`, every var HTML-escaped); per-template Zod validation of the `vars` parameter shape.
   - `email/legacy-shims.ts` — preserves the Phase 0 stub interface: `sendInvitationEmail(input)` and `sendAssessmentInvitationEmail(input)` are thin wrappers around `sendEmail({ to: input.to, template: 'invitation_admin', vars: {...mapped} })` and `sendEmail({ to: input.to, template: 'invitation_candidate', vars: {...mapped} })` respectively. Existing callers in 03-users + 05-assessment-lifecycle are unchanged.
   - `webhooks/service.ts` — `emitWebhook({tenantId, event, payload}): Promise<void>` enqueues a `webhook.deliver` BullMQ job per matching `webhook_endpoints` row (RLS-scoped); writes a `webhook_deliveries` row with `status='pending'`. `listWebhookEndpoints(tenantId)`, `createWebhookEndpoint({tenantId, url, events, name})` (mints a fresh secret, encrypts with `ASSESSIQ_MASTER_KEY`, returns the plaintext **once** then never again per the existing api_keys / embed_secrets pattern), `deleteWebhookEndpoint(id)`, `sendTestEvent(endpointId, eventName)` (calls `emitWebhook` with a synthetic payload), `listDeliveries({endpointId?, status?})`, `replayDelivery(id)` (writes a fresh delivery row, never UPDATEs the existing).
   - `webhooks/deliver-job.ts` — the BullMQ job processor. Reads `webhook_deliveries` row by id, fetches the endpoint, signs the payload with HMAC-SHA256 keyed by the decrypted secret, POSTs to the URL with the canonical headers (`X-AssessIQ-{Event,Delivery,Signature,Timestamp}`), checks response status. 2xx → `status='delivered'`, 4xx (except 408/425/429/5xx) → `status='failed'` permanent, 5xx + network errors → throw to trigger BullMQ retry per `JOB_RETRY_POLICY['webhook.deliver']` (5 attempts, literal `[1m, 5m, 30m, 2h, 12h]` schedule via custom delay function).
   - `webhooks/audit-fanout-handler.ts` — registered as a 14-audit-log post-commit listener (via the `webhook-fanout.ts` hook from G3.A). For every audit row, looks up `webhook_endpoints WHERE tenantId = audit.tenantId AND events @> ARRAY['audit.<action>']` (or `audit.*` wildcard). Per P3.D16 capability gate: subscriptions to `audit.*` require fresh-MFA + attestation at endpoint-create time (enforced in `createWebhookEndpoint`).
   - `in-app/service.ts` — `notifyInApp({tenantId, userId?, role?, kind, message, link?})` writes a row to `in_app_notifications`. `listInAppNotifications({tenantId, userId, since: cursor}): Promise<{items, cursor}>` short-poll endpoint per P3.D13 — returns unread + recently-read for the user (audience matches: own user_id OR matching role OR `audience='all'`).
   - `routes.ts` — Fastify plugin. `GET/POST/DELETE /api/admin/webhooks` + `POST /api/admin/webhooks/:id/test` + `GET /api/admin/webhooks/deliveries` + `POST /api/admin/webhooks/deliveries/:id/replay` (admin-gated; webhook-create with `audit.*` subscription requires fresh MFA per the capability gate); `GET /api/admin/notifications?since=` (any-role-gated; returns the user's in-app notifications); `POST /api/admin/notifications/:id/mark-read`.
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers Postgres + Redis (BullMQ) + a mock SMTP server (`smtp-tester` or similar) + a mock HTTP server for webhook delivery. Cases: `sendEmail` with each of the 7 templates writes the right `email_log` row; legacy-shim functions still work and route through `sendEmail`; `emitWebhook` enqueues per matching endpoint; signature verification matches the host-side example from `docs/03-api-contract.md:319-322` byte-for-byte; retry schedule fires at exactly `[1m, 5m, 30m, 2h, 12h]` (BullMQ test mode advances time); 4xx response is permanent fail (no retry); 5xx response triggers retry; `audit.*` subscription requires fresh-MFA capability check; in-app notification write + list + mark-read works; cross-tenant isolation on `email_log` + `webhook_*` + `in_app_notifications`.
5. **`apps/api/src/server.ts` wiring.** Imports + calls `registerNotificationsRoutes`. New deps in `apps/api/package.json`: `@assessiq/notifications: workspace:*` (already present from Phase 0/1; bump to satisfy the Phase 3 surface).
6. **`apps/api/src/worker.ts` wiring.** Registers the three new job processors (`email.send`, `webhook.deliver`, `audit_log:archive` from G3.A — coordinated). Adds entries to `JOB_RETRY_POLICY` per P3.D12.
7. **Cross-window coordination with G3.A:** the `webhook.created` and `webhook.deleted` audit calls land in `webhooks/service.ts` as inline `audit({...})` invocations. G3.A's PR ships these calls inline as patches to be absorbed by G3.B's PR; G3.B's PR rebases over G3.A's merge and the calls are pre-existing context. Test coverage: G3.B's webhook CRUD tests assert that `audit_log` rows get written for create + delete (using a real `@assessiq/audit-log` import — G3.B depends on G3.A having merged first, OR uses a test-time stub if running in isolation).
8. **`tools/lint-rls-policies.ts`** — extends to include `email_log` (standard tenant_id-direct), `in_app_notifications` (standard tenant_id-direct), and confirms `webhook_endpoints` (standard, already present from Phase 0 schema), `webhook_deliveries` (JOIN-RLS via endpoint_id; the linter's existing `JOIN_RLS_TABLES` carve-out covers this).

##### Documentation references

- `modules/13-notifications/SKILL.md` — public surface.
- `modules/13-notifications/src/email-stub.ts` — the existing Phase 0 stub interface (must be preserved).
- `docs/02-data-model.md:636-658` — webhook_endpoints + webhook_deliveries.
- `docs/02-data-model.md:371` — `tenants.smtp_config` JSONB column declared in Phase 1 G1.B-3.
- `docs/03-api-contract.md:138-152` — admin webhooks endpoints.
- `docs/03-api-contract.md:289-325` — webhook delivery contract + signature example (host-facing).
- `docs/11-observability.md` § 13 — worker observability inheritance (BullMQ wrapper + JOB_RETRY_POLICY pattern).
- `docs/06-deployment.md` — SMTP_URL env var (existing Phase 0 declaration).
- `CLAUDE.md` rules #1, #4, #8.
- P3.D9, P3.D12, P3.D13, P3.D14, P3.D16 in this plan.

##### Verification checklist

- [ ] All three migrations apply clean; `tools/lint-rls-policies.ts` passes (email_log + in_app_notifications standard tenant_id-direct; webhook_deliveries JOIN-RLS already accepted).
- [ ] `pnpm -r typecheck` green across `@assessiq/notifications` + every consumer.
- [ ] `pnpm --filter @assessiq/notifications test` green — all testcontainer + mock-SMTP + mock-webhook-receiver cases pass.
- [ ] Existing callers (`modules/03-users/src/invitations.ts`, `modules/05-assessment-lifecycle/src/email.ts`, `modules/05-assessment-lifecycle/src/service.ts`) still pass their existing tests — legacy shims preserve interface.
- [ ] All 7 email templates ship with both `.html` and `.txt` variants and a Zod schema for the `vars` parameter.
- [ ] Webhook signature verification: a synthetic test computes HMAC-SHA256 byte-for-byte matching the host-side example (`docs/03-api-contract.md:319-322`).
- [ ] Retry schedule: BullMQ in test mode advances time and asserts attempts fire at exactly `[1m, 5m, 30m, 2h, 12h]` (P3.D12 — literal, NOT exponential).
- [ ] 4xx response is permanent failure; 5xx + network errors trigger retry; final failure surfaces in admin replay UI via `webhook_deliveries.status='failed'`.
- [ ] `audit.*` event subscription requires fresh MFA (capability gate per P3.D16); admin without fresh MFA gets 401 on `POST /admin/webhooks` with `events: ['audit.*']`.
- [ ] In-app notification short-poll: `GET /admin/notifications?since=<cursor>` returns the right rows scoped to the user's tenancy + audience match.
- [ ] AWS SES driver works against a localstack mock; Sendgrid driver works against a mock if user picks the alternative; per-tenant `tenants.smtp_config` override resolves to the per-tenant driver.
- [ ] Email_log row written for every `sendEmail` call; `provider_message_id` populated on `sent`.
- [ ] No `claude` / `@anthropic-ai` imports anywhere in `modules/13-notifications/**` (D2 lint enforces).
- [ ] No `audit_log` writes outside the `@assessiq/audit-log` import (the lint from G3.A enforces).
- [ ] codex:rescue judgment-call: recommend invoke once on the SMTP driver (credential handling + per-tenant override is a privilege-boundary surface) and once on the webhook signature flow (HMAC implementation + timing-safe comparison + replay-window enforcement). 13-notifications is not on the load-bearing-paths list, but webhook signing is auth-adjacent.

##### Anti-pattern guards

- **NEVER** log full email body or webhook payload at INFO. PII redaction primary control; LOG_REDACT_PATHS allowlist is defense-in-depth.
- **NEVER** UPDATE existing `webhook_deliveries` row to record retries or replays — append-only delivery history; replays write a NEW row referencing the old via `replay_of` (Phase 4 column if needed; Phase 3 just writes a fresh row).
- **NEVER** auto-retry on 4xx response — wasted effort and bad-citizen pattern. Only 5xx + network errors retry.
- **NEVER** skip the timing-safe comparison on webhook signature validation in test mocks; the test mocks must mirror the production code path.
- **NEVER** store SMTP credentials in plaintext — encrypted at rest with `ASSESSIQ_MASTER_KEY` AES-256-GCM. Same for webhook endpoint secrets.
- **NEVER** subscribe a webhook endpoint to `audit.*` without the capability gate (P3.D16). G3.B's UI enforcement is one layer; the backend handler enforces regardless.
- **NEVER** broadcast in-app notifications cross-tenant. RLS is the structural backstop; service-layer code never queries without `app.current_tenant` set.
- **NEVER** import the grading runtime from any 13 file. D2 lint enforces.
- **NEVER** ship a per-tenant SMTP driver before the `tenants.smtp_config` JSONB validates against the Zod schema. Bad config → fall back to platform default with a WARN log; don't crash the worker.
- **NEVER** modify the existing `email-stub.ts` file — Phase 0 stub stays; the legacy shims in the new `email/legacy-shims.ts` are what existing callers indirectly route through.

##### DoD

1. Phase 3 gates pass; Phase 3 Opus diff review; **codex:rescue judgment-call** — recommend invoke once on (a) SMTP driver + per-tenant override (privilege-boundary surface) and (b) webhook signature + replay-window enforcement (auth-adjacent). 13-notifications is not load-bearing, but webhook signing is.
2. Commit `feat(notifications): phase-3 real smtp + webhook delivery + in-app + audit fanout`. Noreply env-var pattern.
3. Deploy: enumerate VPS first per CLAUDE.md rule #8; provision SMTP credentials in `/srv/assessiq/.env` (the user provisions AWS SES IAM access keys + region; or Sendgrid API key); apply migrations 0055/0056/0057; rebuild + recreate `assessiq-api` and `assessiq-worker`; smoke-test by sending a synthetic invitation email + verifying `email_log` row + provider_message_id; smoke-test webhook delivery against a public test endpoint (e.g., webhook.site) + verifying `webhook_deliveries.status='delivered'`.
4. Document: `docs/02-data-model.md` ships email_log + in_app_notifications schema with Status: live; `docs/03-api-contract.md` flips `/admin/webhooks/*` rows to `live (Phase 3)` Status; adds `/admin/notifications` + `/admin/notifications/:id/mark-read` rows; adds the audit-fanout subscription capability gate to the webhook-create error contract; `docs/06-deployment.md` adds § "SMTP provider" subsection (P3.D9 rationale + per-tenant override docs + AWS IAM setup); `docs/11-observability.md` § 3 flips `webhook.log` to live; `modules/13-notifications/SKILL.md` resolves P3.D9, P3.D12, P3.D13, P3.D14, P3.D16; appends entry to `docs/RCA_LOG.md` if any incident surfaces during deploy.
5. Handoff: SESSION_STATE entry.

---

### Group G3.C — Analytics + reports + exports (single session, after G3.A + G3.B + G2.B Session 3 09-scoring merge)

#### Session 3 — `15-analytics`

##### What to implement

1. **Migration `modules/15-analytics/migrations/0060_attempt_summary_mv.sql`** — per P3.D18. The materialized view + UNIQUE index + the two report indexes per the SQL block in P3.D18.
2. **Module skeleton at `modules/15-analytics/src/`:**
   - `types.ts` — Zod schemas for `HomeKpis`, `QueueSummary`, `CohortReport`, `IndividualReport`, `TopicHeatmap`, `ArchetypeDistribution`, `CostRow`, `AttemptExportRow`, `TopicHeatmapExportRow`, `ReportFilter`. The `CohortReport` shape: `{ assessmentId, attemptCount, averagePct, p25, p50, p75, p90, archetypeDistribution: Record<string, number>, levelBreakdown: Array<{levelId, attemptCount, averagePct}>, topicBreakdown: Array<{topic, attemptsCount, averagePct, hitRatePct}>, leaderboard: LeaderboardRow[] }` — wraps + extends 09's `cohortStats`. `IndividualReport`: `{ userId, attempts: Array<AttemptScore + sparklineDelta>, archetypeProgression: Array<{archetype, weight}>, topicHeatmap: TopicHeatmap }`. `TopicHeatmap`: `{ packId, periodStart, periodEnd, cells: Array<{topic, attemptsCount, attemptsCorrect, hitRatePct, meanBand, p50Band}> }`.
   - `repository.ts` — RLS-scoped pg queries against `attempt_summary_mv` (rolled-up reports) and live tables (`attempts`, `gradings`, `attempt_events`, `assessments`, `questions`) for real-time queries. Every query asserts `app.current_tenant` via `SET LOCAL` or relies on RLS; the linter `tools/lint-mv-tenant-filter.ts` (new) catches missed `WHERE tenant_id = current_setting(...)` on MV reads.
   - `service.ts` — public surface per SKILL.md:14-32 + the new endpoints from P3.D15 + P3.D17:
     - Dashboard: `homeKpis(tenantId)`, `queueSummary(tenantId)` (called by 07/10's existing handlers per P3.D15)
     - Reports: `cohortReport(assessmentId)` (wraps 09's `cohortStats` + adds level/topic/leaderboard), `individualReport(userId, {from?, to?})`, `topicHeatmap({tenantId, packId, from?, to?})`, `archetypeDistribution(assessmentId)`
     - Cost: `gradingCostByMonth(tenantId, year)` per P3.D21 empty-shape contract in `claude-code-vps` mode
     - Exports: `exportAttemptsCsv({tenantId, filters})`, `exportAttemptsJsonl({tenantId, filters})`, `exportTopicHeatmapCsv({tenantId, packId, from?, to?})` per P3.D19
   - `routes.ts` — Fastify plugin per P3.D15. Mounts: `GET /api/admin/reports/topic-heatmap`, `GET /api/admin/reports/archetype-distribution/:assessmentId`, `GET /api/admin/reports/cost-by-month?year=YYYY`, `GET /api/admin/reports/exports/attempts.csv`, `GET /api/admin/reports/exports/attempts.jsonl`, `GET /api/admin/reports/exports/topic-heatmap.csv`. The pre-existing `/api/admin/reports/cohort/:assessmentId` and `/api/admin/reports/individual/:userId` (claimed by 09 in G2.B Session 3) get refactored to call into 15's richer service layer (no route re-registration; in-place handler upgrade in 09).
   - `refresh-mv-job.ts` — daily BullMQ job `analytics:refresh_mv` registered in `apps/api/src/worker.ts`. Runs at 02:00 UTC. `REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv;` — CONCURRENTLY requires the UNIQUE index (present per P3.D18). Logs per the `runJobWithLogging` wrapper.
   - `index.ts` — public barrel.
   - `__tests__/` — vitest with testcontainers Postgres. Cases: synthetic data of 100 attempts per assessment + 5 assessments per tenant + 3 tenants → cohortReport + individualReport + topicHeatmap + archetypeDistribution all return the right shapes; cross-tenant isolation (the MV's WHERE-tenant_id filter holds); MV refresh is concurrent (no read blocking during refresh — verified by parallel SELECT during a synthetic refresh); CSV export streams correctly with Postgres cursor; JSONL export streams correctly; export columns match the canonical order (P3.D19); cost-by-month returns `[]` in claude-code-vps mode with the explanatory message; cost-by-month returns rows in anthropic-api mode (test-mocked via env override); the lint `tools/lint-mv-tenant-filter.ts` catches a synthetic violation (a SELECT from attempt_summary_mv without the tenant filter).
3. **Cross-module handler refactors (in-place upgrades):**
   - `modules/07-ai-grading/src/handlers/admin-queue.ts` — refactored to call `import { queueSummary } from '@assessiq/analytics'` and merge the result into its existing payload (per P3.D15, queueSummary becomes a service-layer call, not a duplicate route).
   - `modules/10-admin-dashboard/src/pages/dashboard.tsx` — refactored to consume `homeKpis(tenantId)` via the existing `/admin/dashboard/summary` endpoint (server-side) + render `<Sparkline>` for the auto-pct trend over last 8 weeks. **Coordination:** if Phase 2 G2.C hasn't shipped yet, this refactor lands as a follow-up patch; 15's service-layer surface ships in G3.C and the UI consumption is opportunistic.
   - `modules/09-scoring/src/handlers/admin-cohort-report.ts` (G2.B Session 3 ship) — refactored to call `import { cohortReport } from '@assessiq/analytics'` for the richer shape; 09's `cohortStats` becomes an internal helper called by 15.
4. **CI lint `tools/lint-mv-tenant-filter.ts`** — scans `modules/15-analytics/src/**/*.ts` for `attempt_summary_mv` reads and asserts every one is preceded by a `WHERE tenant_id = current_setting('app.current_tenant')...` clause OR runs inside a transaction that has `SET LOCAL app.current_tenant = ...`. Wired into CI step 9e.
5. **`apps/api/src/server.ts` wiring.** Imports + calls `registerAnalyticsRoutes`. New deps in `apps/api/package.json`: `@assessiq/analytics: workspace:*`.
6. **`apps/api/src/worker.ts` wiring.** Registers `analytics:refresh_mv` repeating job.
7. **Module 16-help-system seed update.** `modules/16-help-system/content/en/admin.yml` adds the four 15-specific keys per SKILL.md:39-43 + Cluster C GAP #14: `admin.reports.cohort.distribution`, `admin.reports.heatmap.colors`, `admin.reports.archetype.disclaimer` (deduplicate vs `admin.scoring.archetype.disclaimer` from P2.D17 — these can be the same key reused in both contexts), `admin.reports.export.format`. Plus four new ones surfaced by Phase 3: `admin.reports.cost.empty_in_claude_code_vps_mode` (P3.D21), `admin.audit.export.format` (P3.D17), `admin.audit.archives.restore_procedure` (P3.D11), `admin.notifications.in_app.short_poll_interval` (P3.D13). 8 new help_ids total. Re-run `tools/generate-help-seed.ts` to emit `0070_seed_help_phase3.sql` migration.

##### Documentation references

- `modules/15-analytics/SKILL.md` — public surface.
- `modules/09-scoring/SKILL.md` — upstream contract (cohortStats, leaderboard, deriveArchetype).
- `modules/14-audit-log/SKILL.md` — audit_log read access for cost/audit feed views.
- `docs/02-data-model.md` — every read table.
- `docs/03-api-contract.md:127-136` — pre-existing /admin/reports/* + /admin/dashboard/* endpoints.
- `docs/01-architecture-overview.md:142-150` — scale model (50K threshold context).
- `docs/01-architecture-overview.md:158` — DPDP / data residency.
- `docs/plans/PHASE_2_KICKOFF.md` § P2.D11, P2.D13, P2.D17, P2.D18.
- `CLAUDE.md` rules #1, #4, #8.
- P3.D13, P3.D15, P3.D17, P3.D18, P3.D19, P3.D21, P3.D22 in this plan.

##### Verification checklist

- [ ] Migration `0060_attempt_summary_mv.sql` applies clean; the MV exists post-migration with the UNIQUE index (verify via `\d attempt_summary_mv` in psql).
- [ ] `pnpm -r typecheck` green across `@assessiq/analytics` + every consumer (07, 09, 10).
- [ ] `pnpm --filter @assessiq/analytics test` green — all integration cases pass.
- [ ] CONCURRENT refresh: a parallel SELECT during a synthetic REFRESH MATERIALIZED VIEW CONCURRENTLY does not block (verified via testcontainers + parallel client).
- [ ] `tools/lint-mv-tenant-filter.ts` passes against the current tree, fails against a synthetic violation (a SELECT FROM attempt_summary_mv without the tenant filter).
- [ ] All export endpoints stream via Postgres cursor; memory profile stays bounded at 1000-row chunks.
- [ ] Cost endpoint in claude-code-vps mode returns `200 { items: [], mode: 'claude-code-vps', message: '...' }` — verified explicitly.
- [ ] Cost endpoint in anthropic-api mode (test-mocked) returns rows from `grading_jobs.cost_*`.
- [ ] Cross-tenant isolation: tenant A's reports do not include tenant B's attempts; verified via testcontainer with two tenants.
- [ ] Help YAML seed re-generation idempotent: `tools/generate-help-seed.ts` produces the same `0070_seed_help_phase3.sql` on second run.
- [ ] No `claude` / `@anthropic-ai` imports anywhere in `modules/15-analytics/**` (D2 lint enforces).
- [ ] No `audit_log` writes from 15 — read-only contract; the lint from G3.A enforces.
- [ ] No `attempt_summary_mv` or `attempt_scores` WRITEs from 15 — read-only contract; the linter checks via Grep (no INSERT/UPDATE/DELETE on these table/view names).
- [ ] No heavyweight chart library in the bundle — `pnpm --filter @assessiq/web build` size delta < 30KB gzipped (Phase 2 G2.C established the budget).
- [ ] codex:rescue judgment-call: recommend skip — pure read-only aggregation, no auth/RLS-mutation/AI surface. The MV-refresh job is the only side-effect path and it's a single-statement refresh wrapped in the existing job logger.

##### Anti-pattern guards

- 15 must NOT write to any table or the MV (read-only contract). The lint `tools/lint-mv-tenant-filter.ts` catches MV-side; the existing rule (no WRITE outside owning module) catches table-side.
- 15 must NOT invoke an LLM for report generation. Archetype labels come from 09's `attempt_scores.archetype`; topic heatmap math is pure SQL aggregation.
- 15 must NOT bypass RLS on table reads; the MV requires explicit tenant filter (lint catches).
- 15 must NOT export across tenants (DPDP / data-residency per P3.D13 restated).
- 15 must NOT compute archetypes (09 owns; 15 reads `attempt_scores.archetype`).
- 15 must NOT block report endpoints on cold-storage audit_log restore (only hot-table reads; the audit-archive S3 GET happens in 14's restore handler, never inline in 15's report query).
- 15 must NOT ship a heavyweight chart library — pure SVG only per Phase 2 G2.C decision.
- 15 must NOT cache cross-tenant report data (per-tenant cache only, RLS-enforced; if any caching layer is added in Phase 4, the cache key MUST include `tenant_id`).
- 15 must NOT return `attempt_events.payload` to candidates. Phase 1 invariant; 15 is admin-only territory.
- 15 must NOT enable PDF export in Phase 3 (P3.D19 — Phase 4 deferred). The Puppeteer dependency is a security-blast-radius hazard.
- 15 must NOT enable public-facing leaderboard (P3.D13 restatement of P2.D13). Tenant-private + admin-only stays.
- 15 must NOT run the MV refresh during high-traffic windows; 02:00 UTC schedule (low-traffic for India + US) is load-bearing for performance.

##### DoD

1. Phase 3 gates pass; Phase 3 Opus diff review; **codex:rescue judgment-call** — recommend skip (pure read-only aggregation, no auth/RLS-mutation/AI surface).
2. Commit `feat(analytics): phase-3 attempt_summary_mv + reports + exports + cost-empty-shape + help-seed`. Noreply env-var pattern.
3. Deploy: enumerate VPS first; apply migration `0060_attempt_summary_mv.sql` and `0070_seed_help_phase3.sql`; rebuild + recreate `assessiq-api` (new routes) and `assessiq-worker` (new MV-refresh job); run a one-time `REFRESH MATERIALIZED VIEW attempt_summary_mv;` (initial population); smoke-test by hitting `/api/admin/reports/topic-heatmap` against the existing Phase 1/2 data + verifying the response shape.
4. Document: `modules/15-analytics/SKILL.md` Status: live for the Phase 3 surface (with Phase 4 deferral list for PDF export, public leaderboard, custom report builder, TimescaleDB hypertable); `docs/02-data-model.md` adds the `attempt_summary_mv` definition with Status: live; `docs/03-api-contract.md` flips the pre-existing /reports/* + /dashboard/* rows to live (with Phase column annotated G2.B/G2.C/G3.C as appropriate) + adds the new G3.C endpoints; `docs/05-ai-pipeline.md` § cost telemetry gets a "see also `modules/15-analytics`" cross-reference and the P3.D21 empty-shape contract; `modules/16-help-system/content/en/admin.yml` ships the 8 new keys; `modules/09-scoring/SKILL.md` annotates the `cohortStats` upgrade to internal-helper status; `modules/07-ai-grading/SKILL.md` and `modules/10-admin-dashboard/SKILL.md` note the in-place handler refactors. **Phase 3 closes here.**
5. Handoff: SESSION_STATE entry. **Phase 3 closes here.**

---

### Group G3.D — Cross-module audit-write wiring sweep (week 10, single session, NON-BLOCKING for Phase 3 closure)

#### Session 4 — Audit-write sweep across remaining catalog entries (per P3.D20)

##### What to implement

1. **Per-module audit() call wiring** for the remaining catalog entries from `modules/14-audit-log/SKILL.md:29-61` (the 9 critical sites already shipped in G3.A's Session 1):
   - **`03-users`:** user.created (POST /admin/users), user.role.changed (PATCH /admin/users/:id), user.disabled (PATCH /admin/users/:id status=disabled), user.deleted (DELETE /admin/users/:id) — wire into `modules/03-users/src/{handlers,service}.ts`
   - **`04-question-bank`:** pack.created/published/archived, question.created/updated/imported — wire into `modules/04-question-bank/src/handlers/*.ts`
   - **`05-assessment-lifecycle`:** assessment.created/published/closed/invite — wire into `modules/05-assessment-lifecycle/src/{service,routes}.ts`
   - **`06-attempt-engine`:** attempt.started/submitted/released/deleted — wire into `modules/06-attempt-engine/src/service.ts` (note: candidate-side actions still write audit_log because the candidate is still an actor with a session — `actorKind: 'user'`, `actorUserId: candidateUserId`)
   - **`01-auth`:** auth.totp.enrolled, auth.recovery.used (the .reset entry shipped in G3.A) — wire into `modules/01-auth/src/totp.ts`
   - **`13-notifications`:** api_key.created/revoked, embed_secret.created/rotated, webhook.replayed — wire into `modules/13-notifications/src/{api-keys,embed-secrets,webhooks}/service.ts`
   - **`16-help-system`:** help.content.updated — wire into `modules/16-help-system/src/handlers/admin-{import,patch}.ts`
2. **Parallel-Sonnet dispatch.** This session uses `superpowers:dispatching-parallel-agents` (a dev-workflow override per CLAUDE.md AssessIQ rule #3 — applicable here because each module's wiring is independent and contracted-against-G3.A's-helper). One Sonnet subagent per module (5–7 parallel agents); each prompt includes the module path, the audit() helper signature from `@assessiq/audit-log`, and the per-module catalog of audit actions to wire. Each agent reports a unified diff + a passing test that exercises one of the new audit() calls.
3. **Single coordinated PR per module.** Each Sonnet subagent ships its module's audit wiring as a separate commit on the same branch; the orchestrator merges them in one PR after review. **codex:rescue judgment-call:** recommend skip (mechanical wiring of a load-bearing helper; G3.A already adversarial-reviewed the helper itself; per-call sites are low-risk patches).

##### Documentation references

- `modules/14-audit-log/SKILL.md` — the action catalog.
- Each per-module SKILL.md — for context on the existing handler shapes.
- `docs/RCA_LOG.md` — for any patterns of audit-related-incidents (none today; this sweep prevents future ones).

##### Verification checklist

- [ ] Every catalog entry has at least one wired call site (cross-checked via Grep on the action name string).
- [ ] No regression on existing module tests.
- [ ] At least one new test per module that exercises the audit-row write (verifies the helper got the right `action` + `entityType` + `before`/`after` shape).
- [ ] No `.catch(() => {})` on any `audit(...)` call (the G3.A lint catches).
- [ ] `pnpm -r test` green.

##### Anti-pattern guards

- Inherits all G3.A guards. Specifically: NEVER add an audit() call without `await`-ing it; NEVER catch silently; NEVER log `before`/`after` JSONB at INFO.
- NEVER add an action name not in the SKILL.md catalog (the lint enforces — adding to the catalog requires a SKILL.md edit + test).
- For candidate-side audit writes (06-attempt-engine), `actorKind: 'user'` and `actorUserId` MUST be the candidate's user ID, not the admin's.

##### DoD

1. Phase 3 gates pass; Phase 3 Opus diff review (one PR, multi-module).
2. Commit (one per module): `feat(<module>): wire audit() calls for <action.namespace>`. Single coordinated PR for all 7 modules.
3. Deploy: additive — recreate `assessiq-api` to pick up the new audit calls (no migrations); smoke-test by exercising one action per module.
4. Document: each module's SKILL.md notes the audit wiring is live; PROJECT_BRAIN.md gets a one-line entry: "Phase 3 G3.D — full audit catalog wired across 7 modules (2026-MM-DD)."
5. Handoff: SESSION_STATE entry.

---

## Final phase — Phase 3 verification (orchestrator-only, no new session)

After G3.A + G3.B + G3.C land (G3.D is non-blocking — Phase 3 closure does not wait), the orchestrator runs a single verification pass:

1. **Manual full-stack smoke** — admin logs in → MFA → opens `/admin/audit` → sees recent rows (auth.login.totp_success at minimum) → exports CSV (verifies streaming) → opens `/admin/webhooks` → registers a test endpoint at webhook.site → triggers a test event → confirms `webhook_deliveries.status='delivered'` and webhook.site shows the signed payload → opens `/admin/notifications` → sees recent in-app notifications → opens `/admin/reports/topic-heatmap?packId=...` → renders heatmap → exports CSV → opens `/admin/reports/cost-by-month?year=2026` → sees the empty-state in `claude-code-vps` mode with the explanatory message. Take screenshots; attach to handoff.
2. **Append-only invariant drill** — `psql -U assessiq_app -c "UPDATE audit_log SET action='hacked' WHERE id = 1"` returns `ERROR: permission denied for table audit_log`. Same for DELETE and TRUNCATE. Verify the GRANT is in place via `\dp audit_log`.
3. **Cross-tenant audit isolation drill** — using `assessiq_system` BYPASSRLS role, insert audit rows for tenant A. As tenant B's admin, hit `/admin/audit` and `/admin/audit/export.csv` — confirm tenant A's rows are absent. Same for `email_log`, `webhook_*`, `in_app_notifications`, `attempt_summary_mv` reads.
4. **Webhook signature drill** — host-side verification snippet from `docs/03-api-contract.md:319-322` runs against an actual delivered webhook; HMAC matches byte-for-byte; 5-minute timestamp window enforced (replay older than 5 min rejects).
5. **Webhook retry drill** — register a webhook against a mock endpoint that returns 503 for 4 attempts then 200 — verify the retry schedule is exactly `[1m, 5m, 30m, 2h, 12h]` (BullMQ admin shows next-attempt at the right ts), then 5th attempt succeeds with `status='delivered'`. Same drill but mock returns 503 forever — final state `status='failed'`, admin replay UI surfaces the row, click Replay → fresh delivery row writes.
6. **Webhook 4xx-permanent drill** — register a webhook against a mock endpoint that returns 403; verify single attempt, immediate `status='failed'`, no retries.
7. **Audit-fanout drill** — register a webhook with `events: ['audit.grading.override']` (requires fresh-MFA + attestation modal — verify gate); trigger a grading.override on an attempt; verify the webhook fires within seconds (post-commit fan-out) and the payload matches the audit row's shape.
8. **Capability gate drill** — admin without fresh MFA tries to subscribe a webhook to `events: ['audit.*']` — endpoint rejects with 401 + capability-failed error code; admin re-MFAs + retries → succeeds.
9. **Audit archive drill** — synthetic data: insert 1000 audit rows with `at = now() - interval '8 years'`; manually trigger the daily archive job; verify the rows are S3-archived (object key `<tenant_id>/2018/<MM>/<batch_id>.jsonl.gz`); verify the rows are DELETEd from the hot table; verify the `audit_log_archives` registry row is created. Then admin clicks `/admin/audit/archives/2018-04/restore` and downloads the JSONL.
10. **MV refresh drill** — manually trigger the analytics:refresh_mv job; verify the MV row count reflects current `attempt_scores` count; verify CONCURRENTLY didn't block parallel SELECTs during refresh (run a parallel `SELECT COUNT(*) FROM attempt_summary_mv` in another psql session during the refresh).
11. **Cost telemetry drill** — `GET /admin/reports/cost-by-month?year=2026` in claude-code-vps mode returns `{ items: [], mode: 'claude-code-vps', message: '...' }`; switch `AI_PIPELINE_MODE=anthropic-api` env (test only — DO NOT do this on production until paid budget lands), insert synthetic `grading_jobs` rows with cost_input_tokens populated, re-hit the endpoint → returns rows.
12. **In-app notification drill** — admin tab open; trigger a webhook.failed event (mock receiver returns 500 5 times); within 60s the next short-poll picks up the in-app notification with `kind='webhook.failed'`; admin clicks → marks read → next poll doesn't return it.
13. **Email send drill** — send a synthetic invitation via `/admin/users/invitations` (Phase 0 G0.C-5 shipped); verify SES (or Sendgrid per P3.D9) actually delivers to the test inbox; verify `email_log.status='sent'` + `provider_message_id` populated; verify the legacy stub interface still works (Phase 0 callers unchanged).
14. **VPS additive-deploy audit** — `ssh assessiq-vps`, run `docker ps` (only assessiq-api + assessiq-worker recreated; other 14 co-tenant containers untouched), `systemctl list-units --state=running --no-pager` (no new units), `diff /opt/ti-platform/caddy/Caddyfile.bak.<latest> /opt/ti-platform/caddy/Caddyfile` (Phase 3 doesn't touch edge config — diff should be empty; webhook delivery is outbound, requires no edge route addition), `ls /opt/ti-platform/caddy/ssl/` (no changes). Confirm no other apps' configs or containers touched. Confirm S3 bucket `assessiq-audit-archive` provisioned with the right IAM policy + encryption settings.
15. **Doc drift sweep** — for each Phase 3 module: SKILL.md Status reflects live; `docs/02-data-model.md` (audit_log + audit_log_archives + email_log + in_app_notifications + tenant_settings.audit_retention_years + tenants.smtp_config + attempt_summary_mv) all show Status: live; `docs/03-api-contract.md` (admin/audit/* + admin/webhooks/* + admin/notifications + admin/reports/* + admin/reports/exports/*) all show Status: live (Phase 3); `docs/06-deployment.md` § Audit-log archive restore + § SMTP provider live; `docs/11-observability.md` § 3 webhook.log live; `modules/16-help-system/content/en/admin.yml` ships the 8 Phase 3 keys. Phase 3 entry appended to `PROJECT_BRAIN.md` § Build phases.
16. **codex:rescue final pass** on the merged Phase 3 surface — 14-audit-log is the load-bearing artifact, the GRANT enforcement + the archive job + the `grading.override` audit invariant are the security-defining surfaces. Log final verdict.

If any step fails: open one bounce-back session, fix, re-verify the failed step only.

---

## Routing summary (for future-me)

| Activity | Where |
|---|---|
| This plan | Anyone reads `docs/plans/PHASE_3_KICKOFF.md` |
| Each session's day-one read | `PROJECT_BRAIN.md` + `docs/01-architecture-overview.md` + `docs/SESSION_STATE.md` + `docs/RCA_LOG.md` + `docs/05-ai-pipeline.md` (every Phase 3 session — D1–D8 still apply) + `docs/11-observability.md` § 2 boundary (audit vs ops vs telemetry) + this file's session block + the module's `SKILL.md` |
| Subagent delegation inside a session | Per global `CLAUDE.md` orchestration playbook (Sonnet for mechanical implements, Haiku for grep sweeps + post-deploy verification, Opus for diff critique). G3.D specifically uses parallel Sonnet dispatch for the per-module audit wiring sweep. |
| Adversarial review | `codex:rescue` **mandatory** on G3.A Session 1 (`14-audit-log` — load-bearing per `CLAUDE.md`, helper + GRANT + archive job + critical wiring); judgment-call on G3.B (recommend invoke once on SMTP credential handling + once on webhook signature flow); recommend skip on G3.C (read-only aggregation); recommend skip on G3.D (mechanical wiring of an already-rescued helper). |
| Out-of-scope deferrals | **Phase 4+ (post-Phase-3):** PDF export of audit + reports (Puppeteer dependency security blast radius); public-facing leaderboard (DPDP review + per-tenant opt-in); cryptographic audit chain (each row hashes previous); WORM bucket for ultra-strict compliance; WebSocket / SSE for in-app notifications; per-user notification preferences (digest vs immediate); per-tenant SMTP custom template overrides; tenant-defined custom archetypes; tenant-defined custom report builder; TimescaleDB hypertable on `attempts`; per-tenant SSE-KMS encryption on audit S3 archive; rich SIEM connectors (Splunk HEC, Datadog Audit Trail) — webhook fan-out is the primitive that enables them, dedicated connectors are optional polish. **Phase 3 G3.D (week 10, non-blocking):** the cross-module audit-write sweep for all non-critical catalog entries (user.*, pack.*, question.*, assessment.*, attempt.*, api_key.*, embed_secret.*, help.content.*, plus auth.totp.enrolled and auth.recovery.used). |

---

## Appendix A — `modules/14-audit-log/SKILL.md` action catalog (immutable once shipped)

The dot-namespaced action names are public contract for SIEM integrations. Once an action ships in `audit_log`, its name is **permanent**. New actions are append-only; renames require versioning (e.g., `grading.override_v2`).

```
auth.login.totp_success
auth.login.totp_failed
auth.login.locked
auth.totp.enrolled
auth.totp.reset
auth.recovery.used

tenant.settings.updated
tenant.branding.updated

user.created
user.role.changed
user.disabled
user.deleted

pack.created
pack.published
pack.archived
question.created
question.updated
question.imported
assessment.created
assessment.published
assessment.closed
assessment.invite

attempt.started
attempt.submitted
attempt.released
attempt.deleted
grading.override
grading.retry

api_key.created
api_key.revoked
embed_secret.created
embed_secret.rotated
webhook.created
webhook.deleted
webhook.replayed

help.content.updated
```

Critical 9 (G3.A Session 1 wires): `auth.login.totp_success`, `auth.login.totp_failed`, `auth.login.locked`, `auth.totp.reset`, `tenant.settings.updated`, `tenant.branding.updated`, `grading.override`, `webhook.created`, `webhook.deleted`. Remaining 26 land in G3.D.

---

## Appendix B — Phase 3 G3.A migration order (operational recipe for Session 1's deploy step)

```
1. Provision S3 audit-archive bucket (one-time, user-in-the-loop):
   bash tools/provision-audit-archive-bucket.sh
   # Creates s3://assessiq-audit-archive with SSE-S3 encryption,
   # versioning enabled, lifecycle policy: Standard → Standard-IA at 30d → Glacier at 90d.
   # Applies the IAM policy at infra/aws-iam/audit-archive-bucket-policy.json.

2. Backup tenant_settings + audit_log (audit_log won't have rows yet but capture
   the schema diff):
   pg_dump -t tenant_settings -t audit_log assessiq \
     > /var/backups/assessiq/audit-pre-phase3-$(date -u +%Y%m%dT%H%M%SZ).sql

3. Apply migration:
   docker exec -i assessiq-postgres psql -U assessiq -d assessiq -v ON_ERROR_STOP=1 \
     < modules/14-audit-log/migrations/0050_audit_log.sql

4. Verify:
   docker exec assessiq-postgres psql -U assessiq -d assessiq \
     -c "\d audit_log" \
     -c "\d audit_log_archives" \
     -c "\d tenant_settings" \
     -c "\dp audit_log"     # confirms GRANT shape
   # Then verify the GRANT enforces:
   docker exec assessiq-postgres psql -U assessiq_app -d assessiq \
     -c "INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type) \
         VALUES ('00000000-0000-0000-0000-000000000000','system','test','test')"
   # → INSERT 0 1 (succeeds)
   docker exec assessiq-postgres psql -U assessiq_app -d assessiq \
     -c "DELETE FROM audit_log WHERE action = 'test'"
   # → ERROR: permission denied for table audit_log

5. Set audit-archive S3 credentials in /srv/assessiq/.env:
   ssh assessiq-vps 'grep -q AUDIT_ARCHIVE_S3_BUCKET /srv/assessiq/.env || \
     cat >> /srv/assessiq/.env <<EOF
AUDIT_ARCHIVE_S3_BUCKET=assessiq-audit-archive
AUDIT_ARCHIVE_S3_REGION=ap-south-1
AUDIT_ARCHIVE_AWS_ACCESS_KEY_ID=<from AWS console>
AUDIT_ARCHIVE_AWS_SECRET_ACCESS_KEY=<from AWS console>
EOF'

6. Recreate API container (env_file diff requires recreate, not restart, per RCA 2026-05-01):
   ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml \
     up -d --no-deps --force-recreate assessiq-api'

7. Recreate worker container to pick up the daily archive job:
   ssh assessiq-vps 'cd /srv/assessiq && docker compose -f infra/docker-compose.yml \
     up -d --no-deps --force-recreate assessiq-worker'

8. Smoke:
   curl -fsS https://assessiq.automateedge.cloud/api/health  # 200
   # Then login as admin via browser, MFA, and verify the audit_log row appears:
   docker exec assessiq-postgres psql -U assessiq -d assessiq \
     -c "SELECT at, action, actor_kind FROM audit_log ORDER BY at DESC LIMIT 5"
   # → at least one auth.login.totp_success row from the smoke login.
```

G3.B and G3.C migration recipes follow the same pattern (additive, recreate-don't-restart, smoke after each container).

---

## Status

- **Plan version:** 1.0 (2026-05-03, orchestrator: Opus 4.7 [1M context])
- **Open questions outstanding:** one soft (P3.D9 SMTP provider — user may prefer Sendgrid over AWS SES; non-blocking, swap is mechanical). All other 21 decisions captured at orchestrator-default; D1–D8 are verbatim restatements of the user-confirmed `docs/05-ai-pipeline.md` § Decisions captured (2026-05-01) and stay load-bearing.
- **Blocking dependencies before G3.A opens:** none beyond the Phase 2 G2.A 1.a foundation (already on `main` as commit `7eea75b`). G3.A is parallel-safe with G2.A 1.b (window α). G3.B is parallel-safe with G3.A. **G3.C requires Phase 2 G2.B Session 3 (`09-scoring`) to have merged** — `attempt_summary_mv` joins `attempt_scores`. If G2.B Session 3 is delayed, G3.C waits.
- **Next action:** if user approves P3.D9 (or picks Sendgrid), open G3.A Session 1 and G3.B Session 2 in parallel windows. G3.C opens after both merge AND G2.B Session 3 09-scoring merges. G3.D opens any time after G3.A merges.
