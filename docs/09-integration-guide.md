# 09 — Integration Guide

> How a host application (Wipro internal tool, client product) integrates AssessIQ as an embedded feature. Two paths: **iframe embed** for UI integration, **REST + webhooks** for back-end automation.

## Choose your integration mode

| Mode | Pick when |
|---|---|
| **Iframe embed** | You want users to *take* assessments inside your app's UI without leaving. Host owns the flow; AssessIQ owns the assessment screen. |
| **REST + webhooks** | You want AssessIQ to be a system-of-record behind your own UI — your app shows summary cards, AssessIQ does the work, you receive results via webhook. |
| **Both** | Common for enterprise — embed for the candidate experience, REST for HR/manager-facing summary screens. |

## Setup checklist (one-time per tenant)

For the AssessIQ admin (yours):
- [ ] Create the host app's tenant (or share an existing one)
- [ ] Generate an embed secret (Settings → Integrations → Embed Secrets → New)
- [ ] Generate an API key with required scopes (Settings → Integrations → API Keys → New)
- [ ] Register webhook endpoint(s) the host app exposes (Settings → Integrations → Webhooks)
- [ ] Allow-list the host's frame origin (Settings → Integrations → Embed Origins)

For the host app developer:
- [ ] Store embed secret in your backend secret manager (never in frontend code)
- [ ] Store API key the same way
- [ ] Configure webhook receiver endpoint with HMAC verification
- [ ] If iframing: prepare your UI for `aiq.height` postMessage events (auto-resize) and `aiq.attempt.submitted` (your "what to do after submit" handler)

---

## Path A — Iframe embed

### High-level flow

```
1. User clicks "Take SOC L1 Assessment" in your app
2. Your backend mints a JWT with the user's identity + assessment_id
3. Your frontend renders <iframe src="...assessiq.../embed?token=...">
4. Candidate completes assessment inside the iframe
5. AssessIQ posts iframe-height updates and a final 'submitted' event
6. (Async) AssessIQ POSTs a webhook to your endpoint when grading completes
7. Your app updates its own database with the result; renders summary
```

### Token issuance

```javascript
// Node.js example — your app's backend
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

export function buildAssessIQEmbedUrl(user, assessmentId) {
  const payload = {
    iss: "your-app-name",                       // identifies you to AssessIQ
    aud: "assessiq",
    sub: String(user.id),                       // your user ID
    tenant_id: process.env.AIQ_TENANT_ID,       // AssessIQ tenant UUID
    email: user.email,
    name: user.fullName,
    external_id: user.employeeId,               // optional; flows back in webhook
    assessment_id: assessmentId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,   // 10 min validity
    jti: randomUUID()
  };
  const token = jwt.sign(payload, process.env.AIQ_EMBED_SECRET, { algorithm: "HS256" });
  return `https://assessiq.automateedge.cloud/embed?token=${encodeURIComponent(token)}`;
}
```

**Token lifetime:** keep `exp` short (10 minutes is plenty). Once the token is exchanged for an AssessIQ session cookie, the cookie carries the rest of the work; the token is single-use.

**Token claims used by AssessIQ:**
| Claim | Required | Purpose |
|---|---|---|
| `aud` | yes | Must equal `"assessiq"` |
| `tenant_id` | yes | UUID of your AssessIQ tenant |
| `sub` | yes | Stable identifier from your system |
| `email` | yes | Used to find/create AssessIQ user |
| `name` | yes | Display name |
| `external_id` | no | Echoed in webhooks for cross-system reconciliation |
| `assessment_id` | yes | Which assessment to take |
| `exp` | yes | Standard JWT expiration |
| `jti` | yes | Replay protection (must be unique) |

### Iframe HTML

```html
<!-- in your app -->
<div id="aiq-host" style="width:100%; min-height:600px;"></div>
<script>
  (async function() {
    const url = await fetch("/your-backend/aiq-token?assessment=L1-Q2").then(r => r.text());
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.style.cssText = "width:100%; height:600px; border:0; border-radius:8px;";
    iframe.allow = "clipboard-read; clipboard-write";
    iframe.title = "Skills Assessment";
    document.getElementById("aiq-host").appendChild(iframe);

    // Listen for messages from AssessIQ
    window.addEventListener("message", (e) => {
      if (e.origin !== "https://assessiq.automateedge.cloud") return;
      const msg = e.data;
      switch (msg.type) {
        case "aiq.height":
          iframe.style.height = msg.px + "px";
          break;
        case "aiq.attempt.started":
          // optionally render a "in progress" pill in your own UI
          break;
        case "aiq.attempt.submitted":
          // candidate just submitted — show your own confirmation, hide iframe, etc.
          // grading happens async; webhook will follow when results are ready
          showSubmittedToast(msg.attemptId);
          break;
      }
    });
  })();
