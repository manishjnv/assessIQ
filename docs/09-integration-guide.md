# 09 — AssessIQ Integration Guide

> **Audience:** Host-app engineer who knows JWT, HTTPS, and iframe basics. No AssessIQ internals required.
> For the AssessIQ-side implementation see `modules/12-embed-sdk/SKILL.md`.

## 1. Overview

AssessIQ can run an assessment inside your application's iframe without redirecting the candidate away from your product. Your backend mints a short-lived signed JWT asserting the candidate's identity; AssessIQ verifies the signature, creates or resumes the candidate's account, and serves the full assessment experience within the frame. **Trust boundary:** your app vouches for the candidate's identity via the JWT signature — AssessIQ trusts the signature, not the iframe origin. The embed surface covers **candidate-take only**: `/embed` → `/take/*` routes. Admin views, results pages, and reviewer surfaces are not reachable via an embed session (frozen decision D1, `modules/12-embed-sdk/SKILL.md:89`).

Intended integrators: HR portals, LMS platforms, and custom HRMS products that want to drive the full assessment experience without building it themselves.

---

## 2. Prerequisites

| Prerequisite | How to fulfil |
|---|---|
| AssessIQ tenant with admin access | Provision via AssessIQ admin or request from your account manager |
| Privacy disclosure confirmed | Settings → Integrations → Privacy. **Required before embed secrets can be created** (D13; `apps/api/src/routes/auth/embed-secrets.ts:71`) |
| Embed secret provisioned | Settings → Integrations → Embed Secrets → New (`POST /api/admin/embed-secrets`) |
| Host origin allow-listed | Settings → Integrations → Embed Origins (`POST /api/admin/embed-origins`) |
| Pack + level + published assessment | Use the AssessIQ admin dashboard authoring flow; the assessment must be published before the embed can start it |
| HTTPS on host app domain | Mandatory — `SameSite=None; Secure` cookies and JWT delivery both require TLS |

Store the embed secret in your backend secret manager. It is shown **once** at creation and is never returned again (`apps/api/src/routes/auth/embed-secrets.ts:95–96`).

---

## 3. The JWT Contract

### Claim table

| Claim | Type | Required | Description | Example |
|---|---|---|---|---|
| `iss` | `string` | no | Issuer label — identifies your service to AssessIQ. Any string. | `"wipro-portal"` |
| `aud` | `string` | no | Must equal `"assessiq"` when present. Recommended. | `"assessiq"` |
| `sub` | `string` | **yes** | Stable user identifier in your system. Stored as `users.metadata.external_id`. Rejection test: T5b (`embed-verify.test.ts:220`) | `"emp-42315"` |
| `tenant_id` | `string` (UUID) | **yes** | Your AssessIQ tenant UUID. Scopes the entire request. Rejection test: T5a (`embed-verify.test.ts:216`) | `"019c8d7e-0001-7f00-8000-wipro0000001"` |
| `email` | `string` | **yes** | Candidate email. Used to find or JIT-create the user. Normalised `lower().trim()`. Rejection test: T5c (`embed-verify.test.ts:224`) | `"alice@wipro.com"` |
| `name` | `string` | **yes** | Candidate display name. | `"Alice Sharma"` |
| `assessment_id` | `string` (UUID) | **yes** | UUID of the published assessment to start. Rejection test: T5d (`embed-verify.test.ts:228`) | `"019c8d7e-face-7f00-8000-assess000001"` |
| `exp` | `number` | **yes** | Expiry (Unix **seconds**). Max `iat + 600` — tokens exceeding 600 s are rejected pre-DB (D5, V3 `embed-verify.test.ts:118`). | `1715444400` |
| `iat` | `number` | **yes** | Issued-at (Unix seconds). Must not be more than 5 s in the future (clock-skew tolerance). Rejection test: T4 (`embed-verify.test.ts:167`) | `1715443800` |
| `jti` | `string` | **yes** | Unique token ID. Burned in Redis on first use; replay with the same `jti` → 401 (T8, `embed-jwt-db.test.ts:383`). Use `crypto.randomUUID()`. | `"550e8400-e29b-41d4-a716-446655440000"` |
| `external_id` | `string` | no | Your HR / employee ID. Echoed in webhook payloads as `user.external_id` for cross-system reconciliation (D9, `SKILL.md:359`) | `"EMP-12345"` |

