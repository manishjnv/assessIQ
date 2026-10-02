# 13-notifications — Email, webhooks, in-app alerts

## Purpose
Outbound communication. Three channels (email, webhook, in-app), one queue, consistent delivery semantics.

## Scope
- **In:** transactional email (invitation, MFA enrollment, attempt submitted, attempt graded, weekly admin digest), outbound webhooks (registered endpoints, signed payloads, retries), in-app notifications surfaced in admin UI.
- **Out:** authoring email content (templates live here, but copy is reviewed by ops); marketing email (not done by AssessIQ).

## Dependencies
- `00-core` (logger, errors)
- `02-tenancy` (notification preferences per tenant)
- `14-audit-log` (every webhook delivery audited)
- BullMQ for queueing
- SMTP provider via env (`SMTP_URL`)

## Public surface
```ts
// internal API used by other modules
sendEmail({ to, template, vars }): Promise<void>
emitWebhook({ tenantId, event, payload }): Promise<void>
notifyInApp({ tenantId, userId?, role?, message }): Promise<void>

// admin
listWebhookEndpoints(tenantId): Promise<WebhookEndpoint[]>
createWebhookEndpoint(input): Promise<WebhookEndpoint>
deleteWebhookEndpoint(id): Promise<void>
sendTestEvent(endpointId, eventName): Promise<DeliveryResult>
listDeliveries({ endpointId?, status? }): Promise<WebhookDelivery[]>
replayDelivery(id): Promise<DeliveryResult>
```

## Webhook delivery
- Async via BullMQ `webhooks:queue`
- Sign payload: `X-AssessIQ-Signature: sha256=<HMAC of body using endpoint secret>` (V1, body only, unchanged)
- Replay-safe signature (2026-10-01): `X-AssessIQ-Timestamp: <unix seconds>` + `X-AssessIQ-Signature-V2: sha256=<HMAC-SHA256("<timestamp>.<raw body>", secret)>`. Receivers verify V2 and **reject timestamps older than 5 minutes** (`verifySignatureV2` is the reference implementation).
- Headers: `X-AssessIQ-Event`, `X-AssessIQ-Delivery`, `X-AssessIQ-Timestamp`, `X-AssessIQ-Signature`, `X-AssessIQ-Signature-V2`
- Retries: 5 attempts, backoff `[1m, 5m, 30m, 2h, 12h]`
- Final failure: `webhook_deliveries.status='failed'`, surfaces in admin UI for replay
- SSRF guard + hardened transport (2026-10-01) — see "Webhook safety" below. Refused deliveries are failed immediately (`last_error='blocked_address' | 'blocked_url'`), never retried.

## Email templates
Stored in `modules/13-notifications/templates/<name>.{html,txt}` with Handlebars-style vars. Tenant can override per template (Phase 2). Templates:
- `invitation_admin` — invite to manage AssessIQ
- `invitation_candidate` — magic-link to take an assessment
- `totp_enrolled` — TOTP enrollment confirmation
- `attempt_submitted_candidate` — "we got it"
- `attempt_graded_candidate` — "results released"
- `attempt_ready_for_review_admin` — when AI grading needs human review
- `weekly_digest_admin` — Monday morning rollup

## Data model touchpoints
Owns: `webhook_endpoints`, `webhook_deliveries`, `email_log`. Reads: `users` (recipient context), `tenant_settings` (notification prefs).

## Help/tooltip surface
- `admin.integrations.webhooks.create.events` — event catalog
- `admin.integrations.webhooks.signing` — verification example
- `admin.integrations.webhooks.retry-policy`
- `admin.notifications.email.templates` — how to override (Phase 2)

## Open questions
- Slack/Teams notifications — Phase 3 via webhook to incoming-webhook URLs (no special integration needed)
- Per-user notification preferences (digest only, no immediates) — Phase 2

## Status

