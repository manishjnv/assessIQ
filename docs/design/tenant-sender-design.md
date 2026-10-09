# Tenant email sender (`smtp_config`) — design note (FU-A15)

**Status: design only, not built.** Date 2026-10-09. Parked for the Enterprise tier until the first customer asks (FR15, FU-A16).

## What

One shape for `tenant_settings.smtp_config` so a company can send candidate mail from its own domain. Today the column is NULL on every tenant and two shapes exist on paper: the migration comment (`{host, port, secure, user, password_enc, from_address, from_name}`) and the code type read by `resolveTransport` (`{provider, smtp_url, from_address, from_name, reply_to, template_overrides}`, password in plain text inside the URL). Nothing writes either shape.

## Why

A customer who sends from its own domain gets better delivery and brand trust. A plain-text password in a JSON column is not acceptable, and two shapes drift.

## The one shape

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "user": "mailer@example.com",
  "password_enc": "<aes-gcm envelope>",
  "from_address": "exams@example.com",
  "from_name": "Example University",
  "reply_to": "support@example.com",
  "verified_at": "2026-10-09T10:00:00Z",
  "last_error": null
}
```

- `password_enc` uses the single AES-256-GCM core in `modules/00-core/src/aes-gcm.ts` (N24 merge, 2026-10-03) with `MASTER_KEY`. Same envelope as the other encrypted columns, so the MASTER_KEY rotation cursor covers it (RCA 2026-10-02).
- The code type in `modules/13-notifications/src/types.ts` changes to this shape; `resolveTransport` builds the nodemailer transport from fields, not from a URL. `smtp_url` and `provider` are dropped. `template_overrides` moves out of this column (it is a different concern; keep it where FU-B19 decides).
- The API never returns `password_enc`. GET answers `password_set: true`.

## SPF and DKIM check step

Before `verified_at` is set, the save handler runs two DNS lookups on the `from_address` domain: a TXT record that starts with `v=spf1` and includes the configured host (or its provider include), and a DKIM TXT record at `<selector>._domainkey` when the admin gives a selector. A failed check saves the config but leaves `verified_at` null and shows the two findings. The check is advisory, because many hosts delegate DNS; it is not a hard gate.

## Test-send button

`POST /api/admin/tenant/smtp/test` sends one fixed template (`smtp_test`) to the calling admin's own address through the tenant transport, synchronously, with the existing SMTP timeouts. Success sets `verified_at`. The response carries the SMTP response code on failure (`describeSmtpFailure`). Rate limit: 3 per 10 minutes per tenant. Audit row `tenant.smtp_test`.

## Fallback to the platform sender

`resolveTransport` order: tenant transport when `smtp_config` is present and `verified_at` is set; else the platform `SMTP_URL`; else the dev stub. A permanent tenant SMTP error (auth failure, 5xx) on a real send writes `last_error`, clears `verified_at`, notifies the tenant admin once (in-app notification), and the job retries on the platform sender so the candidate still gets the mail. The retry path is the existing BullMQ email job; no new worker.

## Options considered and rejected

- Keep the URL shape and encrypt the whole URL: simpler, rejected because the host and user are useful in the clear for display and the SPF check.
- Resend API per tenant instead of SMTP: rejected, locks the customer to one provider.
- Hard-fail sends when the tenant SMTP is down: rejected, a candidate must get the invitation.

## Not included

Any migration, code, UI or help text. DMARC checks. Per-template senders. Inbound mail.

## Downstream impact when built

`docs/02-data-model.md` (column shape, replace the FU-A16 note), `docs/03-api-contract.md` (GET/PUT/test routes under tenant context), module 02 (settings write with audit), module 13 (transport, template `smtp_test`), module 10 (settings card), module 16 (help ids under `admin.tenant_settings.smtp.*`), module 14 (audit action), `docs/11-observability.md` (log event for fallback).
