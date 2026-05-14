# Credentialing — tamper-evident certificates

> Public-facing reference for the credentialing model. Module-internal
> details live in `modules/18-certification/SKILL.md`. The full Phase 5
> blueprint is in `docs/CERTIFICATION_PLAN_GENERIC.md`.

## What ships in Phase 5

A `Certificate` row is issued when an admin confirms a graded attempt has
crossed a tier threshold. The row carries a point-in-time snapshot of the
candidate's display name, course title, and level; later profile edits do
NOT retro-update issued certs (that is intentional — a credential is a
point-in-time record).

The public face of a certificate is its **credential_id**, a slug of the
form `PREFIX-YYYY-MM-XXXXXX`:

| Segment | Source | Notes |
|---|---|---|
| `PREFIX` | issuer code (default `AIQ`) | 2–4 uppercase letters |
| `YYYY-MM` | issuance month (UTC) | for eyeballable age, not crypto |
| `XXXXXX` | 6 chars from `[0-9ABCDEFGHJKMNPQRSTVWXYZ]` | CSPRNG (`crypto.randomInt`), retry on DB UNIQUE conflict |

The suffix alphabet is a **Crockford-style 32-character set** that
deliberately excludes I, L, O, and U — characters that are visually
ambiguous when reading a credential_id off a printed certificate, LinkedIn
profile, or business card (I looks like 1, L looks like 1, O looks like 0).
This means you will never see a credential_id that could be misread. The
CREDENTIAL_ID_REGEX still accepts all `[A-Z0-9]` characters so any certs
issued before this change (none in production at the time of this update)
remain valid.

Slugs are stored uppercase. The verify-page lookup normalises input to
upper, so recruiters typing them lowercase still resolve correctly.

## HMAC signing

Each cert row stores a `signed_hash`: the HMAC-SHA256 hex digest of a
canonical-JSON serialization of the row's identity + display-snapshot
fields, keyed by `process.env.CERT_SIGNING_SECRET`. The canonical
serialization sorts keys alphabetically and emits `JSON.stringify` with no
whitespace, so the digest is byte-identical across Node processes and
versions.

Signature compare in the verify path uses `crypto.timingSafeEqual` on
equal-length `Buffer`s. Length mismatch returns `false` rather than throws.

**Stability invariant.** A tier upgrade (e.g. completion → distinction)
re-signs the row in the same DB transaction as the tier UPDATE. The
**`credential_id` and `issued_at` are preserved** — never rotated — so
shared LinkedIn URLs continue to verify against the current row state.
Counters (`pdf_downloads`, `linkedin_shares`, `verification_views`) and
revocation fields are deliberately excluded from the signed payload so
counter bumps and revocations do not require re-signing.

**`issued_at` second-precision invariant.** The `issued_at` timestamp is
truncated to second precision (`2026-05-11T17:46:23Z`, no milliseconds)
before signing and before storage. The public verify page reconstructs the
HMAC payload from the stored row; the DB projection also strips
milliseconds. Both sides must agree on the format for the signature to
verify. Sub-second precision is irrelevant for a certificate issued to a
human.

## Secret management

- `CERT_SIGNING_SECRET` is required. There is no default and no dev
  fallback — `getCertSigningSecret()` throws at first call if unset.
- **Rotation invalidates every existing signature.** If rotation is ever
  needed, the procedure is: add a `signed_hash_v2` column, run a one-shot
  resigner under the new secret, update `verifyCertificateSignature` to
  accept either column during the cutover window, then drop v1.
- The secret lives in the production VPS environment file; the ops
  procedure for setting it is in `docs/06-deployment.md`. Treat it with
  the same operational care as `SESSION_SECRET` and
  `ASSESSIQ_MASTER_KEY`.

## Audit trail

Two audit-log actions are recorded:

- `certification.cert.issue` — first-time issue. `after`-state carries
  `{credential_id, tier, candidate_id, attempt_id}` only.
- `certification.cert.upgrade` — tier upgrade. `before` carries the prior
  tier; `after` carries the same identity fields.

Both writes occur in the same transaction as the cert INSERT/UPDATE via
`auditInTx`. An audit failure rolls back the cert mutation; there is never
a cert row without a corresponding audit entry, and vice versa.

## Share previews (Open Graph)