**Live — 2026-05-03 (Phase 3 G3.B Session 2).** Full pipeline shipped. All three channels operational.

### What shipped (Phase 3 G3.B)

- **SMTP via nodemailer + generic SMTP transport** (P3.D9). `SMTP_URL` env var; Resend as default (`smtps://apikey:<key>@smtp.resend.com:465`). Empty `SMTP_URL` → stub-fallback writes JSONL to `/var/log/assessiq/dev-emails.log` — no deploy breakage before creds provisioned.
- **7 Handlebars email templates** (P3.D14) — both `.html` and `.txt` variants, Zod-validated vars, HTML-escaped by default (no triple-stash). `.txt` compiled with `noEscape: true` so URLs are never entity-encoded.
- **Signed outbound webhooks** (P3.D12) — `HMAC-SHA256` (`sha256=<hex>` format); secrets AES-256-GCM encrypted at rest under `ASSESSIQ_MASTER_KEY`; plaintext returned ONCE on create. Retry schedule: `[1m, 5m, 30m, 2h, 12h]` (published API contract — do not change without API version bump).
- **In-app short-poll notifications** (P3.D13) — `GET /api/admin/notifications?since=<cursor>` returns `{ items, cursor }`; `POST /api/admin/notifications/:id/mark-read`. No WebSocket/SSE — deferred to Phase 4.
- **P3.D16 fresh-MFA gate** — `audit.*` webhook subscriptions require `session.lastTotpAt` within 5 minutes; returns `401 FRESH_MFA_REQUIRED` otherwise.
- **G3.A audit fanout hook** (`audit-fanout-handler.ts`) — dynamic import of `@assessiq/audit-log`; no-op + INFO log if absent (G3.A not yet merged).
- **BullMQ integration** — `email.send` (exponential backoff, internal) and `webhook.deliver` (custom literal backoff, published) jobs processed by `assessiq-worker`.
- **Legacy shims preserved** — `sendInvitationEmail` and `sendAssessmentInvitationEmail` still exported with identical signatures; `03-users` and `05-assessment-lifecycle` require no changes.

### Key pinned decisions

| ID | Decision |
|---|---|
| P3.D9 | nodemailer generic SMTP transport; Resend as default provider via `SMTP_URL` |
| P3.D12 | Webhook retry schedule `[1m,5m,30m,2h,12h]` is published API contract |
| P3.D13 | In-app delivery = short-poll only; no SSE/WebSocket in Phase 3 |
| P3.D14 | Handlebars templates, Zod-validated vars, HTML-escape on `.html`, no-escape on `.txt` |
| P3.D16 | `audit.*` webhook subscriptions require fresh MFA (≤5 min) — enforced at route layer |

### Migrations

| File | Table | Status |
|---|---|---|
| `0055_email_log.sql` | `email_log` | live |
| `0056_in_app_notifications.sql` | `in_app_notifications` | live |
| `0057_tenants_smtp_config.sql` | no-op (already added by `02-tenancy` migration 0004) | live |
| `0058_webhook_tables.sql` | `webhook_endpoints`, `webhook_deliveries` | live |
| `0121_notifications_update_policies.sql` | `email_log`, `webhook_deliveries` (UPDATE RLS policies) | new — see "UPDATE policies" below |

### What is NOT included

- Per-tenant SMTP override UI (data model supports `tenants.smtp_config` JSONB but no admin route yet)
- Slack/Teams native integrations (covered by registering a webhook to the Slack incoming-webhook URL)
- Per-user notification preferences (Phase 4)
- WebSocket/SSE push (Phase 4)
- G3.A audit-log registration hook — G3.A's merge wires `handleAuditFanout` into the post-commit path

## Email internationalization (2026-05-11)

Email-template copy is externalized through a tiny string-registry layer at `src/email/i18n.ts`, backed by per-locale JSON bundles in `src/email/strings/<lang>.json`. Only English (`en.json`) ships today; the resolver is locale-aware so additional bundles drop in without further code changes.

