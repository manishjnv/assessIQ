# 20-data-rights — DPDP / GDPR data-subject-rights surface

## Status

**S1 SHIPPED (2026-05-29, `1f737a8`)** — D7 audit + migrations 0101–0104 +
`redact.ts` PII extension + module scaffold.

**S2/S3-lite SHIPPED (2026-05-29)** — admin-mediated **right of access**
(synchronous JSON export) + **right to erasure** (PII tombstone), wired to the
existing admin Users page. **Descoped from the original S2/S3 spec** because
candidates never log in and the candidate PII surface is tiny (name, email,
free-text answers, IP/UA): the BullMQ-worker + S3-signed-URL + magic-link
pipeline was solving a self-service-portal problem this product does not have.
Delivered instead as two small admin-mediated, RLS-confined, synchronous
operations. The candidate-facing `/dsr/:token` page, consent-withdraw, and
retention cron remain deferred (see Session plan).

- `eraseCandidatePii` (`src/erasure.ts`), `exportCandidateData` (`src/export.ts`)
- Routes `GET /api/admin/users/:userId/data-export`, `POST /api/admin/users/:userId/erase`
  (`apps/api/src/routes/admin-users.ts`)
- Admin UI: per-row "Download data" + "Erase personal data" on candidate rows
  (`modules/10-admin-dashboard/src/pages/users.tsx`); help seed
  `16-help-system/migrations/0105`
- Audit actions `user.data.exported`, `user.pii.erased`
- **Auth-gate decision:** erase is gated tenant `admin`, NOT super_admin as the
  route plan below originally drafted. Rationale: under DPDP the tenant is the
  data fiduciary for its own candidates and RLS confines the blast radius to the
  caller's tenant. Adversarial review (Opus takeover; codex quota-blocked)
  verdict = ACCEPT.

Decision pins below are the v2 set, written at S1 start per the
[consolidated skill plan](../../assessiq-skill-plan.md) §11.1.

**Prior gate cleared:** the
[grading-completion-fix-plan](../../docs/design/grading-completion-fix-plan.md)
shipped on 2026-05-28 (`defb9f9`) with the navigate-away robustness follow-on
on 2026-05-29 (`96b71a6`). Both LIVE.

## Purpose

Own every data-subject right the platform must honor for **candidates**, whose
PII surface is intentionally narrow: `users.name`, `users.email`,
`attempt_answers.answer` (free-text JSONB), and `sessions.ip` + user-agent.
Candidates do **not** log in to AssessIQ — they authenticate only via
single-purpose magic links. This module therefore has no "candidate
portal"; the candidate-facing surface is a token-authenticated DSR page
(`/dsr/:token`) reached via a footer link in every notification email.

Rights covered:

- **Right to access** — admin or magic-link-token candidate triggers an
  export bundle (ZIP) emailed back.
- **Right to erasure** — admin-mediated or magic-link-triggered PII
  tombstoning. Tombstone, never DELETE — `14-audit-log` is append-only and
  `18-certification` HMAC payload includes the name snapshot (D1).
- **Right to rectification** — admin-mediated only (no candidate login).
- **Right to portability** — covered by the export bundle (D2).
- **Right to withdraw consent** — magic-link DSR page; withdrawing
  `data_processing` triggers erasure.
- **Per-tenant retention policy** — cron purges expired data per
  `tenant_settings.retention_days` (D4).

Out of scope (defer):

- DSR for non-candidate roles (admin, reviewer, super_admin) — those users
  sign employment-style agreements separately; low volume; manual.
- Candidate-facing profile management UI — there is no candidate login;
  rectification is admin-mediated.
- Right-to-explanation for AI grading — Phase 2; needs `07-ai-grading`
  justification surfacing.
- Cookie consent UI for `assessiq.in` marketing pages — separate workstream.
- Cross-border SES region migration — defer to `31-white-label-config`
  (memory: it cannot ship in isolation).

## Dependencies

