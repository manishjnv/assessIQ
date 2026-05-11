# 18-certification — Tamper-evident course-completion credentials

## Status
**SCAFFOLDED** — Phase 5 Session 1 (2026-05-11). Schema + types + stubs shipped.
Business logic (issuance engine, HMAC signing, PDF, verify page) starts Session 2.

## Purpose
Issue, verify, and manage tamper-evident certificates when a candidate passes
an assessment at or above the completion threshold. Each certificate is:

- A **snapshotted** row (display_name, course_title, level frozen at issuance)
- **Idempotent** (UNIQUE(tenant_id, candidate_id, attempt_id) — one cert per attempt)
- **Tamper-evident** via HMAC-SHA256 over (credential_id | candidate_id | issued_at)
- **Tier-upgradeable only** (completion → distinction → honors; never downgrade)
- **Publicly verifiable** via /verify/:credentialId (Phase 5 Session 3)
- **Admin-revocable** with a reason (soft revoke; cert still visible, red badge)

Full implementation plan: `docs/CERTIFICATION_PLAN_GENERIC.md`.

## Dependencies

| Module | What we consume |
|---|---|
| `00-core` | `config`, `ValidationError`, `streamLogger` |
| `02-tenancy` | `withTenant` — all DB calls run through this for RLS |
| `03-users` | `users` table — `candidate_id` FK; `display_name` snapshotted at issuance |
| `05-assessment-lifecycle` | `assessments` table — `course_title` snapshotted at issuance |
| `06-attempt-engine` | `attempts` table — `attempt_id` FK; completion state gating |
| `14-audit-log` | `audit()` — admin revoke + reissue actions are auditable |
| `13-notifications` | Email-on-issue (Phase 5 Session 2+; not wired in Session 1) |
| `16-help-system` | Help IDs for cert UI surfaces (Phase 5 Session 5) |

## Non-goals (Phase 5 Session 1)