**Resolution order.** `render.ts` calls `buildVars(templateName, vars)` with the default locale `'en'`. The TODO in `i18n.ts` documents the future seam: when `tenant_settings.preferred_language` (or a per-recipient override) is added, the call site becomes `buildVars(name, parsed, tenantLang ?? 'en')`. There is no per-recipient locale today.

**String keys.** Each template owns a flat key map (`page_title`, `greeting`, `cta`, etc.) under its own object in `en.json`. The resolver throws loudly on a missing template or missing key — typos surface in tests, not at first send. Templates reference resolved strings via `{{_t_<key>}}` placeholders; the `_t_` prefix is reserved for resolver output and must not be set by callers. Variable interpolation inside string values (`{{candidateName}}`, `{{expiresInDays}}`) is performed by the resolver before the value is injected into Handlebars.

**Adding a new locale.** Drop a sibling JSON file (e.g. `strings/fr.json`) with the same template/key shape, then thread the locale through `renderTemplate` → `buildVars`. No template edits required as long as the new bundle covers every key currently in `en.json`.

**Adding a new string key.** Add the key to `en.json` under the relevant template, then reference it in the template as `{{_t_<key>}}`. Any future locale bundles must mirror the addition; the resolver only falls back when the *whole template entry* is missing — a missing individual key still throws.

**Brand-string exception.** `AssessIQ` (and any future white-label wordmark per tenant) is intentionally routed through the same `brand_wordmark` key so per-tenant rebranding can be added later without a template diff. Today it is constant English. URLs (invitation links, dashboard links, results links) are **never** placed in the strings bundle — they are vars passed by the caller, since a translated URL would be a phishing vector.

**Partial-state note.** This pass externalizes page titles, greetings, headings, CTAs, table labels, and security warnings. Body-copy sentences ("You have been invited to take …") remain inline in the HTML templates, marked with `<!-- i18n: body copy not yet externalized -->` so the gap is visible. The `.txt` plain-text variants are also still inline. Closing both is a follow-up pass.


## `result_released` email (SP4, 2026-10-01)

Closed-enum template `result_released` (vars: `candidateName, assessmentName, tenantName, scoreText "42 / 60 (70%)", resultText Passed|Not passed, portalLink ${ASSESSIQ_BASE_URL}/candidate/login?tenant=<slug>, certificateLink?`). `sendResultReleasedEmail({tenantId, attemptId})` (`src/email/result-released.ts`) loads the data itself (withTenant), emails only an attempt that is actually `released`, skips erased candidates (DPDP) and embed attempts, and is best-effort — it never throws into the release flow (07 manual Release / release-all, apps/api auto-release sweep call it AFTER the release tx commits). Final score only — nothing per-question (P1). It replaces a dynamic import in 07 that silently never found the function.
## `evaluation_queue_alert` email (Phase II SP11, 2026-10-01)

Closed-enum template `evaluation_queue_alert` (vars: `count` int, `oldestAgeHours` number, `queueLink` = `${ASSESSIQ_BASE_URL}/admin/platform/evaluations`) — the platform owner's "evaluations are waiting more than 24 hours" alert. Counts and a link only: never a tenant, assessment or candidate name. `sendEvaluationQueueAlertEmail({to[], count, oldestAgeHours})` (`src/email/evaluation-queue-alert.ts`) sends one email per address, logged under `PLATFORM_TENANT_ID`, best-effort per recipient (a failing address is logged and skipped; returns `{sent}` so the caller can retry when nothing went out). Called only by the worker job `evaluation.queue_alert` (apps/api `jobs/evaluation-queue-alert.ts`, hourly, at most once per 24 h via Redis key `aiq:alert:evaluation_queue`, recipients = `SUPER_ADMIN_EMAILS`).

