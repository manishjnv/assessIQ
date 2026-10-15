# Course-Completion Certificate Feature — Technical Implementation Plan

A self-contained, project-agnostic blueprint. Hand this to another Claude (or developer) and it should be able to ship Phase 1 in 6–10 focused sessions. Stack-neutral where possible; concrete recommendations are called out as **Recommended:**.

---

## 0. What you're building

A credentialing layer that:

1. Detects when a learner has crossed completion thresholds in a course/plan/program.
2. Issues a tamper-evident, idempotent certificate row.
3. Exposes a downloadable **PDF** with a QR pointing at a public **verify URL**.
4. Renders a **public verification page** (no auth) that proves authenticity via HMAC and shows revocation state.
5. Lets the learner **share to LinkedIn** in one click; tracks downloads / shares / verification views.
6. Provides admin tools to **revoke** with a reason.

Out of scope for Phase 1: LinkedIn "Add to Profile" API (needs a Company Page), employer/recruiter portal, fraud detection beyond HMAC + revocation, multi-issuer support.

---

## 1. Domain model

### 1.1 The `Certificate` row

Snapshot of *what was true at the moment of issuance*. Profile edits later must NOT retro-update issued certs — that's a feature, not a bug, because a cert is a point-in-time credential.

| Field | Type | Notes |
|---|---|---|
| `id` | int PK | surrogate |
| `user_id` | FK → users | cascade delete |
| `enrollment_id` | FK → user_plans/enrollments | cascade delete; the *thing* the cert is for |
| `template_key` | string | denormalized — survives template renames |
| `credential_id` | string, **unique** | public-facing slug (see §1.2) |
| `tier` | enum string | `"completion" | "distinction" | "honors"` (or your tiers) |
| `display_name` | string | snapshotted from `User.name` at issue |
| `course_title` | string | snapshotted |
| `level` | string | snapshotted (e.g. "beginner") |
| `duration_months` | int | snapshotted |
| `total_hours` | int | snapshotted |
| `checks_done` | int | snapshotted |
| `checks_total` | int | snapshotted |
| `repos_linked` | int | snapshotted |
| `repos_required` | int | snapshotted |
| `issued_at` | datetime UTC | set once; preserved on tier upgrade |
| `signed_hash` | string (hex) | HMAC-SHA256, see §3 |
| `revoked_at` | datetime UTC nullable | revocation marker |
| `revoke_reason` | text nullable |   |
| `pdf_downloads` | int default 0 | counter |
| `linkedin_shares` | int default 0 | counter |
| `verification_views` | int default 0 | counter |

**Constraints / indexes:**

- `UNIQUE(user_id, enrollment_id)` — one cert per enrollment, hard idempotence
- `UNIQUE(credential_id)` — slug uniqueness
- index on `user_id` (list-by-user is the hot read)
- index on `credential_id` (verify-page lookup)

### 1.2 Credential ID format

```
PREFIX-YYYY-MM-XXXXXX
```

- `PREFIX` = 2–4 uppercase letters identifying the issuer (e.g. `AER`, `CRS`, `EDU`).
- `YYYY-MM` = year + month at issue time. Lets recruiters eyeball cert age. Not the cryptographic root of trust — just convenience.
- `XXXXXX` = 6 chars from `[A-Z0-9]`. 36⁶ ≈ 2.1B per month. Use **`secrets.choice`** (or platform CSPRNG), not `random`.
- DB unique constraint is the hard collision guard. Generation should retry on `IntegrityError`, max ~3 attempts before erroring.

Acceptable as a URL slug. Store uppercase. Accept lookups case-insensitively (normalize → upper) on the verify page so a recruiter typing it in lowercase still works.

### 1.3 Tier ordering

```
TIER_ORDER = { "completion": 1, "distinction": 2, "honors": 3 }
```

Tier upgrades only go up. **Never downgrade** an existing certificate even if state regresses (e.g. a repo gets unlinked) — you don't take a credential away from someone who already earned it.

---

## 2. Threshold logic (the gating rules)

This is the part most teams over-engineer. Keep it pure-functional.

