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
- Sign payload: `X-AssessIQ-Signature: sha256=<HMAC of body using endpoint secret>`
- Headers: `X-AssessIQ-Event`, `X-AssessIQ-Delivery`, `X-AssessIQ-Timestamp`
- Retries: 5 attempts, backoff `[1m, 5m, 30m, 2h, 12h]`
- Final failure: `webhook_deliveries.status='failed'`, surfaces in admin UI for replay

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