**Source for required-claim list:** `modules/12-embed-sdk/src/__tests__/embed-verify.test.ts:196–234` (T5a–T5d). Payload shape from `embed-jwt-db.test.ts:143–156`.

**Algorithm:** HS256 only. `alg=none` and RS256 are rejected before any DB call (V1, V2; `embed-verify.test.ts:73–115`). Frozen decision D5 (`SKILL.md:214`).

**Maximum lifetime:** `exp − iat ≤ 600 seconds`. Longer tokens fail pre-DB validation (`embed-verify.test.ts:118–135`). Keep `exp` short — the token is single-use. The session minted from it lives up to 8 hours regardless of token expiry (D6, `session-mint.ts:31`).

### Node.js minting snippet

```js
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

function mintAssessIQEmbedToken({ tenantId, user, assessmentId }) {
  const now = Math.floor(Date.now() / 1000);      // Unix seconds — NOT milliseconds
  return jwt.sign(
    {
      iss: "your-app-name",
      aud: "assessiq",
      sub: String(user.id),                        // your stable user ID
      tenant_id: tenantId,                         // AssessIQ tenant UUID
      email: user.email,
      name: user.fullName,
      external_id: user.employeeId,                // optional — echoed in webhooks
      assessment_id: assessmentId,
      iat: now,
      exp: now + 600,                              // max 600 s; single-use token
      jti: randomUUID(),                           // unique per mint; burned on first use
    },
    process.env.AIQ_EMBED_SECRET,
    { algorithm: "HS256" }
  );
}
```

### curl verification

```bash
# Mint token via Node snippet above, then verify round-trip:
curl -v "https://assessiq.in/embed?token=${TOKEN}"
# Expect: HTTP 302 → /take/a/<attemptId>?embed=true
# Expect: Set-Cookie: aiq_embed_sess=…; SameSite=None; Secure; HttpOnly; Path=/
# Expect: Content-Security-Policy: frame-ancestors https://yourapp.com
```

---

## 4. The Iframe Flow

```
Host app                              AssessIQ
──────────────────────────────────────────────────────────────────
1. User clicks "Take assessment"
2. Host backend mints JWT
   (HS256, exp≤iat+600, fresh jti)
   ──── GET /embed?token=<JWT> ──────────────────────────────────▶
                                  3. Verify JWT (alg, exp, iat, claims,
                                     secret, jti replay cache)
                                  4. Resolve / JIT-create candidate user
                                  5. Mint aiq_embed_sess cookie
                                  6. Build per-tenant CSP frame-ancestors
                                  7. startAttempt(embedOrigin=true)
   ◀──── 302 /take/a/<id>?embed=true  ────────────────────────────
         Set-Cookie: aiq_embed_sess=…; SameSite=None; Secure; HttpOnly
         Content-Security-Policy: frame-ancestors <your-origin>

8. Host frontend renders:
   <iframe src="/embed?token=...">

9. Browser loads SPA in embed mode
   (top nav hidden, compact density)
   ◀── postMessage aiq.ready ──────────────────────────────────────
   ◀── postMessage aiq.height { height: N }  (ResizeObserver)
   ◀── postMessage aiq.attempt.started { attemptId }
            [ candidate takes assessment ]
   ◀── postMessage aiq.attempt.submitted { attemptId, summary }

10. Host hides or replaces iframe
    (Async — AI grading runs server-side)
    ◀── POST <your-webhook-url>  attempt.graded  ──────────────────
11. Host stores result, updates UI
```

**Steps inside `GET /embed` (`apps/api/src/routes/auth/embed.ts:35–108`):**