## `invitation_reminder` email (2026-10-02)
Closed-enum template `invitation_reminder` (same vars as `invitation_candidate`; `expiresAt` carries the effective deadline as a readable UTC string). Subject `Reminder: your <assessment> closes soon`. `sendInvitationReminderEmail({to, candidateName, assessmentName, invitationLink, deadline, tenantName, tenantId})` (`src/email/invitation-reminder.ts`) THROWS on failure so module 05's sweep can release its claim. Class `bulk`. Called only by module 05 `sweepInvitationReminders` (worker job `invitation.reminders`).

## Email delivery classes — auth vs bulk (2026-10-01)

**What.** Every `email.send` job belongs to one of two classes, decided by template name in `src/email/delivery-policy.ts` (`EMAIL_CLASS` is a `Record<EmailTemplateName, …>`, so a new template does not compile until it is classified).

| Class | Templates | Queue priority | Retries |
|---|---|---|---|
| `auth` | `admin_email_otp`, `candidate_login_link`, `invitation_admin` | none (unprioritized) | 5 attempts, exponential 5 s (as before — codes expire) |
| `bulk` | everything else (`invitation_candidate`, `result_released`, `evaluation_queue_alert`, `totp_enrolled`, `attempt_*`, `weekly_digest_admin`) | 100 | 11 attempts, custom backoff type `email-bulk`: 1 m, 5 m, 15 m, 1 h, 2 h, 4 h, 6 h, 8 h, 12 h, 12 h (~45 h) |

**Why.** The SMTP provider (Brevo free: 300/day, shared with other products) fails every send once the daily limit is hit; with 5 attempts over ~1–2 minutes the email was simply lost. And one queue/worker (concurrency 1) also runs the cron ticks, so 200 CSV-import invitations delayed a sign-in code by minutes.

**BullMQ ordering (verified in 5.76.5 `moveToActive-11.lua` and on a real Redis).** A worker pops the `wait` list first and only then the `prioritized` set. So a job with **no** priority (cron ticks, webhook deliveries, auth emails) always runs before **any** prioritized job, whatever the number; among prioritized jobs a lower number runs first (FIFO per number). Hence auth = unprioritized (priority 1 would queue it *behind* cron), bulk = a priority number. Priority orders jobs; it does not preempt the running one.

**Failure handling (`processEmailSendJob`, `{attempt, maxAttempts}` passed by the worker).**
- SMTP enhanced status **5.1.x** (no such user, bad address) is a permanent recipient error: `UnrecoverableError`, no retry, `email_log.status='failed'` at once. Deliberately narrow — other 5xx (quota/daily limit, policy, sender or auth problems) keep retrying, and so does 5.1.x on `MAIL FROM` (that is the *sender*, i.e. our config).
- `email_log.status`: `queued → sending → sent`. A failure BullMQ will retry goes back to `queued` (+ `last_error`, real `attempts`); `failed` means final (attempts exhausted or permanent) — the meaning `0055_email_log.sql` documents. No schema change, no new status.
- One `warn` `email.send.attempt_failed` per failed attempt: `emailLogId, template, emailClass, attempt, maxAttempts, smtpCode, enhancedCode, errCode, permanent, willRetry`. No recipient and no SMTP reply text (it echoes the address).
- The worker has a single custom backoff strategy; `notificationsBackoffStrategy(attemptsMade, type)` routes `'email-bulk'` to the schedule above and everything else (`'custom'`) to the untouched webhook schedule.

**Considered and rejected.** A separate queue/worker for bulk (more infra for the same effect); `priority: 1` for auth (queues behind cron); a new `retrying` email status (schema change); treating every 5xx as permanent (a daily-limit reply would lose the email — the bug being fixed).

**NOT included.** SMTP connection/socket timeouts on the nodemailer transport (defaults are long; a hung relay can still hold the single worker slot), a priority for `webhook.deliver` (still shares the unprioritized lane with auth), per-tenant send quotas, bounce ingest.