```python
def determine_tier(
    *,
    total_checks: int,
    checks_done: int,
    capstone_total: int,        # checks in the final/required milestone
    capstone_done: int,
    repos_required: int,
    repos_linked: int,
    has_honors_eval: bool,
) -> Optional[Literal["completion", "distinction", "honors"]]:
    if total_checks == 0:
        return None
    capstone_ratio = 1.0 if capstone_total == 0 else capstone_done / capstone_total
    overall_ratio  = checks_done / total_checks

    if capstone_ratio < 1.0:        # capstone is a hard gate on EVERYTHING
        return None
    if overall_ratio < 0.90:
        return None

    tier = "completion"
    if overall_ratio >= 1.0:
        repo_ratio = 1.0 if repos_required == 0 else repos_linked / repos_required
        if repo_ratio >= 0.80:
            tier = "distinction"
            if has_honors_eval:
                tier = "honors"
    return tier
```

Rules of thumb:

- The **capstone gate** (the "final project / final milestone must be 100%") prevents people from gaming the cert by ticking only theory work.
- If the course has no repo requirement, `repos_required == 0` short-circuits the repo gate to "satisfied". Don't punish learners on courses that don't ship code.
- "Honors" requires a **quality signal**, not a quantity signal — an AI/instructor evaluation score on a capstone deliverable. If you don't have an eval pipeline yet, stub `has_honors_eval = False` and ship 2 tiers in Phase 1.
- All thresholds (90%, 80%, 8.0) belong in **module-level constants**, not hardcoded inline. You will tune them.

---

## 3. Tamper-evident signing

Stateless, HMAC-based. No external dependencies.

```python
import hmac, hashlib, os

def cert_secret() -> bytes:
    env = os.environ.get("CERT_HMAC_SECRET", "").strip()
    if env:
        return env.encode()
    # Dev fallback so local envs don't need extra setup. Prefix-namespace the
    # derivation so the cert secret can't be confused with the JWT secret.
    base = settings.jwt_secret.encode()
    return hashlib.sha256(b"cert-hmac-v1|" + base).digest()

def sign_credential(credential_id: str, user_id: int, issued_at: datetime) -> str:
    issued_iso = issued_at.replace(microsecond=0).isoformat()
    payload = f"{credential_id}|{user_id}|{issued_iso}".encode()
    return hmac.new(cert_secret(), payload, hashlib.sha256).hexdigest()

def verify_signature(cert) -> bool:
    expected = sign_credential(cert.credential_id, cert.user_id, cert.issued_at)
    return hmac.compare_digest(expected, cert.signed_hash)   # constant-time!
```

Critical points:

- `hmac.compare_digest` (or your language's constant-time comparator). **Never `==`**.
- Signed payload includes `credential_id`, `user_id`, `issued_at` — *not* the mutable fields (tier, counters, name). The signature attests "this credential exists for this user at this time," not the current display state. That keeps the cert valid through tier upgrades.
- `microsecond=0` so re-signing during an upgrade with the persisted timestamp produces identical bytes. Easy to forget; fails verify mysteriously when you do.
- Keep the secret in env (`CERT_HMAC_SECRET`). **Rotation = invalidates all signatures.** Document this. If you ever need to rotate, add a `signed_hash_v2` column and re-sign during a maintenance window.

---

## 4. Issuance engine

Single entry point: `check_and_issue(db, user, enrollment) -> Optional[Cert]`. Behaviors:

| Situation | Result |
|---|---|
| No threshold crossed | returns `None` (or existing row unchanged) |
| First crossing | INSERT new row with credential_id + signature |
| Already exists, same/lower tier | returns existing unchanged |
| Already exists, higher tier qualifies | UPDATE `tier` + snapshot counters in place; **keep `credential_id` and `issued_at`** |

Preserving `credential_id` + `issued_at` on upgrade is the hidden invariant that keeps signatures valid and shared LinkedIn URLs working. Don't rotate them.

### 4.1 The "never raise" wrapper

The hot path that triggers issuance (progress tick, repo link, eval complete) MUST NOT fail because of certs. Wrap:

```python
async def safe_check_and_issue(db, user, enrollment):
    try:
        return await check_and_issue(db, user, enrollment)
    except Exception:
        logger.exception("Certificate issuance failed (non-fatal)")
        return None
```

### 4.2 Trigger points

Wire `safe_check_and_issue` into:

1. **Progress tick** — after `PATCH /progress` or equivalent, *only when the tick set `done=True`*. Skipping `done=False` ticks halves issuance evaluations.
2. **Repo link create** — after `POST /repos/link`. New repo can unlock Distinction.
3. **AI evaluation complete** — after the eval pipeline writes a score. New score can unlock Honors.

Don't trigger on every read or every page load. Don't trigger on logout. The three write-side events above cover all state transitions that can change tier.

### 4.3 Stat collection

Pull everything in one DB pass per call. Typical query bundle:

- All progress rows for the enrollment → derive `total_checks`, `checks_done`, `capstone_done`, `capstone_total` from the template definition + done set.
- All repo links for the enrollment → `repos_linked`; filter by capstone weeks → IDs eligible for honors eval.
- Top score across capstone repo evals → `has_honors_eval = top_score >= 8.0`.

The template defines what counts as "capstone" — typically the last month/module. Cache the template load, it's read repeatedly.

---

## 5. PDF generation

**Recommended stack:** WeasyPrint (HTML+CSS → PDF) + `qrcode[pil]`. Same shape works with Playwright/Puppeteer headless, just slower.

### 5.1 Architecture

- Separate module (`services/certificate_pdf.py`) — keeps the heavy native-lib import (Pango/Cairo for WeasyPrint; Chromium for Playwright) **out of the hot import graph**.
- **Lazy import** of the renderer inside the function body so app startup stays fast and the issuance path doesn't pull native libs.
- Jinja2 (or your template engine) for `templates/certificate.html`. Single file, self-contained CSS, A4 landscape.
- QR generated on-the-fly, embedded as base64 inline `<img src="data:image/png;base64,...">` so the PDF is single-file with no external fetches.

### 5.2 Template content (recommended layout)

```
┌─────────────────────────────────────────┐
│      <ISSUER LOGO>     "Verified"       │
│                                         │
│        CERTIFICATE OF <TIER>            │
│         <Course Title>                  │
│                                         │
│    is awarded to                        │
│      <Display Name>                     │
│                                         │
│    for completing a <N>-month <Level>   │
│    program · <hours> hours              │
│    <checks_done>/<checks_total> milestones │
│    <repos_linked> projects shipped      │
│                                         │
│    Modules: <M1> · <M2> · <M3>...       │
│    Topics: <chip> <chip> <chip>...      │
│                                         │
│   [QR CODE]   Issued <Month D, YYYY>    │
│               Credential <ID>           │
│               verify at <domain>/verify │
└─────────────────────────────────────────┘
```

Keep typography simple: one serif (e.g. Fraunces, Garamond), one sans (system-ui), 2–3 colors max. Tier-specific accent color is a nice touch (richer hue for higher tiers).

### 5.3 Endpoint contract

```
GET  /api/certificates/{credential_id}/pdf
  - Auth required; cert must belong to current user
  - 404 if not found / not owned
  - 410 if revoked (do NOT serve PDFs for revoked certs)
  - On success: increment pdf_downloads, return application/pdf
  - Headers: Cache-Control: no-cache, no-store, must-revalidate
            Content-Disposition: attachment; filename="<credential_id>.pdf"
```

### 5.4 Pinning

WeasyPrint and its native-lib deps drift. **Pin exact versions** (`weasyprint==X.Y.Z`, `pydyf==A.B.C`) — silent breakage from minor bumps is a recurring pain point. Update the Dockerfile to install pango / cairo / harfbuzz / gdk-pixbuf system packages.

---

## 6. Public verification page

Mounted **outside `/api`** because it's an HTML page for non-users.

### 6.1 Routes

```
GET  /verify                              → search form (paste credential ID)
GET  /verify/lookup?id=AER-2026-04-A7F3K9 → 303 redirect to /verify/<id>
GET  /verify/{credential_id}              → the actual cert page
GET  /verify/{credential_id}/og.svg       → 1200×630 SVG for link previews
```

### 6.2 Behaviors

- **No auth.** This is the recruiter's entry point.
- **Always loads when the cert exists.** Tampering or revocation flips the badge from green ✓ to red ✗ — the page itself doesn't 404. Recruiters seeing a red ✗ is the value; if you 404, they think the link is broken.
- **404 only when `credential_id` doesn't match anything.** Use a friendly "credential not found" page with the ID echoed back; this catches typos.
- **Server-side HMAC check on every render.** Compare via `hmac.compare_digest`. Cache aggressively only the OG image; the HTML page should be `Cache-Control: no-cache` so revocations propagate immediately.
- **Per-IP rate limit.** 60 views / IP / hour is a reasonable starting point. In-process dict keyed on `(client_ip)` is enough at low traffic; move to Redis when sharing state across processes.
- **Per-(IP, credential) dedup window** for the `verification_views` counter. First view in 1h increments; reloads don't. Prevents counter inflation from tab-flipping recruiters.
- **OpenGraph meta tags** are mandatory — that's how LinkedIn/X/Slack render the preview card. `og:title`, `og:description`, `og:image` (1200×630), `og:url`, `og:type=website`. Twitter card variant: `twitter:card=summary_large_image` plus the same fields under `twitter:` namespace.
- **OG image as SVG** is the cheap path. WeasyPrint or Playwright PNG render is the polished path. Either works for LinkedIn.
- **JSON-LD `EducationalOccupationalCredential`** schema embedded inline → SEO + structured-data eligibility for recruiter search:

```json
{
  "@context": "https://schema.org",
  "@type": "EducationalOccupationalCredential",
  "name": "Certificate of Completion — <Course>",
  "credentialCategory": "certificate",
  "educationalLevel": "Beginner",
  "recognizedBy": { "@type": "Organization", "name": "<Issuer>", "url": "<base>" },
  "dateCreated": "<issued_at ISO8601>",
  "about": { "@type": "Thing", "name": "<Course Title>" },
  "url": "<verify URL>"
}
```

Emit it even when revoked — schema describes the credential record, not its current validity (badge conveys that visually).

### 6.3 Lookup form (the "recruiter has only the printed ID" case)

A printed PDF gives the recruiter the credential ID, not necessarily the URL. Provide a paste-an-ID form at `/verify`. Accept either the bare ID (`AER-2026-04-A7F3K9`) or the full URL (extract the trailing segment). Validate with regex matching your prefix format. Redirect 303 to the canonical page; re-render the form with an inline error on bad input.

---

## 7. LinkedIn share

The cheap path that needs no Company Page or LinkedIn API auth:

```
https://www.linkedin.com/sharing/share-offsite/?url=<verification_url>
```

Open in `target="_blank"` with `rel="noopener"`. LinkedIn's feed composer fetches the verify URL, reads the OG tags, renders the preview card. That's the entire "share to LinkedIn" feature.

Counter:

```
POST /api/certificates/{id}/share-linkedin
  - Auth required
  - Increments linkedin_shares
  - Returns 204
  - Frontend fires this fire-and-forget BEFORE opening the LinkedIn URL
    (window.open is in the same click-handler tick → no popup blocker issue)
```

**Phase 2 only:** LinkedIn "Add to Profile" → lands the cert in `Licenses & Certifications` with the issuer logo. Requires a LinkedIn Company Page + Marketing Developer Platform application. Defer.

---

## 8. Frontend surfaces

### 8.1 Account / dashboard — "My Certificates" section

List all of the user's certs, newest first. Per row:

- Tier badge (color-coded)
- Issued date
- Credential ID (monospace)
- Course title
- 4 actions: **Download PDF** · **Share on LinkedIn** · **Copy verify link** · **View public page**
- Disable PDF + Share buttons on revoked certs; show "Revoked" badge instead.

Empty state: a one-line "Complete a course to earn your first certificate" pointing at the active course/plan.

### 8.2 Completion modal (home/dashboard)

Trigger: when a progress tick succeeds with `done=true`, the frontend re-fetches `/api/certificates`. If the newest cert's `(credential_id, tier)` tuple hasn't been shown before, fire a celebration modal.

- Gate "shown before" in `localStorage` keyed on `(credential_id, tier)` → upgrades from completion → distinction → honors each fire once.
- 3 CTAs: **Download PDF**, **Share on LinkedIn**, **View in My Certificates**.
- Confetti is optional but converts. `canvas-confetti` is ~5KB.
- Closes on ×, overlay click, or route change.
- Scope styles inline (or a single `<style>` block injected by JS) to avoid bleeding into the page.

### 8.3 Profile name callout

Inline hint under the Name field on the account/profile page:

> *This name appears on your course completion certificate. Recruiters will see it.*

This is the single best UX investment to prevent "my cert says my email handle, can you fix it?" support tickets. Pair with the snapshot-at-issue rule: name edits *after* issuance do NOT update existing certs (admin can re-issue if genuinely needed).

---

## 9. Admin endpoints

Minimum viable:

```
GET  /admin/certificates                     → list all (paginated, filter by user/tier/revoked)
POST /admin/certificates/{id}/revoke         → body: {reason: string}; sets revoked_at + reason
POST /admin/certificates/{id}/reissue        → re-snapshot display_name + counters; recompute signature
                                              (rare; for legitimate name correction requests)
```

Reissue **does not** rotate `credential_id` or `issued_at` — that would invalidate already-shared LinkedIn URLs. It only updates the snapshot fields and re-signs.

---

## 10. Tests (acceptance criteria)

Unit-test the pure functions first; they cover ~80% of failure modes.

| Test | Asserts |
|---|---|
| `test_credential_id_format` | regex matches `^[A-Z]{2,4}-\d{4}-\d{2}-[A-Z0-9]{6}$` |
| `test_signature_deterministic` | same inputs → same digest |
| `test_signature_constant_time_compare` | `compare_digest` used (lint, not runtime) |
| `test_tier_capstone_gate` | overall=100% but capstone=80% → returns None |
| `test_tier_completion_threshold` | overall=89% → None; 90% + capstone 100% → "completion" |
| `test_tier_distinction_repos_gate` | overall=100% but repos=70% → "completion" not "distinction" |
| `test_tier_honors_requires_eval` | distinction gates pass + has_honors_eval=False → "distinction" |
| `test_no_repos_required_doesnt_block_distinction` | repos_required=0 + overall=100% → "distinction" |
| `test_idempotence_first_crossing` | issues row with credential_id |
| `test_idempotence_no_duplicate` | second call same state → returns same row, no INSERT |
| `test_upgrade_preserves_credential_id_and_issued_at` | completion → distinction same id+date |
| `test_no_downgrade` | distinction holder regresses → still distinction |
| `test_revoked_pdf_returns_410` | revoked cert PDF endpoint |
| `test_verify_page_loads_for_revoked` | red badge, 200 not 404 |
| `test_verify_page_404s_unknown_id` | malformed or unknown credential |
| `test_signature_mismatch_renders_red_badge` | tampered cert → bad badge |

Integration tests:

- Full progress-tick → issuance happy path against a seeded enrollment
- Repo-link triggers Distinction upgrade end-to-end
- Eval completion triggers Honors upgrade end-to-end
- PDF endpoint returns valid PDF bytes (header magic `%PDF-`)
- Verify page → OG meta tags present and well-formed

---

## 11. Build order (recommended sessions)

| Step | Scope | Why this order |
|---|---|---|
| **1** | Model + migration + design doc | Locks the schema. Everything else builds on it. |
| **2** | Issuance engine (pure tier logic + idempotent issue + 3 hooks) | The cryptographic + business core. Unit-tested in isolation. |
| **3** | PDF generator + download endpoint | Independent of frontend; ship behind auth. |
| **4** | Public `/verify/{id}` page + OG image + lookup form | First externally visible surface; recruiter-grade polish here. |
| **5** | "My Certificates" section on account page | First learner-visible surface. |
| **6** | Completion modal on home / dashboard | Conversion-driver; needs steps 1–5 working. |
| **7** | Profile-name callout | Trivial; ships with step 5 if scope allows. |
| **8** | LinkedIn share button + counter endpoint | Last because OG meta from step 4 must be live first. |

After Phase 1 ships, expect a wave of polish work:

- Pin native-lib versions when WeasyPrint breaks
- Add nginx/proxy rule for `/verify/` if your gateway is allowlist-style
- No-cache headers on PDF + verify when you tweak the template
- "Modules covered" / topic chips on the verify page (recruiter scan-ability)
- Empty-state placeholder on My Certificates
- Toolbar Share button + dedicated `/share` page
- Leaderboard or social-proof surfaces showing lifetime cert counts
- IndexNow / sitemap ping on cert publish so verify pages index fast

---

## 12. Configuration

| Env var | Purpose | Required? |
|---|---|---|
| `CERT_HMAC_SECRET` | HMAC signing secret | yes in prod (dev derives from `JWT_SECRET`) |
| `PUBLIC_BASE_URL` | absolute URL for verify links + QR | yes |
| `JWT_SECRET` | used for dev-fallback HMAC derivation | yes (probably already exists) |

System packages (Dockerfile additions for WeasyPrint):

```
libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0
libharfbuzz0b libffi-dev shared-mime-info fonts-dejavu
```

Pin requirements:

```
weasyprint==<exact>
pydyf==<exact>
qrcode[pil]==<exact>
Pillow==<exact>
jinja2==<exact>
```

---

## 13. Operational notes

- **Counters are non-critical.** Lose them if the DB has an unhappy moment; don't block the user-facing path on counter writes. `cert.linkedin_shares += 1` should be in the same transaction as the user response, but if you ever feel pressure to defer it, do — value of the count < value of the share happening.
- **HMAC rotation = invalidates all signatures.** If you must rotate, plan a maintenance window: add `signed_hash_v2`, run a one-shot resigner, update `verify_signature` to check both during the cutover, drop v1 after.
- **Database constraint > application uniqueness check.** `UNIQUE(user_id, enrollment_id)` is your race-condition firewall. The application-level "did this cert already exist?" check is a fast path; the constraint is the truth.
- **Don't pre-compute PDFs.** Render on demand. Cheap, keeps the template hot-swappable, sidesteps storage management.
- **Reverse-proxy allowlist.** If you use nginx/Caddy with `deny by default`, add `/verify/` and `/api/certificates/` to the allowlist in the same PR as the backend router. New routes that 404 at the edge cause confused issuance reports.
- **CDN / Cloudflare** sometimes intercepts well-known paths or strips OG meta if you've enabled "Email Address Obfuscation" / "Auto Minify" — test the verify page externally (incognito + curl from outside your network) before declaring it done.

---

## 14. Definition of done (Phase 1)

- [ ] User who completes a course sees a confetti modal within 2s of the final tick
- [ ] PDF download works; QR scans to a live verify URL
- [ ] Verify URL renders green ✓ for unmodified certs, red ✗ for tampered/revoked
- [ ] LinkedIn share opens the feed composer with a polished card preview
- [ ] My Certificates section lists the cert with all 4 actions working
- [ ] Tampering the `signed_hash` column manually → red badge (signature mismatch)
- [ ] Admin revoke flips the badge and disables PDF download (410)
- [ ] Re-enrolling in the same course returns the same cert (idempotent)
- [ ] Tier upgrade preserves credential_id and issued_at
- [ ] All unit tests in §10 pass
- [ ] Pinned dep versions in requirements; system libs in Dockerfile

---

## 15. Common traps (learned the hard way)

1. **`==` instead of `compare_digest`** for signature compare — turns the verify badge into a timing oracle.
2. **Microseconds in `issued_at`** when the persisted timestamp gets truncated → re-signing produces a different digest → mysterious red badge on perfectly valid certs.
3. **Including mutable fields (tier, counters) in the signed payload** → every tier upgrade re-signs and breaks the *previous* signature, but you've already shipped LinkedIn shares pointing at it. Don't.
4. **Eager import of WeasyPrint** at app startup → 1–2s startup cost + memory bloat on every container. Lazy import inside the render function.
5. **`weasyprint==latest`** unpinned → silent breakage when `pydyf` minor-bumps. Pin both.
6. **Verify page 404 on signature mismatch** instead of red badge → recruiter assumes the link is broken; the whole "tamper-evident" UX is lost. Always render the page if the row exists.
7. **Rate-limit dict in process memory** with no cap → unbounded memory growth from random crawlers hitting `/verify/{garbage}`. Cap the dict at N keys or use a TTL cache.
8. **OG image returning 404 or non-image MIME** → LinkedIn caches the failure for 7+ days. Use LinkedIn's [Post Inspector](https://www.linkedin.com/post-inspector/) to bust the cache after fixing.
9. **Missing reverse-proxy allowlist entry** for `/verify/` → 404 at the edge but 200 at the origin. Confusing. Add the route in the same PR.
10. **Counter increments not being concurrency-safe** → with two simultaneous PDF downloads, you can lose one increment. Use `UPDATE certificates SET pdf_downloads = pdf_downloads + 1 WHERE id = ?` instead of read-modify-write. Or accept the drift; it's analytics.

---

## 16. What this plan deliberately leaves out

- **Multi-issuer / multi-tenant.** This blueprint assumes one issuer org. Add an `issuer_id` FK + scope the signature payload by issuer if you need it.
- **Blockchain anchoring.** HMAC + a published list of revoked credential IDs gives you all the practical fraud resistance recruiters care about. Skip blockchain unless you have a regulatory requirement.
- **Email-on-issue.** Easy add via your existing transactional email path. Not on the critical path.
- **Bulk admin issue / CSV import.** Nice-to-have for migrating off another platform. Phase 2.
- **Cert templates per course.** Single template is enough for Phase 1; if you have visually distinct programs (bootcamp vs micro-course) add a `template_variant` field on the cert and switch the Jinja template by variant.

---

End of plan. A capable developer (or another Claude session) should be able to ship this in ~6–10 sessions following the build order in §11, with §10's tests as the acceptance gate at each step.