1. Validates `token` query param present — 400 `MISSING_TOKEN` if absent (`embed.ts:44–48`)
2. `verifyEmbedToken(token)` — rejects bad alg / expired / future iat / missing claim / wrong secret / replayed jti → 401 `INVALID_TOKEN` (`embed.ts:51–58`)
3. `getEmbedOrigins(tenantId)` → `buildEmbedCsp(origins)` → sets `Content-Security-Policy: frame-ancestors <origins>`, removes `X-Frame-Options` (`embed.ts:63–69`)
4. `resolveJitUser()` — finds user by email or creates `role='candidate'` user (`embed.ts:72–77`)
5. `mintEmbedSession()` → writes `sessions` row with `session_type='embed'`, sets cookie (`embed.ts:80–96`)
6. `startAttempt({ embedOrigin: true })` — idempotent; returns existing attempt if already running (`embed.ts:99–103`)
7. `302` redirect to `/take/a/<attemptId>?embed=true` (`embed.ts:107`)

**Cookie attributes** (`session-mint.ts:6–13`):

| Attribute | Value | Reason |
|---|---|---|
| Name | `aiq_embed_sess` | Distinct from `aiq_sess` to prevent scope bleed (D6) |
| `SameSite` | `None` | Mandatory for third-party iframe context (D7) |
| `Secure` | true | Required by browsers whenever `SameSite=None` |
| `HttpOnly` | true | XSS mitigation |
| `Path` | `/` | |
| `Max-Age` | `min(jwtExp − now, 28800)` | 8-hour hard cap; never outlives the JWT credential (`session-mint.ts:63–64`) |

### postMessage protocol

**AssessIQ → Host** (subscribe with `window.addEventListener("message", …)`):

| `type` | Additional fields | When | Notes |
|---|---|---|---|
| `aiq.ready` | `tenantId: string`, `assessmentId: string` | SPA mounted, session verified | Sent to `targetOrigin: '*'` — no secrets; host origin not yet confirmed (`embedBus.ts:80`) |
| `aiq.height` | `height: number` | Every body-height change (ResizeObserver) | Field name is `height`; use `msg.height + "px"` for iframe resize |
| `aiq.attempt.started` | `attemptId: string` | Attempt transitions to `in_progress` | SKILL.md D3 |
| `aiq.attempt.submitted` | `attemptId: string`, `summary: { questions: number, time_used_seconds: number }` | Candidate submits | Grading is async; webhook follows |
| `aiq.error` | `code: "SESSION_EXPIRED"\|"ATTEMPT_NOT_FOUND"\|"NETWORK_ERROR"\|"UNKNOWN"`, `message: string` | User-actionable error in iframe | SKILL.md D3 |
| `aiq.close-blocked` | `reason: "attempt_in_progress"` | Response to host `aiq.close-request` when attempt is live | SKILL.md D3 |

**Host → AssessIQ** (send with `iframe.contentWindow.postMessage(msg, "https://assessiq.in")`):

| `type` | Additional fields | Effect |
|---|---|---|
| `aiq.theme` | `tokens: Record<string, string>` | Runtime CSS overrides. Keys must match `/^--aiq-[a-z][a-z0-9-]*$/`; others silently dropped (D2, `csp-builder.ts:34`) |
| `aiq.locale` | `locale: "en" \| "en-IN" \| "hi-IN"` | Change display language. Unknown locales fall back to `"en"` |
| `aiq.close-request` | — | Request iframe close; AssessIQ responds `aiq.close-blocked` if attempt in progress |

**Minimal postMessage handler:**

```js
const aiqOrigin = "https://assessiq.in";

window.addEventListener("message", (e) => {
  if (e.origin !== aiqOrigin) return;         // always verify origin
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "aiq.height":
      iframe.style.height = msg.height + "px"; // field name is `height`
      break;
    case "aiq.attempt.submitted":
      // grading is async — webhook fires when results are ready
      showToast(`Submitted (attempt ${msg.attemptId})`);
      break;
    case "aiq.error":
      handleEmbedError(msg.code, msg.message);
      break;
    case "aiq.close-blocked":
      showConfirmDialog("A test is in progress. Leave anyway?");
      break;
  }
});
```

