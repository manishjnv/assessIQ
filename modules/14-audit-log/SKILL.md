# 14-audit-log — Append-only audit trail

> **Distinct from operational logs.** Operational logs (`/var/log/assessiq/*.log`) live for 14 days and answer "what did the app do today?". This module's `audit_log` table lives for 7 years and answers "what state changed, by whom, when?" — a compliance auditor's view. A single event sometimes writes to both (e.g., a failed login appears in `auth.log` *and* `audit_log`); they answer different questions and have different retention. See [docs/11-observability.md § 2](../../docs/11-observability.md) for the boundary.

## Status

**Live — shipped 2026-05-03 at `43c0e45`.**

G3.A implementation: Sonnet 4.6 (primary — migration, helper, service, routes, tests, 9 hook sites), Haiku 4.5 (3 parallel Phase 0 discovery agents), Copilot GPT-5/Codex (adversarial review per user instruction; codex:rescue quota-throttled). Verdict: **ACCEPTED** — 9/10 adversarial checklist items passed; item 7 (in-function authz defense-in-depth) deferred as Phase 4+ project-wide hardening, consistent with existing route-layer-only authz pattern.

**What shipped:** `migrations/0050_audit_log.sql` (table, two-policy RLS, REVOKE UPDATE/DELETE/TRUNCATE, indexes, `tenant_settings.audit_retention_years`), `src/audit.ts` (write helper with redaction + SIEM fan-out), `src/redact.ts` (recursive JSONB, 10+ patterns), `src/service.ts` (`list`, `exportCsv`, `exportJsonl`), `src/routes.ts` (5 admin endpoints), `src/archive-job.ts` (BullMQ stub — S3 Phase 4), `__tests__/audit.test.ts` (12/12), 9 hook sites across 4 modules (`01-auth`, `02-tenancy`, `07-ai-grading`, `13-notifications`).

**Why this was the correct scope:** Load-bearing per CLAUDE.md. P3.D20 designated 9 critical hook sites for G3.A; remaining 19 catalog entries go to G3.D. S3 archive scoped to stub because AWS IAM provisioning is a human-in-the-loop deploy step (CLAUDE.md rule #8). The `archive-job.ts` Phase 4 guard prevents accidental activation of a stub that would silently drop rows without confirming S3 PUT.

**What was NOT included:** `tenant.branding.updated` hook (no branding update fn yet → G3.D); S3 PUT + delete logic (Phase 4 — P3.D11); cryptographic chain (Phase 4 — high-compliance only); per-tenant audit-event schema (Phase 4+). Remaining 19 action catalog entries → G3.D.

**Downstream impact:** `01-auth`, `02-tenancy`, `07-ai-grading`, `13-notifications` each gained `await audit(...)` call sites. `@assessiq/audit-log` is resolved via pnpm workspace hoisting in those modules (no explicit `package.json` dep declaration — verified working in VPS Docker build). If hoisting changes on a pnpm version bump, add explicit dep declarations. See `1264fc6` dep-chain fix + `73ad0b2` RCA entry.

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
exportJsonl({ tenantId, filters }): Promise<Stream>
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
- Cryptographic chain (each row hashes previous) — Phase 4-deferred; meaningful only for very-high compliance bars (WORM bucket + hash chain).
- ~~Real-time SIEM forwarding~~ — **shipped in G3.A** (`43c0e45`). `audit()` fan-out calls `13-notifications.emitWebhook` post-commit (best-effort, non-blocking, dynamic import to avoid circular dep). Opt-in per tenant via `webhook_endpoints.events ⊇ ['audit.*']`. See P3.D16.
