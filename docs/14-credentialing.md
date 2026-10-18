# Credentialing — tamper-evident certificates

*Type: reference* — This page describes the certificate model: issue rules, signing and public verification.

**Status:** Phase 5 is shipped. The `honors` tier is deferred and has no threshold yet.

Module-internal details are in `modules/18-certification/SKILL.md`. The full Phase 5 blueprint is in `docs/plans/archive/CERTIFICATION_PLAN_GENERIC.md`.

## Certificate record

| Item | Rule |
| --- | --- |
| Issue event | An admin confirms that a graded attempt crossed a tier threshold |
| Snapshot fields | Candidate display name, course title and level, at the time of issue |
| Later profile edits | They do NOT update issued certificates. A credential is a point-in-time record |
| Public identifier | `credential_id` |
| Storage case | Uppercase |
| Lookup | The verify page changes the input to uppercase. Lowercase input still resolves |

## Credential ID format

Format: `PREFIX-YYYY-MM-XXXXXX`.

| Segment | Source | Notes |
| --- | --- | --- |
| `PREFIX` | Issuer code (default `AIQ`) | 2 to 4 uppercase letters |
| `YYYY-MM` | Issuance month (UTC) | Shows the age to the eye. Not used for crypto |
| `XXXXXX` | 6 characters from `[0-9ABCDEFGHJKMNPQRSTVWXYZ]` | CSPRNG (`crypto.randomInt`). Retry on DB UNIQUE conflict |

- The suffix alphabet is a Crockford-style set of 32 characters.
- The alphabet excludes I, L, O and U. These characters look like other characters on a printed certificate, a LinkedIn profile or a business card (I and L look like 1, O looks like 0).
- `CREDENTIAL_ID_REGEX` still accepts all `[A-Z0-9]` characters. Certificates issued before this change remain valid. None existed in production at the time of the change.

## HMAC signing

| Item | Rule |
| --- | --- |
| Field | `signed_hash` on each certificate row |
| Algorithm | HMAC-SHA256, hex digest |
| Input | Canonical JSON of the identity and display-snapshot fields |
| Canonical form | Keys sorted alphabetically. `JSON.stringify` with no whitespace. The digest is byte-identical across Node processes and versions |
| Key | `process.env.CERT_SIGNING_SECRET` |
| Compare | `crypto.timingSafeEqual` on equal-length `Buffer`s. A length mismatch returns `false` and does not throw |
| Excluded from the payload | `pdf_downloads`, `linkedin_shares`, `verification_views` and the revocation fields. A counter bump or a revocation does not need a new signature |

**Stability invariant.**

- A tier upgrade (for example completion to distinction) re-signs the row in the same DB transaction as the tier UPDATE.
- `credential_id` and `issued_at` are preserved and never rotated. Shared LinkedIn URLs keep verifying against the current row state.

**`issued_at` second-precision invariant.**

- The system truncates `issued_at` to second precision before it signs and before it stores (`2026-05-11T17:46:23Z`, no milliseconds).
- The public verify page rebuilds the HMAC payload from the stored row. The DB projection also removes milliseconds.
- Both sides must use the same format, or the signature does not verify.

## Secret management

| Item | Rule |
| --- | --- |
| `CERT_SIGNING_SECRET` | Required. No default and no dev fallback. `getCertSigningSecret()` throws at the first call if the variable is unset |
| Rotation | It invalidates every existing signature |
| Rotation procedure | 1. Add a `signed_hash_v2` column. 2. Run a one-shot resigner under the new secret. 3. Update `verifyCertificateSignature` to accept either column during the cutover window. 4. Drop v1 |
| Storage | The production VPS environment file. The ops procedure is in `docs/06-deployment.md` |
| Care level | The same as `SESSION_SECRET` and `ASSESSIQ_MASTER_KEY` |

## Audit actions