### Optional SDK delivery

**npm package** (`packages/embed-sdk/src/index.ts:89–162`):

```bash
npm install @assessiq/embed
```

```js
import { AssessIQEmbed } from "@assessiq/embed";

const embed = AssessIQEmbed.mount("#assessment-container", {
  token: await fetchTokenFromYourBackend(),
  onReady:  () => console.log("loaded"),
  onSubmit: (e) => console.log("submitted", e.attemptId),
  onError:  (e) => console.error(e.code, e.message),
});
// later: embed.destroy()
```

**CDN / no-build alternative:**

```html
<script src="https://assessiq.in/embed/sdk.js"></script>
<script>
  window.AssessIQ.mount("#container", { token: "..." });
</script>
```

`GET /embed/sdk.js` serves a self-contained UMD bundle (≤ 3 KB, `Cache-Control: public, max-age=3600`). Source: `apps/api/src/routes/auth/embed.ts:123`.

---

## 5. Error Responses

### `GET /embed?token=<JWT>` — entry-point errors

All 401 errors from JWT verification share the code `INVALID_TOKEN`; differentiation is in the `message` field (`embed.ts:53–57`).

| Condition | HTTP | `error.code` | JSON body | Recovery | Host or AssessIQ bug? |
|---|---|---|---|---|---|
| `token` param absent | 400 | `MISSING_TOKEN` | `{"error":{"code":"MISSING_TOKEN","message":"token query param required"}}` | Ensure iframe `src` includes `?token=…` | Host bug |
| JWT malformed / unparseable | 401 | `INVALID_TOKEN` | `{"error":{"code":"INVALID_TOKEN","message":"…"}}` | Confirm you are passing the raw JWT string, not base64-encoded or URL-decoded | Host bug |
| Algorithm not HS256 | 401 | `INVALID_TOKEN` | Same 401 shape | Pass `{ algorithm: "HS256" }` to `jwt.sign()` | Host bug |
| Missing required claim | 401 | `INVALID_TOKEN` | Same 401 shape | Check all required claims in §3 claim table are present | Host bug |
| Token expired (`exp ≤ now`) | 401 | `INVALID_TOKEN` | Same 401 shape | Re-mint a fresh token just before rendering the iframe | Host bug |
| `exp − iat > 600 s` | 401 | `INVALID_TOKEN` | Same 401 shape | Reduce token lifetime to ≤ 600 s | Host bug |
| `iat` > 5 s in the future | 401 | `INVALID_TOKEN` | Same 401 shape | Sync server clock (NTP); ensure `iat = Math.floor(Date.now()/1000)` | Host bug |
| Wrong embed secret | 401 | `INVALID_TOKEN` | Same 401 shape | Confirm you are using this tenant's active embed secret | Host bug |
| Token replayed (same `jti`) | 401 | `INVALID_TOKEN` | Same 401 shape | Always generate a fresh `jti: randomUUID()` per mint | Host bug |
| `tenant_id` not found | 401 | `INVALID_TOKEN` | Same 401 shape | Verify your `AIQ_TENANT_ID` env var matches your tenant UUID | Host bug |

**CSP block (no HTTP error):** If the host's domain is not in `embed_origins`, the browser blocks the iframe silently with a console error (`Content-Security-Policy: frame-ancestors`). Fix: `POST /api/admin/embed-origins { "origin": "https://yourapp.com" }`. Source: `embed.ts:63–69`.

### Admin endpoint errors

