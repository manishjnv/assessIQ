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

**Stub live — 2026-05-01 (Phase 0 G0.C-5 / Window 5).** Workspace package `@assessiq/notifications` shipped with a single `sendInvitationEmail()` export backed by `modules/13-notifications/src/email-stub.ts`.

- **Behavior:** synchronous append-only JSONL write to `$ASSESSIQ_DEV_EMAILS_LOG ?? /var/log/assessiq/dev-emails.log` (production) or `~/.assessiq/dev-emails.log` (dev). One JSON object per line, fields `{ts, to, subject, body, template_id}` (per `modules/03-users/SKILL.md` § Decisions captured § 8 — exact field set). Plus a console-INFO log entry per send.
- **What's NOT in the stub:** SMTP, BullMQ queueing, retries, webhooks, in-app notifications, all template files beyond `invitation.user`. The full webhook + SMTP + template pipeline lands in Phase 3.
- **Why it's split out as its own workspace package** (vs inlined into 03-users): keeps `inviteUser`'s notification dependency injectable + testable (tests `vi.mock('@assessiq/notifications', ...)`), and lets Phase 3 swap the stub for the real adapter without touching 03-users.
- **codex:rescue note (LOW, deferred):** `ASSESSIQ_DEV_EMAILS_LOG` is read directly from `process.env` rather than going through `00-core` `ConfigSchema` Zod validation. Phase 3 SMTP wiring re-evaluates whether this env var stays (probably removed when SMTP replaces the stub).