| Action | When | Payload |
| --- | --- | --- |
| `certification.cert.issue` | First issue | `after` holds `{credential_id, tier, candidate_id, attempt_id}` only |
| `certification.cert.upgrade` | Tier upgrade | `before` holds the prior tier. `after` holds the same identity fields |
| `certificates.revoked` | Revoke (admin) | Emitted through `auditInTx`. It does not hold `revoke_reason` |
| `certificates.reissued` | Reissue (admin) | Emitted through `auditInTx` |

Both `certification.cert.*` writes happen in the same transaction as the cert INSERT or UPDATE, through `auditInTx`. An audit failure rolls back the cert change. A cert row never exists without its audit entry, and the reverse also holds.

## Share previews (Open Graph)

The verify page puts Open Graph and Twitter Card meta tags in its `<head>`. A link shared on LinkedIn, Twitter or another crawler-driven platform shows a rich card: a 1200×630 image, name, course title and tier.

| Endpoint | Format | Used by |
| --- | --- | --- |
| `GET /verify/:credentialId/og.svg` | Vector SVG | Twitter, Facebook, Mastodon, Slack and most general crawlers |
| `GET /verify/:credentialId/og.png` | Raster PNG, 1200×630 | LinkedIn, which rejects SVG previews |

- The PNG is rendered on the server at request time with `@resvg/resvg-js` (pure Rust, no headless browser). It is cached for one hour.
- Both endpoints follow the current certificate status. A revoked certificate shows a red "REVOKED" badge. A tampered signature shows "INVALID".
- `og:image` in the HTML head always points to the PNG endpoint, because LinkedIn is the main share target.
- The system builds absolute URLs from the `PUBLIC_BASE_URL` env var. If it is unset (test environments), the meta tags are omitted and the page still renders.

## Automatic issuance on release

| Item | Rule |
| --- | --- |
| Trigger | An admin releases a graded attempt: `POST /admin/attempts/:id/release` |
| Transaction | The same `withTenant()` transaction as the `graded→released` status update and the `grading.released` audit row. The cert row and the release are atomic |
| Entry point | `issueCertificateOnRelease(client, { tenantId, attemptId, actorUserId })` in `modules/18-certification/src/service.ts` |
| Caller | `handleAdminReleaseAttempt` in `modules/07-ai-grading/src/handlers/admin-claim-release.ts` |
| Placement | Inside `withTenant()`, after `auditInTx`. This satisfies the R2 open-transaction precondition of `issueCertificate` (`pg_current_xact_id_if_assigned()` sentinel) |
| Rollback | If the cert INSERT throws despite the outer `.catch()`, `withTenant()` rolls back the `graded→released` UPDATE and the audit row. Retry the release |
| Manual fallback | Re-issue from the admin certificates page |

### Pass rule and tier (Z-16, 2026-10-17)

**What changed.** The fixed 70 percent floor is gone. A certificate exists for every pass. A pass is a score at or above the assessment pass mark.

| Result | Certificate |
| --- | --- |
| Fail (below the pass mark) | None. `issueCertificateOnRelease` returns `null` |
| Pass, score below 90 percent | `completion` |
| Pass, score 90 percent or more | `distinction` |
| Scores not yet computed, or the candidate is erased | None |

- **Pass mark.** `attempt_scores.pass_mark_pct`, a snapshot of `assessments.passing_score_pct` taken when the score row is first written. A later edit never changes an old result.
- **One rule.** `isPass` and `meetsPct` in `@assessiq/core` (`modules/00-core/src/pass-mark.ts`). Integer math in hundredths: `earned * 100 >= mark * max`. A score of 59.99 percent fails a mark of 60. The result pages use the same function.
- **Why.** The owner wants one clear rule per assessment. A fixed floor made a pass mark of 60 produce a pass without a certificate.
- **Considered and rejected.** A pass mark per level only (cannot differ per assessment). A float compare of `auto_pct` (rounds up at the boundary).
- **Not included.** Honors (later). Retake (Z-39). Result page and email wording (another step). The tier enum stays at three values (`completion`, `distinction`, `honors`) and upgrade-only.
- **Edge case.** A pass mark above 90 makes every pass a Distinction. The help text for the field says so.
- **Downstream.** The `modules/13-notifications` result email still reads `levels.passing_score_pct`. The `modules/15-analytics` results export still reads it. Both are follow-ups.