| `details.code` | HTTP | Endpoint | Meaning |
|---|---|---|---|
| `EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` | 403 | `POST /api/admin/embed-secrets` | Confirm privacy disclosure first: Settings → Integrations → Privacy (`embed-secrets.ts:71–77`) |
| `INVALID_ORIGIN_FORMAT` | 400 | `POST /api/admin/embed-origins` | Origin must be `https://domain.com` or `http://localhost:<port>`. No wildcards, no paths (`embed-admin.ts:73–78`) |
| `NOT_FOUND` | 404 | `DELETE /api/admin/embed-secrets/:id` | Secret already revoked or wrong ID (`embed-secrets.ts:151–155`) |
| `AUTHN_FAILED` | 401 | All admin routes | No session |
| `AUTHZ_FAILED` | 403 | All admin routes | Non-admin role |

---

## 6. Receiving Results Back

AssessIQ fires webhook events to a URL registered in Settings → Integrations → Webhooks. Embed attempts fire the **same event types** as direct magic-link attempts (no new event type needed, D9). Filter for embed traffic using `"embed_origin": true` in the payload (migration `0073_attempt_embed_origin.sql`).

**Event sequence:**
1. `attempt.started` — attempt created and in progress
2. `attempt.submitted` — candidate submitted (grading starts asynchronously)
3. `attempt.graded` — AI grading complete; scores available
4. `attempt.released` — admin published results; candidate and employer can see scores

### Webhook request shape

```
POST <your-registered-url>
Content-Type: application/json
X-AssessIQ-Signature: sha256=<HMAC-SHA256(raw-body, webhook_secret)>
X-AssessIQ-Timestamp: 2026-05-11T10:30:00.000Z
X-AssessIQ-Delivery: <unique-delivery-id>

{
  "event": "attempt.graded",
  "attempt": {
    "id": "att_01jh...",
    "status": "graded",
    "embed_origin": true,
    "user": {
      "id": "usr_01jh...",
      "email": "alice@wipro.com",
      "external_id": "EMP-12345"   ← echoed from JWT external_id claim
    }
  }
}
```

### Signature verification

```js
import crypto from "crypto";

app.post("/webhooks/assessiq", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("X-AssessIQ-Signature");
  const ts  = req.header("X-AssessIQ-Timestamp");

  // Reject if timestamp is more than ±5 minutes away (replay protection)
  if (Math.abs(Date.now() - Date.parse(ts)) > 5 * 60 * 1000)
    return res.status(401).end();

  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.AIQ_WEBHOOK_SECRET)
    .update(req.body)                           // raw bytes — no JSON.parse before verify
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.status(401).end();

  const event = JSON.parse(req.body.toString("utf8"));
  // handle event — must respond 2xx within 10 s; retried up to 5× on non-2xx
  res.status(204).end();
});
```

The webhook secret is stored encrypted in `tenant_settings.webhook_secret` (AES-256-GCM). It is **distinct** from the embed secret — rotation of one never affects the other (`webhook-secret-service.ts:8–9`).

**Rotate webhook secret:** `POST /api/admin/webhook-secrets/rotate` → `200 { plaintextSecret: string, note: string }`. Shown once (`embed-admin.ts:113–118`).

**Polling fallback:** No `/api/embed/attempts/:id` polling endpoint exists in v1 (deferred, D9 `SKILL.md:361`). Use webhooks.

---

## 7. Embed-Secret Rotation

Rotate on a 90-day cadence and immediately on any suspected compromise.

### Planned rotation

1. **Trigger rotation** (admin):
   ```
   POST /api/admin/embed-secrets/:id/rotate
   → 200 { id: string, plaintextSecret: string }
   ```
   The server inserts a new `status='active'` row and sets the old row to `status='rotated'`. Source: `apps/api/src/routes/auth/embed-secrets.ts:101–128`.

2. **Grace window: 24 hours** (default). During this window AssessIQ tries the `active` secret first; if the signature fails, it tries the most-recent `rotated` secret where `rotated_at + grace_hours > now`. Maximum 2 keys tried per request. Configurable per-tenant via `tenant_settings.features.embed.rotation_grace_hours` (integer 1–168; D4, `SKILL.md:196–207`).

3. **Host app picks up the new secret** from your secrets manager and hot-reloads or redeploys. In-flight sessions are unaffected (sessions are validated by cookie, not by the embed secret).