When a candidate shares their verify URL on LinkedIn, Twitter, or another
crawler-driven platform, the receiving site fetches the URL to build a link
preview. The verify page renders Open Graph + Twitter Card meta tags in its
`<head>` so these previews come up as **rich cards** (1200×630 image, name,
course title, tier) rather than plain title-only links.

Two image endpoints back the previews:

- `GET /verify/:credentialId/og.svg` — vector SVG; used by Twitter, Facebook,
  Mastodon, Slack, and most general-purpose crawlers.
- `GET /verify/:credentialId/og.png` — rasterized PNG (1200×630); used by
  LinkedIn, which rejects SVG previews. Rendered server-side at request time
  via `@resvg/resvg-js` (pure-Rust, no headless browser), cached for one hour.

Both endpoints respect the cert's current status. A revoked certificate
renders a red "REVOKED" badge in the preview image; a tampered signature
renders "INVALID". Recruiters scrolling LinkedIn see the status before they
even click through.

`og:image` in the HTML head always points at the PNG endpoint, since
LinkedIn is the dominant share target for credentialing. Absolute URLs are
built from the `PUBLIC_BASE_URL` env var; if unset (test environments) the
meta tags are silently omitted rather than crashing the page render.

## Automatic issuance trigger (Phase 5 Session 8)

Certificates are issued automatically when an admin releases a graded attempt
(`POST /admin/attempts/:id/release`). The trigger runs inside the same
`withTenant()` transaction as the `graded→released` status update and the
`grading.released` audit row — so the cert row and the release are atomic.

### Entry point

`issueCertificateOnRelease(client, { tenantId, attemptId, actorUserId })`
in `modules/18-certification/src/service.ts`. Called by
`handleAdminReleaseAttempt` in `modules/07-ai-grading/src/handlers/admin-claim-release.ts`.

### Tier thresholds (AssessIQ-specific)

| `auto_pct` from `attempt_scores` | Tier issued |
|---|---|
| `< 90` | No cert — `null` returned |
| `≥ 90` and `< 100` | `completion` |
| `= 100` | `distinction` |
| `NaN` / `Infinity` | No cert — guarded by `isFinite()` check |
| `NULL` (scores not yet computed) | No cert — `null` returned |

`auto_pct` is stored as `NUMERIC(5,2)` — node-postgres returns it as a string;
`parseFloat()` is used, followed by an `isFinite()` guard.

`honors` tier is deferred; there is no threshold wired for it yet.

### Never-raise invariant

Cert failure **must not block the release**. The call site wraps the dynamic
import and the function call in `.catch((err) => log.warn(…))`. A cert failure
logs `grading.release.cert_issuance_failed` and continues; the release HTTP
response still returns `{ attempt: { status: "released" } }`.

Manual re-issue is available via the admin certificates page.

### Why dynamic import

Module `07-ai-grading` does not have a static dependency on
`@assessiq/certification`. The import uses the `new Function('specifier', 'return
import(specifier)')` pattern — the same indirection used for module 13
notifications — so the grading module compiles and works in test environments
where the certification package is absent or stripped.

### Transaction placement

The cert call is placed **inside** `withTenant()`, after `auditInTx`. This
satisfies `issueCertificate`'s R2 open-transaction precondition
(`pg_current_xact_id_if_assigned()` sentinel). If the cert INSERT fails and
throws despite the outer `.catch()`, the `withTenant()` transaction rolls back,
taking the `graded→released` UPDATE and the audit row with it. The release must
be retried.

## What's not in this doc

- PDF generation and the `/api/certificates/:credentialId/pdf` endpoint —
  Phase 5 Session 4.
- The public `/verify/:credentialId` page and its non-RLS DB lookup
  strategy — Phase 5 Session 3.
- LinkedIn share counter — Phase 5 Session 6.
- OG / LinkedIn PNG preview — Phase 5 Session 7.

## Admin surface

The admin certificate management surface is the fallback for edge cases where
the automatic `issueCertificateOnRelease` trigger fails (e.g., `CERT_SIGNING_SECRET`
unset at release time) and for legitimate name corrections.

### Endpoints

```
GET  /api/admin/certificates
POST /api/admin/certificates/:credentialId/revoke
POST /api/admin/certificates/:credentialId/reissue
```