</script>
```

### postMessage protocol reference

**AssessIQ → host:**
```ts
{ type: "aiq.height", px: number }                                  // auto-resize
{ type: "aiq.attempt.started", attemptId: string }
{ type: "aiq.attempt.submitted", attemptId: string, summary: { questions: number, time_used_seconds: number } }
{ type: "aiq.error", code: string, message: string }                // user-actionable error inside iframe
```

**Host → AssessIQ:**
```ts
{ type: "aiq.theme", tokens: Record<string, string> }               // runtime theming overrides
{ type: "aiq.locale", locale: string }                              // 'en', 'hi-IN', etc.
{ type: "aiq.close-request" }                                       // host wants to close; iframe responds with confirmation if attempt in progress
```

All messages use string-literal `type` discriminator. AssessIQ silently drops unknown types. Origin checks both ways: AssessIQ verifies parent origin against `tenant.embed_origins`, host should verify `e.origin` matches AssessIQ.

---

## Path B — REST + webhooks

For backend integrations where your app drives the flow programmatically.

### Authentication

```http
Authorization: Bearer aiq_live_<your-key>
```

Issued via Settings → Integrations → API Keys, scoped to:
- `assessments:read` / `assessments:write`
- `users:read` / `users:write`
- `attempts:read` / `attempts:write`
- `results:read`

### Common operations

**Provision a candidate**
```http
POST /api/admin/users
{ "email":"jane.doe@x.com", "name":"Jane Doe", "role":"candidate", "metadata":{"external_id":"EMP-12345"} }
→ 201 { "id":"u_..." }
```

**Create an assessment programmatically**
```http
POST /api/admin/assessments
{ "pack_id":"pack_soc_2026q2", "level_id":"lvl_soc_l1", "name":"...", "question_count":12 }
→ 201 { "id":"assess_..." }
POST /api/admin/assessments/assess_.../publish
POST /api/admin/assessments/assess_.../invite { "user_ids":["u_..."] }
```

**Read results**
```http
GET /api/admin/attempts/att_...
→ 200 { ... full attempt with gradings ... }
```

### Webhooks

Events:
- `attempt.started`
- `attempt.submitted`
- `attempt.graded`
- `attempt.released`
- `assessment.published`
- `assessment.closed`
- `user.created`

**Receiver requirements:**
- Respond `2xx` within 10 seconds (else considered failed)
- Verify `X-AssessIQ-Signature` (HMAC-SHA256 of raw body using webhook secret)
- Verify `X-AssessIQ-Timestamp` is within ±5 minutes (replay window)
- Idempotent — same `X-AssessIQ-Delivery` ID may be retried up to 5 times

**Verification example:**
```js
import crypto from "crypto";

app.post("/webhooks/assessiq", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("X-AssessIQ-Signature");
  const ts = req.header("X-AssessIQ-Timestamp");

  if (Math.abs(Date.now() - Date.parse(ts)) > 5 * 60 * 1000) return res.status(401).end();

  const expected = "sha256=" + crypto.createHmac("sha256", process.env.AIQ_WEBHOOK_SECRET)
                                     .update(req.body)
                                     .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(401).end();

  const event = JSON.parse(req.body.toString("utf8"));
  // ... persist, dispatch, etc. — must finish within 10s ...
  res.status(204).end();
});
```

---

## Combined pattern (recommended for production)

Most enterprise integrations use both paths together:

```
HOST APP                              ASSESSIQ
  │                                       │
  │  (admin) POST /admin/users            │  Provision candidate from HRMS sync
  ├──────────────────────────────────────▶│
  │                                       │
  │  (admin) POST /admin/assessments      │  Create assessment matching HRMS skill check
  ├──────────────────────────────────────▶│
  │                                       │
  │  (admin) POST /assessments/:id/invite │  Invite candidates en masse
  ├──────────────────────────────────────▶│
  │                                       │
  │  (user)   GET /your-app/skill-check   │  User opens host app
  │    └─ host backend mints JWT          │
  │    └─ renders iframe to /embed        │
  ╔═════════════════════════════════════════════╗
  ║  iframe — candidate takes assessment        ║
  ╚═════════════════════════════════════════════╝
  │                                       │
  │  (event) attempt.submitted via iframe │  Host updates its UI immediately
  │◀──────────────────────────────────────┤
  │                                       │
  │  (webhook) attempt.graded             │  Host stores final score, fires HRMS update
  │◀──────────────────────────────────────┤
  │                                       │
  │  (admin) GET /admin/reports/cohort    │  Manager views cohort report for sign-off
  ├──────────────────────────────────────▶│
```

## Errors the host app must handle

| Error | When | Host action |
|---|---|---|
| `embed_token_expired` | Iframe loaded with expired JWT | Re-mint and reload |
| `embed_token_invalid` | Bad signature or missing claims | Surface error; check secret rotation |
| `embed_origin_blocked` | Frame origin not in tenant allow-list | Add origin in AssessIQ admin |
| `attempt_already_submitted` | User retries after submission | Show summary, don't allow re-attempt |
| `assessment_not_open` | Outside opens_at/closes_at window | Show closed-state banner |
| `webhook_signature_invalid` | Host rejects delivery | AssessIQ retries 5x then alerts admin |

## Testing your integration

1. **Sandbox tenant** — request a sandbox tenant from AssessIQ admin; isolated data, free of charge for integration testing
2. **Webhook testing** — use the *Settings → Webhooks → Send test event* button to dispatch a synthetic payload to your endpoint
3. **Embed test page** — `https://assessiq.automateedge.cloud/embed-test` accepts a JWT and shows verification result without rendering the SPA — useful for token-debugging
4. **API exploration** — full OpenAPI spec at `https://assessiq.automateedge.cloud/api/openapi.yaml` (auth required)

## Security must-do

- [ ] Embed secret and API key live ONLY in your backend env, never in frontend code or git
- [ ] Webhook secret verified on every inbound request — never trust the payload otherwise
- [ ] Embed token `exp` ≤ 10 minutes
- [ ] Use a unique `jti` per token (`crypto.randomUUID()` is fine)
- [ ] Rotate embed secrets every 90 days; AssessIQ supports overlap with grace period
- [ ] Restrict your AssessIQ API key scopes to the minimum needed
- [ ] In your CSP, allow `frame-src https://assessiq.automateedge.cloud` only on pages that need it
- [ ] Pin the postMessage origin check to the exact AssessIQ URL — never use `*`