4. **Old secret expires automatically** after the grace window — no cleanup needed.

### Emergency revocation (key compromised)

```
DELETE /api/admin/embed-secrets/:id
→ 204
```

Sets `status='revoked'` with **no grace window**. All JWTs signed with this secret are immediately invalid. Source: `apps/api/src/routes/auth/embed-secrets.ts:131–171`.

After revocation: create a new secret (`POST /api/admin/embed-secrets`), distribute it to your backend, and redeploy.

---

## 8. Embed-Mode UI Differences

When `?embed=true` is detected in the URL (appended automatically by the `/embed` redirect), the SPA adjusts its layout. The flag is URL-only — not stored in cookies or localStorage, so it resets on every navigation (D2, `SKILL.md:107`).

| Element | Embed | Normal |
|---|---|---|
| Top navigation bar | Hidden | Visible |
| Footer | Hidden | Visible |
| Sidebar | Hidden | Visible |
| Padding density | `data-density="compact"` | Default |
| Height reporting | `aiq.height` postMessage on every layout change | None |
| Post-submit navigation | Inline thank-you; does **not** navigate to results page | Navigates to results |
| Theme tokens | Accepts `aiq.theme { tokens }` from host; `/^--aiq-[a-z][a-z0-9-]*$/` keys only (D2) | Not applicable |
| Locale | Accepts `aiq.locale { locale }` from host; falls back to `"en"` for unknown locales | App default |

**Admin and results views are not accessible** from an embed session (D1). An embed cookie presented to any `/api/admin/*` route is rejected `403 AUTHZ_FAILED` regardless of the session's role (`SKILL.md:232`).

**`embed_origin` flag in data pipeline:** Every attempt started via `/embed` has `attempts.embed_origin = TRUE`. This propagates into webhook payloads so you can filter embed traffic from direct magic-link traffic in your analytics or HRMS.

---

## 9. Common Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| `exp` in milliseconds instead of seconds | Every token → 401 expired (AssessIQ sees it as 1000× overdue) | `Math.floor(Date.now() / 1000) + 600`, **not** `Date.now() + 600000` |
| Same `jti` reused | Second load → 401 (replay cache) | Call `randomUUID()` inside the mint function, not once at startup |
| Token minted long before iframe load | 401 if > 600 s elapses between mint and first request | Mint the token on page load, not at login time |
| Host origin not in `embed_origins` | Browser silently blocks iframe; DevTools console shows `frame-ancestors` CSP violation | `POST /api/admin/embed-origins { "origin": "https://yourapp.com" }` |
| Missing `iframe allow` attribute | Assessment may not enter fullscreen | Add `allow="fullscreen"` (`packages/embed-sdk/src/index.ts:119`) |
| Third-party cookie blocked by browser | Iframe loads but every attempt autosave → 401; candidate loses progress | Host domain must be HTTPS. `SameSite=None; Secure` cookies are blocked over plain `http://` except `localhost` |
| Host CSP blocks the iframe | `Refused to frame … because an ancestor violates Content Security Policy` | Add `frame-src https://assessiq.in` to your page's CSP |
| `X-Frame-Options: DENY` from host | Same CSP-style block | Remove `X-Frame-Options` from your page's response headers |
| Algorithm not specified in `jsonwebtoken` | Library defaults to HS256 (safe), but passing `{ algorithm: "RS256" }` → 401 | Pass `{ algorithm: "HS256" }` explicitly or rely on the library default |
| Multiple `AssessIQEmbed.mount()` calls on one page | Multiple independent sessions; memory leak if not destroyed | Call `embed.destroy()` before re-mounting; embed one assessment per page |

---

## 10. Troubleshooting and Support

### Diagnosing a stuck integration

**Step 1 — load the embed URL directly in a browser tab:**

```
https://assessiq.in/embed?token=<YOUR_TOKEN>
```