**Downstream.** `JOB_RETRY_POLICY['email.send']` in `apps/api/src/worker.ts` mirrors the auth class and is documentation only; jobs enqueued before this change keep their stored options. Observability: new warn line above.

## Webhook safety — SSRF guard + signed timestamp (2026-10-01)

**What.**
- `src/webhooks/url-policy.ts` (pure): `validateWebhookUrl` — must parse, `https:` only (`http:` only when `NODE_ENV !== 'production'`), no userinfo, hostname not `localhost`/`*.localhost`, IP literal not blocked — and `isBlockedIp`. IPv4 deny-list (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4 incl. broadcast); IPv6 allow-list (only global unicast `2000::/3` minus 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20), so loopback/unspecified/ULA/link-local/multicast/IPv4-compatible/reserved are blocked by default; IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) are judged by the embedded IPv4.
- `createWebhookEndpoint` runs the URL policy and throws `AppError('WEBHOOK_URL_NOT_ALLOWED', 400, { details: { reason } })` — handled by the existing `AppError` error handler. No update route exists; this is the only write path. It does no DNS.
- `src/webhooks/safe-post.ts` is the only way a webhook leaves the worker (Node core `http`/`https`, **no new dependency**): URL policy re-checked on every delivery (legacy rows are never trusted); address policy enforced at **connect time** through a custom `lookup` that resolves with `all: true` and refuses if ANY answer is blocked (DNS rebinding cannot slip between check and connect; IP-literal hosts never reach `lookup`, so they are checked up front); redirects never followed; one 10 s deadline over DNS+connect+TLS+response; at most 2 KB of response read; `agent: false` (fresh socket, no pooling, no env proxy).
- `deliver-job.ts`: a refusal (`WebhookRefusedError`) marks the delivery `failed` with `last_error` = `blocked_address` (resolved/literal address is not public) or `blocked_url` (scheme/userinfo/localhost/unparseable) and returns normally — **not retried**. 3xx is a permanent failure (`HTTP 302: redirects are not followed`). 4xx (except 408/425/429) stays permanent and now stores `HTTP <status>: <first ≤2 KB of the response, control chars stripped>` in `last_error`. 5xx / 408 / 425 / 429 / network errors / timeout still throw → BullMQ retry schedule. Refusal is logged as `webhook.delivery.refused` (reason, endpointId, host, resolved address — never the URL, which often carries a secret path).
- `signature.ts`: `X-AssessIQ-Timestamp` is now **unix seconds** and `X-AssessIQ-Signature-V2` = `sha256=` + HMAC-SHA256 of `"<timestamp>.<raw body>"`; `X-AssessIQ-Signature` (V1) is unchanged. `verifySignatureV2` rejects non-numeric timestamps and timestamps more than 300 s away.

**Why.** Delivery was a bare `fetch(endpoint.url)` in the worker container on a shared VPS — a tenant admin could point it at the cloud metadata address, Docker/internal hosts, our Postgres/Redis, and `fetch` follows redirects. The V1 HMAC covers only the body, so a captured delivery was replayable forever.

**Considered and rejected.** A pre-resolve-then-fetch check (TOCTOU/rebinding); an undici dispatcher (extra dependency; Node core suffices); an env/NODE_ENV switch to disable the address guard for tests (test-only `deps` parameter instead — `processWebhookDeliverJob(job, { isBlocked, resolver, timeoutMs })`, not reachable from config); keeping the old ISO `X-AssessIQ-Timestamp` next to a new header (two timestamp headers; the contract asked for unix seconds).

