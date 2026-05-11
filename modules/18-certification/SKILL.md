# 18-certification — Tamper-evident course-completion credentials

## Status
**IN PROGRESS** — Phase 5 Session 2 (2026-05-11). Cryptographic + identity
core landed: HMAC-SHA256 signing helper, CSPRNG credential_id generator with
DB-collision retry, idempotent + tier-upgrade-aware `issueCertificate`
service with atomic `auditInTx`. PDF rendering, public verify endpoint,
LinkedIn share, admin revoke still pending (Phase 5 Sessions 3+).

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

## Non-goals (Phase 5 Session 2)

- PDF generation (Session 4)
- Public verify page + OG image (Session 3)
- LinkedIn share endpoint (Session 8)
- Threshold/tier determination logic — issueCertificate consumes a tier
  decided upstream; the pure determine_tier() helper lands in a later
  session when 09-scoring exposes the inputs
- Trigger wiring into 06-attempt-engine (Session 4)
- Admin revoke + reissue surfaces (Session 6/7)
- Migration application against any database (deploy step; CLAUDE.md #8)

## Cryptography and identity (Session 2 + adversarial revision)

### HMAC signing — `src/crypto.ts`

- **Secret env var:** `CERT_SIGNING_SECRET`. No default. No dev fallback.
  `getCertSigningSecret()` reads at call time (not module load) and throws
  when unset or empty. Rotation invalidates every existing signature — plan
  a maintenance window if it ever needs to change.
- **Algorithm:** HMAC-SHA256 over the canonical-JSON encoding of the
  payload. Canonical = keys from the fixed `CANONICAL_FIELDS` constant
  (11 fields, sorted alphabetically), `JSON.stringify` with no whitespace.
  Output is 64-char lowercase hex.
- **Closed canonical field set (R6):** canonicalize iterates the hardcoded
  `CANONICAL_FIELDS` constant — NOT `Object.keys` — so extra properties
  on a spread object (`{ ...certRow, extra_field }`) are silently ignored
  and cannot accidentally broaden the hash. Missing required fields throw
  `CanonicalPayloadError(missingField)`.
- **Signed payload fields** (`CertificateSignaturePayload`): `id`,
  `tenant_id`, `candidate_id`, `attempt_id`, `template_key`,
  `credential_id`, `tier`, `display_name`, `course_title`, `level`,
  `issued_at`. Counters and revocation fields are excluded — they change
  post-issue.
- **Tier in the payload:** present, and a tier upgrade re-signs the row in
  the same transaction. The verify page always recomputes from current row
  state, so shared LinkedIn URLs remain green; what they depend on
  (`credential_id`, `issued_at`) is preserved across upgrades.
- **Verification:** `verifyCertificateSignature` uses
  `crypto.timingSafeEqual` on equal-length Buffers. Length mismatch,
  malformed hex, and missing secret all return `false` rather than throw —
  the caller maps `false` → red badge.

### `issued_at` second-precision invariant (R1)

`issued_at` is truncated to second precision (`'YYYY-MM-DDTHH:MM:SSZ'`,
no dot) **before** both the HMAC computation and the DB INSERT. The DB
projection uses `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` which strips
milliseconds; if the signed payload included `.000Z`, Session 3's verify
endpoint would recompute the HMAC from the projected (ms-stripped) string
and the digest would never match — 100% of certs would fail verification.
Implementation: `new Date().toISOString().slice(0, 19) + 'Z'` in
`service.ts`. Tier upgrades preserve the already-stored `issued_at` from
the row (which was already second-precision at insert time). The R1
round-trip regression pin is in `service.test.ts`.

**Stable URL note (O3):** Two `issueCertificate` calls within the same
wall-clock second will produce the same `issued_at`. They will NOT produce
the same row — the CSPRNG `credential_id` suffix guarantees distinct rows.
The `issued_at` second-precision does not weaken the credential's identity
(that is the globally unique `credential_id`).

### Credential ID generator — `src/credential-id.ts`

- **Format:** `PREFIX-YYYY-MM-XXXXXX` (regex `^[A-Z]{2,4}-\d{4}-\d{2}-[A-Z0-9]{6}$`).
- **Default prefix:** `AIQ` (`DEFAULT_CREDENTIAL_PREFIX`).
- **Date component:** UTC year + UTC month, zero-padded.
- **Suffix alphabet (R4 — Crockford-style):** 6 chars from the 32-character
  set `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, drawn via `crypto.randomInt(0, 32)`.
  Characters **I, L, O, U** are excluded — they are visually ambiguous when
  transcribed from a printed certificate or a LinkedIn URL (I/1, L/1, O/0
  confusion; U excluded for cleanliness). Based on Crockford Base32.
  `Math.random` remains forbidden. The `CREDENTIAL_ID_REGEX` still accepts
  all `[A-Z0-9]` — existing certs with the old 36-char alphabet are valid.
- **Collision policy:** the DB `UNIQUE(credential_id)` constraint is the
  authoritative guard. `service.issueCertificate` regenerates the slug and
  re-signs on `CredentialIdCollisionError`, up to
  `MAX_CREDENTIAL_ID_RETRIES = 3` attempts before throwing.

### Open-transaction precondition (R2)

`issueCertificate` **requires** the caller to pass a `PoolClient` that is
already inside an open transaction (i.e. inside `withTenant()`). It
enforces this at runtime via:
```ts
const txCheck = await client.query("SELECT pg_current_xact_id_if_assigned() AS xid");
if (txCheck.rows[0].xid === null) throw new Error("issueCertificate requires an open transaction …");
```
If the sentinel fires, no repository calls are made. This prevents a future
caller that passes a raw pool connection from producing cert rows without
audit rows (which would be a compliance violation — they are supposed to
commit or roll back atomically). Pinned by `service.test.ts` R2 tests.

### Tier-monotonicity invariant — `src/service.ts`

`issueCertificate` is the single entry point for both first issue and tier
upgrade. Behaviour:

| State on entry | Action | Audit emitted |
|---|---|---|
| no existing row | INSERT new row with fresh `id`, `credential_id`, signed hash | `certification.cert.issue` |
| existing row, incoming tier ≤ existing | return existing row unchanged | none (no-op) |
| existing row, incoming tier > existing | UPDATE tier + re-sign, **preserve `credential_id` and `issued_at`** | `certification.cert.upgrade` |

The cert UPDATE/INSERT and the `auditInTx` write happen on the **same
PoolClient** inside the caller's `withTenant` — if audit fails, the cert
mutation rolls back. Audit `after`-state carries only identity fields
(`credential_id`, `tier`, `candidate_id`, `attempt_id`); snapshot fields
and `signed_hash` are deliberately excluded (size cap + cert row is the
source of truth).

**Tier upgrade TOCTOU guard (R3):** `upgradeCertificateTier` includes
`AND tier = $current_tier` in the UPDATE predicate. If a concurrent caller
has already updated the tier, the UPDATE matches zero rows and throws
`TierUpgradeConflictError`. The service catches this, re-fetches the row,
and retries up to `MAX_TIER_UPGRADE_RETRIES = 3` times. After exhaustion
the error surfaces to the caller. This prevents two concurrent upgrades
from both reading stale `existing.tier` and recording incorrect
before/after audit entries.

### Explicit tenant_id predicates (R5)

`listCertificates` and `findByCredentialId` both include explicit
`WHERE tenant_id = $N` predicates **in addition to** RLS. This is
defense-in-depth: data-migration scripts or ops tooling that connects as
the `assessiq_system` role (which bypasses RLS) will still return only the
correct tenant's rows. The `void tenantId` anti-pattern has been removed.

`findByCredentialIdPublic` is stubbed (throws "not yet implemented") and
reserved for the Phase 5 Session 3 public verify endpoint. It will open
a connection that bypasses RLS and return only public-safe fields (NOT
the internal `id` UUID). The `tenantSlug` question is deferred to Session 3
(see open question O2).

### Counter allowlist (R7)

`incrementCounter` validates the `column` parameter against a runtime
allowlist `['pdf_downloads', 'linkedin_shares', 'verification_views']`
before interpolating it into SQL. TypeScript union types are compile-only;
a dynamic or deserialized caller could bypass them. The allowlist throws
`Error('Invalid counter column …')` on any non-listed value before a query
is issued.

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

## Public surface

```ts
// Issuance (Session 2 — shipped). Caller supplies an RLS-scoped PoolClient
// already inside withTenant(); the cert mutation and audit row commit
// atomically on that transaction. Throws on collision exhaustion.
issueCertificate(
  client: PoolClient,
  input: IssueCertificateInput,
  options?: IssueCertificateOptions,
): Promise<Certificate>

// Read (Session 2 — shipped). RLS applies; public verify uses a separate
// non-RLS path in Session 3.
getByCredentialId(client: PoolClient, credentialId: string): Promise<Certificate | null>

// Cryptography (Session 2 — shipped)
getCertSigningSecret(): string
signCertificate(payload: CertificateSignaturePayload, secret: string): string
verifyCertificateSignature(payload, signature, secret): boolean

// Credential ID (Session 2 — shipped)
generateCredentialId(prefix?: string, now?: Date): string
isValidCredentialId(s: string): boolean

// Stubs — later sessions
listForUser(tenantId, query): Promise<{ items: Certificate[]; total: number }>     // S5
adminListCertificates(tenantId, query): Promise<{ items: Certificate[]; total: number }> // S7
revoke(tenantId, certId, input): Promise<Certificate>                              // S7
reissue(tenantId, certId): Promise<Certificate>                                    // S6
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