- `302` redirect → working; proceed to iframe step
- `400 MISSING_TOKEN` → `token` param not in URL
- `401 INVALID_TOKEN` → JWT problem; read `message` in the JSON body
- `302` back to the same URL → cookie not setting (check HTTPS + SameSite=None in a fresh private window)
- Console `frame-ancestors` error → host origin not in `embed_origins`

**Step 2 — health probe:**

```bash
curl https://assessiq.in/embed/health
# → 200 {"status":"ok"}
```

Non-200 here means the embed service is down — not a JWT problem.

**Step 3 — server-side logs:**

JWT verification errors are logged at `warn` level with a sanitised reason (raw token is never logged). Grep for `INVALID_TOKEN` or `resolveJitUser` in the API container logs for the relevant request window.

**Step 4 — dev token minter (non-production only):**

When `ENABLE_EMBED_TEST_MINTER=1` env var is set (never in production):

```
POST /embed/sdk-mint
{ "assessmentId": "<uuid>" }
(admin session required)
→ { token, embedUrl, note }
```

Triple-gated: env var + `NODE_ENV !== 'production'` + admin session (D11, `apps/api/src/routes/auth/embed.ts:173`). The companion test page is at `apps/embed-test/index.html` — mounts the iframe and logs all postMessage events.

**Filing bugs:**

Open an issue via the AssessIQ admin portal. Include: tenant ID (not the embed secret), JWT payload (not the signed token), browser + OS, and the full network trace from DevTools.

---

## Endpoint Reference

| Method | Path | Auth | Purpose | Source |
|---|---|---|---|---|
| `GET` | `/embed?token=<JWT>` | JWT | Verify, mint session, start attempt, redirect `302` | `apps/api/src/routes/auth/embed.ts:35` |
| `GET` | `/embed/health` | none | Liveness probe → `{ status: "ok" }` | `embed.ts:114` |
| `GET` | `/embed/sdk.js` | none | UMD host SDK; registers `window.AssessIQ` | `embed.ts:123` |
| `POST` | `/embed/sdk-mint` | admin session (dev only) | Mint a test JWT | `embed.ts:173` |
| `GET` | `/api/admin/embed-secrets` | admin | List embed secret metadata (envelope never decrypted) | `embed-secrets.ts:37` |
| `POST` | `/api/admin/embed-secrets` | admin + fresh MFA (≤ 15 min) | Create; plaintext returned once | `embed-secrets.ts:51` |
| `POST` | `/api/admin/embed-secrets/:id/rotate` | admin + fresh MFA | Rotate; 24 h grace window | `embed-secrets.ts:101` |
| `DELETE` | `/api/admin/embed-secrets/:id` | admin + fresh MFA | Revoke immediately (no grace) | `embed-secrets.ts:131` |
| `GET` | `/api/admin/embed-origins` | admin | List `tenants.embed_origins[]` | `embed-admin.ts:44` |
| `POST` | `/api/admin/embed-origins` | admin | Add origin (`https://` or `http://localhost:…`) | `embed-admin.ts:60` |
| `DELETE` | `/api/admin/embed-origins` | admin | Remove origin; origin in request body | `embed-admin.ts:88` |
| `POST` | `/api/admin/webhook-secrets/rotate` | admin | Rotate HMAC signing secret; returned once | `embed-admin.ts:107` |

---

## Security Checklist

- [ ] Embed secret lives **only** in your backend env/secrets manager — never in frontend code, git, or logs
- [ ] Webhook secret verified on every inbound delivery — never trust the payload without the HMAC check
- [ ] `exp ≤ iat + 600` (10 minutes max)
- [ ] Fresh `jti: randomUUID()` on every mint
- [ ] Token minted close to page-load time, not at session-start
- [ ] Host CSP includes `frame-src https://assessiq.in` on embed pages only
- [ ] `iframe.contentWindow.postMessage` origin pinned to `"https://assessiq.in"` — never `"*"`
- [ ] `e.origin === "https://assessiq.in"` checked on every inbound postMessage
- [ ] Rotate embed secret every 90 days; revoke immediately on compromise
- [ ] Restrict AssessIQ API key scopes to the minimum your integration requires