**`GET /api/admin/certificates`** — paginated list of all cert rows in the
current tenant. Filterable by `tier` (`completion | distinction | honors`) and
`status` (`active | revoked`). Response is cursor-paginated; standard
`?page=` + `?limit=` params. Requires tenant-admin role.

**`POST /api/admin/certificates/:credentialId/revoke`** — revokes a cert.

Request body:

```json
{ "revoke_reason": "string, min 10 chars" }
```

Sets `revoked_at` (current timestamp) and `revoke_reason` on the `certificates`
row. Emits a `certificates.revoked` audit row via `auditInTx`. Returns 409 if
already revoked. Requires tenant-admin role.

**`POST /api/admin/certificates/:credentialId/reissue`** — corrects the
display name on a cert without changing its identity.

Request body:

```json
{ "display_name": "string (optional)" }
```

Updates `display_name` and re-signs `signed_hash` in the same transaction.
Emits a `certificates.reissued` audit row via `auditInTx`. Returns 410 if the
cert is revoked — a revoked cert cannot be reissued; issue a new cert instead.
Requires tenant-admin role.

### Revoke rules

1. **`revoke_reason` is persisted permanently.** It is stored on the
   `certificates` row and survives the admin action indefinitely. It is not
   cleared if the row is otherwise updated.

2. **`revoke_reason` is NOT included in `audit_log.after`.** The audit row's
   `entity_id` is the cert UUID. Auditors who need the reason look up the
   certificate row directly. This follows the same PII scoping policy as
   `override_reason` on grading decisions — reasons may reference personal
   details that belong on the entity row, not in the immutable audit log.

3. **A revoked cert returns 410 on PDF download and 200 with a red badge on
   the verify page.** The OG/preview images also render the red "REVOKED"
   badge (see § Share previews).

4. **A revoked cert cannot be reissued — throw 410.** Issue a new cert via
   `issueCertificateOnRelease` (or manually) instead. Reissue is exclusively
   for name corrections on active certs; revocation is terminal.

5. **`revoke_reason` min length: 10 chars.** Validated in the route handler
   and enforced in the UI text field. Short strings like "mistake" are
   rejected.

### Reissue rules

1. **Preserves `credential_id` and `issued_at`.** These fields are never
   rotated on reissue — shared LinkedIn URLs continue to resolve and verify
   correctly against the updated row.

2. **Updates `display_name` and re-signs `signed_hash` in the same
   transaction.** The HMAC payload is recomputed from the new `display_name`
   plus the unchanged identity fields; the `signed_hash` column is overwritten
   atomically. The prior signature is no longer valid after this point.

3. **Used only for name corrections.** Normal first-issuance is handled
   automatically by `issueCertificateOnRelease` on attempt release. Reissue
   addresses the narrow case where a cert was issued with a misspelled or
   legally changed display name.

### Admin page — `/admin/certificates`

```
/admin/certificates
┌──────────────────────────────────────────────────────────────────────┐
│  Certificates.                         [N certificates]              │
│  Credentials issued to candidates in this tenant.                    │
│  Tier: [All] [Completion] [Distinction] [Honors]                     │
│  Status: [All] [Active] [Revoked]                                    │
├───────────┬──────────────┬────────────┬──────────┬────────┬─────────┤
│ Cred. ID  │ Email        │ Tier       │ Course   │ Issued │ Status  │
├───────────┼──────────────┼────────────┼──────────┼────────┼─────────┤
│ AIQ-…     │ alice@…      │ Completion │ SOC L1   │ 11 May │ Active  │ ← row click → details drawer
└───────────┴──────────────┴────────────┴──────────┴────────┴─────────┘

Details drawer (row click):
  Credential ID: AIQ-2026-05-ABCDEF  [copy]
  Verify URL: https://assessiq.automateedge.cloud/verify/AIQ-2026-05-ABCDEF [↗]
  Display name: Alice Smith
  Course: SOC L1
  Issued: 11 May 2026
  Status: Active
  [Revoke]  ← opens revoke confirmation modal

Revoke modal:
  Reason (min 10 chars): [________________________]  [Cancel] [Revoke certificate]
```

A revoked cert's drawer replaces `[Revoke]` with the reason text and
`revoked_at` timestamp; no further actions are available. The `[Reissue]`
action (for name corrections on active certs) is accessible from the same
drawer.