| Module | Why |
|---|---|
| `00-core` | `config`, `ValidationError`, `streamLogger`, `RequestContext` |
| `02-tenancy` | `withTenant` for RLS; owns `tenant_settings` (S1 adds `retention_days`) |
| `03-users` | `users` table (S1 adds `erased_at`); primary tombstone target |
| `06-attempt-engine` | `attempt_answers.answer` free-text JSONB (erasure target; question-type filter excludes `mcq`) |
| `01-auth` | `sessions.ip` / `sessions.user_agent` — candidate IP/UA (erasure target; candidates get a session row via `mintCandidateSession`) |
| `14-audit-log` | `auditInTx()` for every DSR action; **immutability is a hard constraint** (D1, D7); S1 extends `redact.ts` |
| `13-notifications` | Email export-ready, erasure-confirmation, consent receipts (S2+) |
| `18-certification` | Snapshot HMAC payload includes `name` — erasure must not touch it (D1, see [18-certification SKILL.md D4](../18-certification/SKILL.md#d4--signed_hash-payload-spans-11-identity-fields)) |
| `16-help-system` | Help IDs for the magic-link DSR page + admin DSR queue (S3+) |

## Architecture decisions (v2 — pinned at S1 start, 2026-05-29)

### D1 — Erasure is PII tombstoning, never row deletion

Three load-bearing invariants forbid DELETE:

1. `14-audit-log` REVOKE'd UPDATE/DELETE/TRUNCATE from `assessiq_app`. Audit
   rows reference `actor_user_id` UUID; deleting a user row orphans the FK.
2. `18-certification` HMAC payload includes the `name` snapshot (D4 of 18).
   Mutating the snapshot breaks the signature on every cert that candidate
   earned; recruiters relying on `/verify/:credentialId` would see "tampered."
3. `06-attempt-engine` `attempts` rows are the graded artifact and the
   billing-event trigger source (memory `billing-events-grade-commit-critical-path`).

**Tombstone scheme** (live tables; audit_log untouched by erasure):

**Schema corrected 2026-05-29 (verified against migrations at implementation).**
The original table below named `attempt_responses` and `attempt_events.ip` —
neither exists. Real surface: answers live in `attempt_answers.answer` (JSONB);
candidate IP/UA live in `sessions` (candidates DO get a row via
`mintCandidateSession`); `attempt_events` has only `payload JSONB` + `at`, no
IP/UA columns.

| Table | Column | Tombstone value |
|---|---|---|
| `users` | `name` | `'deleted_user_' \|\| substr(encode(sha256(id::text::bytea),'hex'),1,12)` |
| `users` | `email` | `'deleted+' \|\| <same hash> \|\| '@erased.assessiq.local'` |
| `users` | `erased_at` | `now()` (new column, migration 0102) |
| `attempt_answers` | `answer` (JSONB) | `'"[erased]"'::jsonb` for every answer NOT positively confirmed `mcq` (question type resolved via correlated subquery; an RLS-invisible/missing question defaults to free-text so its PII is still erased — closes a right-to-erasure gap caught in review) |
| `sessions` | `ip` | NULL (for the candidate's session rows) |
| `sessions` | `user_agent` | NULL |
| `certificates` | (none) | snapshot stays verbatim per D5 of 18-certification (keyed on `candidate_id`, `ON DELETE SET NULL` — tombstoning the user, not deleting, leaves it intact) |

**`users.deleted_at` vs `users.erased_at` (distinct purposes):**
`deleted_at` is admin soft-delete (row exists but hidden — used for "removed
by admin"). `erased_at` is DPDP erasure executed (PII columns are tombstones;
gradings remain intact for billing immutability). They can overlap; neither
implies the other. Existing `deleted_at` callers do not need to change.

### D2 — Export format: ZIP bundle, signed S3 URL, 24h TTL

```
export-<credential>.zip
├── manifest.json          — { schema_version: 1, generated_at, user_id, files: [...] }
├── profile.json           — users row (name, email, role, created_at) — no internal IDs
├── attempts.json          — array of attempts (id, status, scores, timestamps)
├── responses.json         — array of answer_text per question (candidate's own answers)
├── certificates.json      — credential_id, tier, course_title, issued_at
├── certificates/*.pdf     — one PDF per issued cert (rendered live by 18-certification)
├── audit-events.json      — audit_log rows where entity_type='user' AND entity_id=me (filtered)
└── consents.json          — consent_events ledger entries for me
```

**Schema versioning:** `manifest.json.schema_version` starts at `1`. Any
breaking change bumps it.

**`audit-events.json` scope:** rows where the candidate is the
**entity**, not the actor (candidates take no admin actions). Fields
filtered to non-PII subset before write: `(action, entity_type, at, before, after)`
with `actor_user_id` and `ip` redacted (only the admin acting on the
candidate sees those in the admin DSR view).

### D3 — Async generation; magic-link DSR page or admin-initiated

Two trigger paths, one worker, identical output:

1. **Candidate-initiated** — candidate opens any notification email
   (invitation, results, certificate), clicks the "Manage your data"
   footer link → lands on `/dsr/:token` → clicks Export → enqueues
   `dsr.export.requested` BullMQ job → email with second magic link to
   download.
2. **Admin-initiated** — admin opens `/admin/users/:id` → clicks Export →
   same job, email goes to the candidate's on-file (un-erased) email.

**Workflow:**

1. Worker generates ZIP, uploads to `s3://assessiq-dsr-exports/<tenant>/<sha>/export.zip`.
2. Computes signed URL with **24-hour TTL**.
3. `13-notifications` sends email with the link.
4. After 24h the signed URL expires; a retention cron purges the S3 object
   after 7 days regardless of download.

**Why BullMQ (not the AI runtime):** per CLAUDE.md hard rule #1, BullMQ is
allowed for non-AI background work. Export is non-AI (S3 + ZIP + email).

### D4 — Retention policy: per-tenant column, defaults align with audit

Migration 0103 adds `tenant_settings.retention_days INT NOT NULL DEFAULT 730`
(2 years HR-grade). The audit-log retention default (7 years) is unchanged —
they are intentionally distinct: PII gets tombstoned at 2y, audit
forensic-chain stays for 7y.

Cron runs nightly per tenant (S5 — not in S1):

- Liveness proxy: `MAX(attempts.submitted_at)` per candidate (no
  `users.last_active_at` column exists today; deferring its introduction
  to S5 if the proxy proves insufficient).
- Excludes candidates with active attempts or un-revoked certs issued in
  the retention window.
- Runs the same erasure flow as a candidate-initiated request.
- Emits `system.dsr.retention.erased` audit event.

### D5 — Certificate-snapshot conflict resolution

Erasure leaves `certificates.name` (snapshot) **verbatim**:

- HMAC payload includes `name`; mutating breaks the signature on every cert.
- Public `/verify/:credentialId` still resolves for recruiters — that is
  18-certification's contract, not this module's.
- The candidate already published the name on LinkedIn / printed PDF;
  there's no privacy benefit to erasing one local copy.

After erasure, the candidate's `users` row is tombstoned, so the admin/UI
no longer surfaces the cert under that candidate. The public verify URL
continues to work.

**O1 (open):** explicit "revoke + erase" combined action that kills the cert
AND tombstones the snapshot — for severe cases (revealed identity in
witness-protection scenario, etc.). Deferred to S3 review.

### D6 — Consent ledger: append-only, magic-link withdraw

Migration 0101 creates `consent_events`:

```sql
CREATE TABLE consent_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  purpose       TEXT NOT NULL,           -- 'data_processing' | 'marketing' | 'benchmarking'
  policy_version TEXT NOT NULL,          -- 'dpdp-v1-2026-05-01' etc.
  granted_at    TIMESTAMPTZ,             -- NULL iff withdrawn-without-grant
  withdrawn_at  TIMESTAMPTZ,             -- NULL iff still active
  ip            INET,
  user_agent    TEXT,
  lawful_basis  TEXT NOT NULL,           -- 'consent' | 'legitimate_interest' | 'contract'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Same two-policy RLS template as `audit_log` (tenant_isolation SELECT +
tenant_isolation_insert). Same REVOKE UPDATE/DELETE/TRUNCATE from
`assessiq_app` (append-only).

**Capture point:** at the magic-link invitation-accept page before
attempt-start — the only candidate-facing surface that runs before grading
begins (wired in S6).

**No S1 seed backfill — verified 2026-05-29.** There is no per-user
`privacy_disclosed` column to backfill. The existing
`tenants.privacy_disclosed` (added by `12-embed-sdk` migration 0071) is a
tenant-level embed-SDK gate, not per-candidate consent. New
`consent_events` rows are written prospectively from S6 onward; historical
gradings remain on the existing legitimate-interest basis until S6 wires
the invitation-accept consent capture. This is acceptable because no
paying tenants are live (memory: `project-under-development-no-real-data`).

**Withdrawal:** insert a new row with `withdrawn_at` set, `granted_at`
NULL. The full ledger reconstructs from chronological ordering. Never
UPDATE / DELETE — same append-only posture as `audit_log`.

### D7 — Audit `before`/`after` JSONB must not embed raw PII

**Confirmed at S1 (partial):** `modules/14-audit-log/src/redact.ts`
patterns catch CREDENTIALS only (passwords, secrets, tokens, API keys,
TOTP secrets, recovery codes, `*_hash`, session cookies, SMTP passwords).
**Zero patterns for `email`, `name`, `display_name`, `phone`,
`answer_text`.** Historical audit rows therefore almost certainly contain
raw PII in `before`/`after` JSONB.

S1 actions:

1. **Forward protection (always):** extend `SENSITIVE_FIELD_PATTERNS` with
   PII patterns (`/^email$/i`, `/^name$/i`, `/^display_?name$/i`,
   `/^phone$/i`, `/^answer_?text$/i`, `/^ip$/i` when inside JSONB). All
   future `audit()` + `auditInTx()` writes are redacted before INSERT.
2. **Historical backfill (conditional, codex:rescue gated):** if the
   Haiku D7 audit confirms HIGH-severity PII leaks in shipped call sites,
   author migration `0104_audit_log_pii_redact_backfill.sql` running as
   `assessiq_system` (the documented append-only exception path per
   `14-audit-log/migrations/0050_audit_log.sql` § IRREVERSIBILITY NOTE).
   The migration uses `pg_catalog.regexp_replace`-style JSONB walk to
   redact known PII keys in-place across all historical rows. This is
   the **only** exception to append-only this module ever introduces;
   it ships once.

### D8 — Right-to-rectification is admin-mediated; no historical rewrites

Admin updates `users.name` / `users.email` on candidate's written request;
emits `user.profile.updated` audit event with both states. Historical
attempts and certs **are not mutated** — the snapshot pattern means each
artifact carries the name as-it-was-then (legally correct posture).

### D9 — Cross-border transfer constraint deferred until 31-white-label

The consolidated plan (§6.3 D5 of 31) flags DPDP cross-border rules around
US-region SES for Indian tenant emails. This module rides on
`13-notifications` and inherits whatever region constraint that module
enforces. **20-data-rights does not unilaterally migrate SES regions.**

## Migrations (S1)

```
modules/20-data-rights/migrations/
  0101_consent_events.sql          — table + RLS + REVOKE + privacy_disclosed seed backfill
  0102_users_erased_at.sql         — users.erased_at TIMESTAMPTZ NULL + partial index
  0103_tenant_retention_days.sql   — tenant_settings.retention_days INT NOT NULL DEFAULT 730
  0104_audit_log_pii_redact_backfill.sql  — CONDITIONAL on Haiku D7 verdict; codex:rescue gated
```

Migration numbers verified against the cross-module sequence at S1 start
(latest = `0100_attempts_ai_proposals_cache.sql` in `07-ai-grading`,
2026-05-29). Migration numbering is cross-module and non-sequential per
memory observation 2026-05-11 §1238.

Also S1: `modules/14-audit-log/src/redact.ts` extended with PII patterns
(forward protection — separate change, same PR).

## Public surface (planned S2+)

```ts
// S2 — export service
enqueueDataExport(tenantId, userId, initiator): Promise<{ jobId, expectedReadyAt }>
getExportJob(tenantId, jobId): Promise<ExportJobStatus>

// S3 — erasure service
eraseCandidatePii(tenantId, userId, reason): Promise<ErasureReceipt>

// S3 — DSR token issuance + verification (HMAC)
issueDsrToken(tenantId, userId, purpose: 'manage'): string  // 7d TTL
verifyDsrToken(token): { tenantId, userId, purpose, expiresAt } | null

// S4 — admin queue
listDsrRequests(tenantId, filters): Promise<{ items, total }>
approveDsr(tenantId, requestId, adminId): Promise<void>
rejectDsr(tenantId, requestId, adminId, reason): Promise<void>

// S5 — retention cron
runRetentionPurgeForTenant(tenantId, dryRun?: boolean): Promise<RetentionReport>

// S6 — consent ledger
recordConsent(tenantId, userId, purpose, lawfulBasis, ctx): Promise<void>
withdrawConsent(tenantId, userId, purpose, ctx): Promise<void>
listConsents(tenantId, userId): Promise<ConsentEvent[]>
```

## Routes (planned S2+)

```
# Candidate-facing (magic-link token, no session)
GET  /dsr/:token                          → DSR page (server-rendered)
POST /dsr/:token/export                   → enqueue export (S2)
POST /dsr/:token/erase                    → request erasure (S3)
POST /dsr/:token/consents/:purpose/withdraw → withdraw consent (S6)

# Admin-facing
GET  /api/admin/dsr-requests              → queue (S4)
POST /api/admin/dsr-requests/:id/approve  → admin approves (S4)
POST /api/admin/dsr-requests/:id/reject   → admin rejects with reason (S4)
GET  /api/admin/users/:id/data-export     → admin-initiated export (S2)
POST /api/admin/users/:id/erase           → super_admin-only direct erasure (S3)
```

## Help IDs (planned S3+)

- `dsr.token_page.export_button` — "Download a copy of your data"
- `dsr.token_page.erasure_warning` — explains certificate retention (D5)
- `dsr.token_page.withdraw_warning` — explains erasure trigger (D6)
- `dsr.token_page.expired_link` — expired-token landing
- `admin.dsr.queue` — DSR triage queue help
- `admin.dsr.approve_verify_identity` — identity-verification flow
- `admin.user.erase_super_admin_only` — super_admin gate explanation

## Session plan

| S | Scope | Adversarial gate |
|---|---|---|
| **1 (this session)** | D7 audit (HIGH at `candidate-login.ts:246`, MED in `invitations.ts`); migrations 0101–0103 + 0104 (HIGH-severity backfill confirmed required); `redact.ts` PII extension; module scaffold (`package.json`, `tsconfig.json`, `src/types.ts`, `src/index.ts`) | `codex:rescue` mandatory on 0104 (audit immutability exception); standard Opus diff review on 0101–0103 + redact.ts |
| 2 | Export service + BullMQ worker + S3 signed-URL + ZIP generator + email wiring | `codex:rescue` (touches `13-notifications` + S3 IAM) |
| 3 | Magic-link DSR page (`/dsr/:token`) + HMAC token issuance/verification (constant-time); erasure service | `codex:rescue` (token crypto + erasure across 3 load-bearing modules) |
| 4 | Admin DSR queue UI + identity verification + super_admin-only erase route | Standard Opus diff review |
| 5 | Retention cron + per-tenant `retention_days` admin UI + consent-ledger read surface on `/dsr/:token` | Standard Opus diff review |

S2-S5 land in subsequent sessions. **No work past S1 happens in this session.**

## Open questions

1. **D5 O1** — combined "revoke + erase" cert action for severe cases.
   Resolve in S3 with first enterprise customer's compliance counsel.
2. **DSR token transport** — query string vs URL fragment vs path
   parameter. Lean: path parameter (`/dsr/:token`) for simplicity; signed
   HMAC means tokens are non-guessable. Confirm in S3.
3. **Admin-initiated DSR verification** — does admin attestation suffice or
   does the candidate's on-file email also need to confirm? Lean: candidate
   email confirmation required unless candidate is provably
   deceased/incapacitated. Pin in S4.
4. **`sessions.ip` retention** — strictly speaking not PII alone but
   coupled with `user_id` becomes identifying. Lean: redact on erasure to
   stay safe. Pinned in D1 already; implemented in `erasure.ts` (NULLed on
   erasure).
5. **S3 bucket region** — Mumbai (`ap-south-1`) for Indian candidates;
   coupled to D9 / 31-white-label. Defer to S2 deploy planning.

## Why this SKILL.md exists before code

Per CLAUDE.md project rules and consolidated plan §11.1 (Tier A modules
write SKILL.md at first build session start, not in a planning sprint):

- Touches three load-bearing modules (`02-tenancy`, `14-audit-log`,
  `18-certification`) where a wrong erasure model is a permanent
  compliance incident.
- Cert-snapshot vs erasure (D5) has exactly one correct answer and is
  non-obvious until you walk the HMAC payload.
- Audit-immutability (D1, D7) is a Phase 3 bounce condition invisible from
  the candidate-facing UX — pinning prevents an S2 implementation that
  treats erasure as DELETE.
- The 0104 backfill (if needed) is the only append-only exception this
  module ever introduces; pinning the path here prevents an S3 author from
  re-litigating it.