### One certificate per assessment and candidate (Z-39, 2026-10-18)

- **What.** A candidate can pass more than once when the assessment allows retakes. `issueCertificateOnRelease` first looks for a live (not revoked) certificate of the same candidate on any EARLIER attempt of the same assessment. If one exists it returns that certificate and issues nothing new. The unique key stays `(tenant_id, candidate_id, attempt_id)`; the new check is in the service.
- **Why.** The owner wants the existing rule per passed attempt, but one credential per assessment and candidate. A second credential id for the same result would confuse verifiers.
- **Considered and rejected.** A database unique key on (candidate, assessment): the certificate row has no assessment column, and a join key would need a cross-table index. Upgrading the first certificate when a later attempt scores higher: it would change a signed credential after issue.
- **Not included.** A tier upgrade from a later attempt. If the first certificate is revoked, the next passed attempt can earn a new one.
- **Downstream.** `modules/18-certification/src/service.ts`; test in `modules/09-scoring/src/__tests__/release.test.ts`.

### Never-raise invariant

- A cert failure must not block the release.
- The call site wraps the dynamic import and the function call in `.catch((err) => log.warn(…))`.
- A cert failure logs `grading.release.cert_issuance_failed` and continues.
- The release HTTP response still returns `{ attempt: { status: "released" } }`.

### Dynamic import

| Item | Rule |
| --- | --- |
| Reason | Module `07-ai-grading` has no static dependency on `@assessiq/certification` |
| Pattern | `new Function('specifier', 'return import(specifier)')`. Module 13 notifications uses the same indirection |
| Effect | The grading module compiles and works in test environments where the certification package is absent or removed |

## Related references

These parts are shipped (Phase 5 Sessions 3, 4, 6 and 7, May 2026). Other references describe them:

| Part | Where |
| --- | --- |
| PDF generation and `/api/certificates/:credentialId/pdf` | `modules/18-certification/src/pdf/` and `docs/03-api-contract.md` |
| Public `/verify/:credentialId` page and its non-RLS DB lookup | `modules/18-certification/src/routes-public.ts` and `modules/18-certification/SKILL.md` |
| LinkedIn share counter (`POST /api/certificates/:credentialId/share-linkedin`) | `modules/18-certification/src/routes.ts` |
| OG and LinkedIn PNG previews | `modules/18-certification/src/routes-public.ts` |

## Admin surface

The admin certificate surface is the fallback for two cases. The first case is a failed automatic `issueCertificateOnRelease` trigger (for example, `CERT_SIGNING_SECRET` unset at release time). The second case is a legitimate name correction.

### Admin endpoints

All three endpoints need the tenant-admin role.

| Method and path | Purpose | Request body | Result and errors |
| --- | --- | --- | --- |
| `GET /api/admin/certificates` | Paginated list of all cert rows in the current tenant | none. Filters: `tier` (`completion`, `distinction`, `honors`) and `status` (`active`, `revoked`). Params `?page=` and `?limit=` | Cursor-paginated list |
| `POST /api/admin/certificates/:credentialId/revoke` | Revoke a certificate | `{ "revoke_reason": "string, min 10 chars" }` | Sets `revoked_at` (current timestamp) and `revoke_reason`. Emits `certificates.revoked`. Returns 409 if already revoked |
| `POST /api/admin/certificates/:credentialId/reissue` | Correct the display name without a change of identity | `{ "display_name": "string (optional)" }` | Updates `display_name` and re-signs `signed_hash` in the same transaction. Emits `certificates.reissued`. Returns 410 if the cert is revoked |