- PDF generation (Session 3)
- Public verify page + OG image (Session 3)
- LinkedIn share endpoint (Session 8)
- HMAC signing logic (Session 2)
- Threshold/tier determination logic (Session 2)
- Trigger wiring into 06-attempt-engine (Session 2)
- Migration application against any database (deploy step; CLAUDE.md #8)

## Architecture decisions

### D1 — `attempt_id` replaces `enrollment_id` (plan §1.1)
The generic plan uses `enrollment_id` pointing at a hypothetical `user_plans`
or `enrollments` table. AssessIQ has no such table. The concrete completed
entity is `attempts` (module 06). An attempt records the full lifecycle:
`draft → in_progress → submitted → pending_admin_grading → graded → released`.

`attempt_id` gives per-attempt idempotence (one cert per graded attempt) and
is already tenant-scoped via the `assessments` FK. The UNIQUE constraint is:
`UNIQUE(tenant_id, candidate_id, attempt_id)`.

**Rejected alternative:** `assessment_cycle_id` pointing at `assessments`.
Rejected because a candidate could have multiple attempts in the same
assessment cycle; `attempt_id` is the right granularity for
"what did this candidate actually complete."

### D2 — `candidate_id` replaces `user_id` (plan §1.1)
AssessIQ 03-users module uses `candidate_id` in context to distinguish from
`admin_id` and `reviewer_id`. The FK points to `users(id)` with `ON DELETE SET NULL`
so a historical cert record survives GDPR account deletion (snapshotted
`display_name` preserves the printed name on issued PDFs).

### D3 — `credential_id` is globally unique, not tenant-scoped
Recruiters look up a credential without knowing which tenant issued it
(e.g. by typing the ID from a printed PDF). The UNIQUE constraint is on
`credential_id` alone, not `(tenant_id, credential_id)`. Generation:
6-char CSPRNG suffix from `[A-Z0-9]`, retry on IntegrityError, max 3 attempts.
Prefix defaults to `AIQ`; make it configurable per tenant in Phase 5 Session 6.

### D4 — `signed_hash` payload excludes mutable fields
HMAC-SHA256 over `credential_id | candidate_id | issued_at` only. Excludes
`tier`, `display_name`, counters. Rationale: tier upgrades and admin reissues
must not invalidate HMAC — the signature attests "this credential exists for
this user at this time", not the current display state. See plan §3.

### D5 — No HMAC `==` comparison
The verify endpoint must use `timingSafeEqual` (Node.js `crypto`) or equivalent
constant-time comparator. Never plain `===`. See plan §15 trap #1.

### D6 — `issued_at` microseconds stripped
When re-signing during a tier upgrade, `issued_at` must be truncated to
second precision before encoding into the HMAC payload. PostgreSQL
`TIMESTAMPTZ` preserves microseconds; a nanosecond difference between the
persisted timestamp and the re-signing call produces a different digest.
Store as ISO 8601 with seconds only: `new Date(issued_at).toISOString().slice(0, 19) + 'Z'`.
See plan §15 trap #2.

### D7 — Verify page public lookup bypasses tenant RLS
`GET /verify/:credentialId` is public (no auth, no tenant context). The
repository `findByCredentialId` must not rely on `app.current_tenant` GUC.
Implementation options (Phase 5 Session 3): (a) SECURITY DEFINER function,
(b) query with `assessiq_system` role, (c) explicit `SET LOCAL` bypass.
Do NOT add a permissive "all tenants can SELECT" RLS policy — that leaks all
certs to any tenant session. Decision for Session 3.

### D8 — Counter increments are server-side arithmetic
`UPDATE certificates SET pdf_downloads = pdf_downloads + 1 WHERE id = $1`
prevents read-modify-write race conditions. Non-critical: a lost increment is
acceptable (analytics, not business logic). Do NOT read-then-write counters.

## Migration
`modules/18-certification/migrations/0046_certification_init.sql`

Applies after: `0001_tenants.sql` (02-tenancy), `020_users.sql` (03-users),
`0030_attempts.sql` (06-attempt-engine).

**Do NOT apply in Session 1.** Migration application is a deploy step
scheduled for Phase 5 Session 2 (CLAUDE.md rule #8).

## Public surface (Session 1 stubs)
```ts
// Issuance (Session 2)
issueCertificate(input: IssueCertificateInput): Promise<Certificate | null>

// Read (Session 3+)
getByCredentialId(credentialId: string): Promise<Certificate | null>
listForUser(tenantId: string, query: ListCertificatesQuery): Promise<{ items: Certificate[]; total: number }>

// Admin (Session 2)
adminListCertificates(tenantId: string, query: ListCertificatesQuery): Promise<{ items: Certificate[]; total: number }>
revoke(tenantId: string, certId: string, input: RevokeCertificateInput): Promise<Certificate>

// Admin (Session 6)
reissue(tenantId: string, certId: string): Promise<Certificate>
```

## Routes (all 501 in Session 1)
```
GET  /api/certificates                          → list my certs (Session 5)
GET  /api/certificates/:credentialId/pdf        → download PDF (Session 3)
POST /api/certificates/:credentialId/share-linkedin → increment counter (Session 8)
GET  /api/admin/certificates                    → admin list (Session 2)
POST /api/admin/certificates/:id/revoke         → revoke (Session 2)
POST /api/admin/certificates/:id/reissue        → re-snapshot (Session 6)
```

## Env vars
| Var | Purpose | Required |
|---|---|---|
| `CERT_HMAC_SECRET` | HMAC signing secret | Yes in prod; dev derives from `JWT_SECRET` |
| `PUBLIC_BASE_URL` | Absolute URL for verify links + QR codes | Yes |
| `JWT_SECRET` | Dev-fallback HMAC derivation base | Yes (already exists) |

## Tests
`modules/18-certification/src/__tests__/types.test.ts` — TIER_ORDER monotonicity
+ CREDENTIAL_ID_REGEX + Zod schema validators. All pass in Session 1.

Full integration test suite (issuance + upgrade + revoke + verify) ships in Session 2.

## Help IDs (Phase 5 Session 5)
- `candidate.certificates.download`
- `candidate.certificates.linkedin_share`
- `candidate.certificates.verify_link`
- `admin.certificates.revoke`
- `admin.certificates.reissue`

## Open questions
1. **Credential ID prefix per tenant** — should `AIQ` be configurable as a
   tenant setting (e.g. `WIPRO` for the Wipro SOC pack)? Or always `AIQ` as
   the platform issuer? Decision deferred to Session 6 when admin reissue ships.

2. **Verify page public lookup DB strategy** — SECURITY DEFINER function vs
   `assessiq_system` role vs explicit `SET LOCAL` bypass? All three work;
   SECURITY DEFINER is the most portable. Decide in Session 3 when the verify
   endpoint is implemented.