**NOT included.** Egress firewalling (still recommended: the VPS's own public IP is a "public" address to this policy), port restrictions, per-tenant allow-lists, re-validation of stored endpoint URLs in bulk (they are re-checked per delivery instead), fixing `webhookBackoffStrategy`'s off-by-one (BullMQ passes the 1-based attempt count, so the first webhook retry waits 5 m not 1 m — pre-existing, published schedule, left alone).

**Downstream.** `X-AssessIQ-Timestamp` changed from ISO-8601 to unix seconds — receivers that parsed the ISO value must switch to V2 verification; docs/03-api-contract.md and docs/09-integration-guide.md still show the ISO example. Existing endpoints with `http://`, userinfo, or private/loopback targets stop delivering (`blocked_*`) after deploy.

## UPDATE policies on email_log + webhook_deliveries — migration 0121 (2026-10-01)

**What.** One `FOR UPDATE` RLS policy per table (`tenant_isolation_update`): same tenant predicate as the existing SELECT/INSERT policies, on both the old row (`USING`) and the new row (`WITH CHECK`), so a row can neither be updated from another tenant nor moved to one.

**Why.** `0055` and `0058` created only `FOR SELECT` + `FOR INSERT` policies. With RLS on and no UPDATE policy, an UPDATE as `assessiq_app` matches **zero rows, silently** (verified on a Postgres built from the repo migrations; the code already logs `email_log.update.no_rows_affected`). So the worker's status writes never persisted: `email_log` stayed `queued`, `webhook_deliveries` stayed `pending` — and the new `last_error='blocked_address'` record of a refused delivery would have been lost. Other tables use `CREATE POLICY ... USING (...)` with no `FOR`, which covers UPDATE. If production was patched by hand, 0121 only adds an OR-ed policy.

**Considered and rejected.** Writing the outcome as a NEW row (webhook_deliveries is documented append-only per delivery, but `updateWebhookDeliveryStatus` has always UPDATEd it; a second row per delivery would break the list/replay UI); `FORCE ROW LEVEL SECURITY`/owner tricks.

**NOT included.** `in_app_notifications` has the same SELECT+INSERT-only shape (mark-read matches 0 rows) — same fix, not part of this change. No DELETE policy.

**Test.** `src/__tests__/notifications-update-policies.test.ts` (real Postgres): own-tenant writes persist; another tenant's context updates 0 rows; tenant_id / endpoint_id cannot be moved to another tenant. Rollback: `DROP POLICY tenant_isolation_update ON email_log; DROP POLICY tenant_isolation_update ON webhook_deliveries;`.

## 2026-10-02 - mark-read RLS, webhook backoff off-by-one, exhausted deliveries -> failed

**What changed.** (1) `migrations/0126_in_app_notifications_update_policy.sql`: tenant-scoped FOR UPDATE policy (USING + WITH CHECK) on `in_app_notifications`; before it `markInAppNotificationRead` matched 0 rows under RLS. Per-user scoping stays in the repository WHERE (the SELECT policy is tenant-only too). (2) `webhookBackoffStrategy` now indexes `schedule[attemptsMade-1]` (BullMQ passes the 1-based count), so the first retry waits 1 m, then 5 m, 30 m, 2 h, 12 h; clamped to the last entry. `delayFor` (0-indexed) is unchanged. (3) `deliver-job.ts`: on the job's FINAL attempt (`attemptsMade + 1 >= opts.attempts`) a transient failure (5xx/408/425/429/network/timeout) sets the row `failed` (+ `last_error`, `http_status`, `attempts`) before throwing; `failed` was already allowed by the 0058 CHECK, so no schema change (0127 is the help seed only).

**Why.** Rows stayed `pending` for ever and the published schedule was not honoured. **Considered and rejected.** Writing `failed` from a BullMQ `failed` event (needs a second worker hook; the processor already has tenant context). **NOT included.** The job still has `attempts: 5` = 4 retries, so the 12 h step is defined but never reached; raising attempts to 6 changes the published contract and was left for an explicit decision. **Impact.** Only retries scheduled after deploy change timing. Tests: `notifications-update-policies.test.ts`, `notifications.test.ts`, `webhook-safety.test.ts`.