### Revoke rules

1. `revoke_reason` is stored permanently on the `certificates` row. Other updates to the row do not clear it.
2. `revoke_reason` is NOT in `audit_log.after`. The `entity_id` of the audit row is the cert UUID. An auditor reads the reason from the certificate row. This follows the PII policy for `override_reason` on grading decisions: reasons can name personal details, and those details belong on the entity row, not in the immutable audit log.
3. A revoked cert returns 410 on PDF download. The verify page returns 200 with a red badge. The OG and preview images also show the red "REVOKED" badge (see "Share previews (Open Graph)").
4. A revoked cert cannot be reissued (410). Issue a new cert with `issueCertificateOnRelease` or manually. Reissue is only for name corrections on active certs. Revocation is final.
5. The minimum length of `revoke_reason` is 10 characters. The route handler validates it and the UI text field enforces it. A short string such as "mistake" is rejected.

### Reissue rules

1. Reissue preserves `credential_id` and `issued_at`. Shared LinkedIn URLs keep resolving and verifying against the updated row.
2. Reissue updates `display_name` and re-signs `signed_hash` in the same transaction. The HMAC payload is recomputed from the new `display_name` and the unchanged identity fields. The old signature is no longer valid after the update.
3. Use reissue only for name corrections. `issueCertificateOnRelease` handles normal first issuance. Reissue covers a cert issued with a misspelled or legally changed display name.

### Admin page `/admin/certificates`

| Element | Content |
| --- | --- |
| Header | "Certificates." with a count `[N certificates]`, and the text "Credentials issued to candidates in this tenant." |
| Filters | Tier: All, Completion, Distinction, Honors. Status: All, Active, Revoked |
| Table columns | Cred. ID, Email, Tier, Course, Issued, Status |
| Row action | A row click opens the details drawer |
| Drawer fields | Credential ID with a copy action (for example `AIQ-2026-05-ABCDEF`), verify URL (`https://assessiq.automateedge.cloud/verify/AIQ-2026-05-ABCDEF`), display name, course, issued date, status |
| Drawer actions | `[Revoke]` opens the revoke confirmation modal. `[Reissue]` (name corrections on active certs) is in the same drawer |
| Revoke modal | Reason field (min 10 chars) with `[Cancel]` and `[Revoke certificate]` |
| Revoked cert drawer | `[Revoke]` is replaced by the reason text and the `revoked_at` timestamp. No further action is available |

## LinkedIn share button (Phase 5 Session 10)

The public verify page shows a "Share on LinkedIn" call to action for active (not revoked) certificates. This completes the Phase 5 MVP scope.

| Certificate status | Button |
| --- | --- |
| `valid` (active) | Active `<a>` that opens the LinkedIn share dialog in a new tab |
| `revoked` | Disabled `<button>` with the tooltip "Revoked certificates can't be shared" |
| `tampered` | No button |
| `PUBLIC_BASE_URL` unset | No button (degrades the same way as OG meta) |

| Item | Rule |
| --- | --- |
| URL pattern | `https://www.linkedin.com/sharing/share-offsite/?url=<encoded verify URL>` |
| Integration | No Company Page, no LinkedIn API auth, no SDK. The LinkedIn feed composer fetches the verify URL and renders a rich preview card from the Session 7 OG meta and the `/og.png` endpoint |
| Link attributes | `target="_blank"` with `rel="noopener noreferrer"` |
| Help ID | `public.verify.share_linkedin`, content in `modules/16-help-system/content/en/candidate.yml` |
| Counter | `POST /api/certificates/:credentialId/share-linkedin` (Session 6) needs authentication. Shares from the public verify page are NOT counted. `linkedin_shares` tracks shares from the authenticated My Certificates dashboard only. This is acceptable for the MVP |
