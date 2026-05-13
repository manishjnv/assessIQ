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

## What's not in this doc

- PDF generation and the `/api/certificates/:credentialId/pdf` endpoint —
  Phase 5 Session 4.
- The public `/verify/:credentialId` page and its non-RLS DB lookup
  strategy — Phase 5 Session 3.
- LinkedIn share counter and admin revoke surfaces — Phase 5 Sessions 5–6.
