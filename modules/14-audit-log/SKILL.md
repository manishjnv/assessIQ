# 14-audit-log — Append-only audit trail

> **Distinct from operational logs.** Operational logs (`/var/log/assessiq/*.log`) live for 14 days and answer "what did the app do today?". This module's `audit_log` table lives for 7 years and answers "what state changed, by whom, when?" — a compliance auditor's view. A single event sometimes writes to both (e.g., a failed login appears in `auth.log` *and* `audit_log`); they answer different questions and have different retention. See [docs/11-observability.md § 2](../../docs/11-observability.md) for the boundary.

## Purpose
Record every state-changing action with actor, before/after, IP, UA, timestamp. Required for HR/L&D-grade defensibility, compliance audits, and forensic investigation.

## Scope
- **In:** `audit_log` writes (helper API used by every module), admin viewer with filters, export (CSV/JSONL), retention policy.
- **Out:** behavioral telemetry (lives in `attempt_events`).

## Dependencies
- `00-core`
- `02-tenancy` — tenant-scoped writes
- Postgres (append-only INSERT only; no UPDATE or DELETE policy on this table)

## Public surface
```ts
audit({
  tenantId, actorUserId?, actorKind, action, entityType, entityId?,
  before?, after?, ip?, userAgent?
}): Promise<void>

// query (admin only)
list({ tenantId, filters: { actor?, action?, entityType?, entityId?, from?, to? }, page, pageSize })
exportCsv({ tenantId, filters }): Promise<Stream>
```

## What gets audited (action catalog)
Every `<entity>.<verb>` follows the same pattern. Initial catalog:

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

pack.created / pack.published / pack.archived
question.created / question.updated / question.imported
assessment.created / assessment.published / assessment.closed / assessment.invite

attempt.started / attempt.submitted / attempt.released / attempt.deleted
grading.override                   # most-scrutinized action
grading.retry

api_key.created / api_key.revoked
embed_secret.created / embed_secret.rotated
webhook.created / webhook.deleted / webhook.replayed

help.content.updated
```

## Retention
- Default: 7 years (covers most compliance windows)
- Tenant-overrideable in `tenant_settings.audit_retention_years` (min 1, max 10)
- Daily job archives rows older than retention to cold storage (S3) and removes from hot table; archive accessible via admin export only

## Storage discipline
- `audit_log` is INSERT-only at the application layer
- Postgres role used by app has no UPDATE/DELETE on this table
- BACKUP includes audit_log; restore process documented in runbook
- Optional WORM (write-once-read-many) for ultra-strict compliance — Phase 4

## Help/tooltip surface
- `admin.audit.actions` — action catalog with descriptions
- `admin.audit.retention` — what's archived when
- `admin.audit.export` — CSV/JSONL format

## Open questions
- Cryptographic chain (each row hashes previous) — defer; meaningful only for very high compliance bars
- Real-time SIEM forwarding — webhook the audit stream out via 13-notifications (trivial extension)
