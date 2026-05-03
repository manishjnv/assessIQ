# 12-embed-sdk — Iframe embed + JS snippet + postMessage protocol

> See `docs/09-integration-guide.md` for the host-side perspective. This skill is the AssessIQ-side implementation.

## Purpose
Make AssessIQ embeddable as a feature in any host application. Iframe-based UI embed + JS helper snippet for host devs.

## Scope
- **In:** `/embed?token=<JWT>` route (verify, mint session, render SPA in embed mode), postMessage emitter (height, attempt events), origin allow-list enforcement, embed-mode detection in SPA, optional NPM package `@assessiq/embed` for host devs (token mint helper, iframe wrapper).
- **Out:** standalone web app routing (those live in 11/10).

## Dependencies
- `00-core`, `02-tenancy`, `01-auth` (embed JWT verification)
- `11-candidate-ui` (renders inside the embed mode)

## Public surface

### Server (Fastify route)
```
GET /embed?token=<JWT>
  → verify HS256 against tenant.embed_secrets
  → check exp, jti not in replay cache
  → resolve user (find by email or JIT-create if tenant.allow_jit_user)
  → mint session cookie
  → 302 to /take/a/<attemptId>?embed=true
  (or 200 with HTML if attempt not yet started)
```

### Client (in SPA)
```ts
import { embedBus } from "modules/12-embed-sdk/client";
embedBus.emit("aiq.height", { px: document.body.scrollHeight });
embedBus.emit("aiq.attempt.started", { attemptId });
embedBus.emit("aiq.attempt.submitted", { attemptId, summary });

embedBus.on("aiq.theme", ({ tokens }) => applyThemeOverrides(tokens));
embedBus.on("aiq.locale", ({ locale }) => setLocale(locale));
```

The bus wraps `window.parent.postMessage` with origin verification (against tenant's `embed_origins`). Outside embed mode it's a no-op.

### Helper NPM package (`@assessiq/embed`)
```ts
import { mintEmbedToken, AssessIQIframe } from "@assessiq/embed";

// server-side
const url = mintEmbedToken({ secret, tenantId, user, assessmentId });

// client-side — React component
<AssessIQIframe url={url} onSubmitted={(a) => ...} onError={(e) => ...} />
```

This package does the JWT signing (Node only) and the iframe + postMessage plumbing (browser). Optional convenience for host teams.

## Embed-mode SPA differences
When `?embed=true` is detected at SPA load:
- Hide top nav, footer, side bar
- Compress padding (`data-density="compact"`)
- Listen for theme + locale messages from parent
- Emit height messages on layout changes (ResizeObserver on `<body>`)
- On submit: emit `aiq.attempt.submitted`, show inline thank-you, do NOT navigate to results page (host decides next step)

## Origin security
- AssessIQ verifies parent origin via `e.origin` on every inbound message
- Host should verify AssessIQ origin on inbound messages
- Tenant config has `embed_origins: string[]` — populated in admin UI; mismatched origin → no message processing
- Embed JWT carries no powers without server verification — never trust the token alone for sensitive operations

## Help/tooltip surface
- `admin.integrations.embed-secrets.create` — first-time setup walkthrough
- `admin.integrations.embed-origins.add` — what to enter (origin spec)
- `admin.integrations.test-embed` — link to embed-test page
- `admin.integrations.npm-package` — pointer to `@assessiq/embed`

## Open questions
- Public NPM publication for `@assessiq/embed` — defer until first external integration is real
- Pre-built React/Vue/Angular wrappers — start with framework-agnostic; add wrappers if requested

---

## Decisions captured (2026-05-03)

> **Phase 4 pre-flight.** Every decision below was locked before the 12-embed-sdk implementation session opened. Phase 4 builds against these as a frozen contract. The embed JWT wire format and replay-cache mechanics from `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01) are inherited by reference and NOT re-stated here; only embed-SDK-specific decisions appear below.
>
> Source shorthand: `01-AUTH` = `modules/01-auth/SKILL.md` § Decisions captured (2026-05-01); `04-AUTH` = `docs/04-auth-flows.md`; `09-INT` = `docs/09-integration-guide.md`; `02-DATA` = `docs/02-data-model.md`; `03-API` = `docs/03-api-contract.md`; `BRAIN` = `PROJECT_BRAIN.md`.

---

### D1 — Embed surface scope

**Decision.** Phase 4 exposes **candidate-take-only** in embed mode. The embed surface covers `/take/*` routes (magic-link landing, assessment start, answer autosave, submit, timer). Admin views (`/admin/*`), reviewer views, and standalone result/score views are NOT exposed in embed mode in v1. The `/embed?token=<JWT>` handler verifies the JWT, mints a session with `role='candidate'`, and redirects to `/take/a/<attemptId>?embed=true` (or to the appropriate `/take/<token>` entry for a fresh start). No other route subtree is reachable via an embed session.

**What changed vs. the source docs.** `BRAIN` describes the embed surface without specifying which AssessIQ route trees are available inside the iframe. `04-AUTH` Flow 3 describes the `/embed` handler but does not bound the post-redirect surface. This decision explicitly bounds it.

**Rationale.** Admin views in embed mode would delegate admin-role capabilities to a host-controlled iframe — an iframe that inherits the host page's CSP and postMessage vectors. That is a credentials-delegation risk, not a productivity gain. Result/score views require a separate authorization model (has the attempt been `released`? has the candidate consented to their employer seeing scores?); embedding them before that model is designed risks premature disclosure. Candidate-take-only is the narrowest scope that delivers the stated value: host apps embed the assessment-taking experience, receive results via webhook (D9), and render their own summary UI.

**Alternatives rejected.** (a) Admin views in embed mode — rejected for attack-surface reasons above. (b) Released-result view in embed mode post-submit — deferred; the host already receives results via `attempt.graded` webhook; a redundant embed-results view adds scope without architectural value. (c) A public embed without JWT — rejected; every embed request must carry a signed JWT to establish tenant context and prevent open read-access.

**Downstream impact.** `11-candidate-ui` adds `?embed=true` detection. `10-admin-dashboard` requires no embed toggle. If admin-view embedding is ever needed (v2), it is a new role claim in the embed JWT — the route layer already role-checks every request, so the unlock is additive.

---

### D2 — `?embed=true` toggle + theme overrides

**Decision.**

- **Route scope.** Only routes under `/take/*` and the `/embed` entry-point honor `?embed=true`. The SPA reads the flag from the URL query at load time: hide top nav / footer / sidebar, set `data-density="compact"`, start ResizeObserver, wire postMessage listeners. The flag is NOT stored in cookies or localStorage — it resets on every navigation (embed mode is per-session, not a persistent preference). The `/embed` handler appends `?embed=true` when redirecting to `/take/...`.

- **Theme token keys.** Inbound `aiq.theme` postMessage tokens are validated against `/^--aiq-[a-z][a-z0-9-]*$/` before `applyThemeOverrides()` is called. Only CSS custom properties in the `--aiq-*` namespace are accepted; all others are silently dropped. This supports the full design-token palette from `docs/10-branding-guideline.md` (`--aiq-color-primary`, `--aiq-color-surface`, `--aiq-color-text`, `--aiq-radius`, etc.) while preventing CSS injection via non-property keys.

- **Embed origins source.** `tenants.embed_origins TEXT[] NOT NULL DEFAULT '{}'` — added by Phase 4 migration `0070_embed_origins.sql` (not yet in the schema as of Phase 3). Values are `scheme+host[+port]` strings (e.g. `"https://portal.wipro.com"`, `"https://localhost:3000"`). The `/embed` handler reads `embed_origins` from the tenant row and (a) uses it for inbound postMessage origin verification and (b) sets `Content-Security-Policy: frame-ancestors` per D8. Origins are bootstrapped into the SPA via `window.__AIQ_EMBED_CONFIG__ = { allowedOrigins: [...] }` injected as an inline JSON script block in the HTML shell response — no extra API call needed client-side.

- **Locale token.** `aiq.locale` is accepted in addition to `aiq.theme`. Locale values are validated against `['en', 'en-IN', 'hi-IN']` (v1 allowlist, extensible). Unknown locales fall back to `'en'` silently.

**Source.** `BRAIN` § Frontend SPA; `09-INT` § postMessage protocol reference; `docs/10-branding-guideline.md` (CSS var namespace).

**Rationale.** URL-query flag avoids cookie proliferation and localStorage-persistence bleed. The CSS-namespace regex closes the CSS-injection vector: restricting to `/^--aiq-[a-z][a-z0-9-]*$/` is a one-line guard with zero false-negative risk for legitimate theme tokens.

**Alternatives rejected.** (a) An explicit allowlist of token keys — too rigid; new tokens in `17-ui-system` would require a SKILL.md edit. (b) Fetching embed_origins from the API after SPA load — an extra RTT and a race condition before the first postMessage arrives.

**Downstream impact.** `16-help-system` tooltip drawer renders inside the embed viewport; it uses CSS custom properties so it inherits overridden tokens automatically. `17-ui-system` token docs should note the `--aiq-*` namespace convention when writing Phase 4 tokens.

---

### D3 — postMessage protocol (full TypeScript pin)

**Decision.** The following types define the complete v1 message protocol. Phase 4 must not add message types without a corresponding addendum entry.

```ts
// ── AssessIQ → Host (outbound) ──────────────────────────────────────────────

/** Sent once after SPA mount + session verification. Carries no secrets. */
type AiqReadyMessage = { type: "aiq.ready"; tenantId: string; assessmentId: string };

/** Sent on every body-height change (ResizeObserver on document.body). */
type AiqHeightMessage = { type: "aiq.height"; px: number };

/** Sent when the attempt transitions to in_progress. */
type AiqAttemptStartedMessage = { type: "aiq.attempt.started"; attemptId: string };

/** Sent on candidate submit. Grading is async; webhook follows (D9). */
type AiqAttemptSubmittedMessage = {
  type: "aiq.attempt.submitted";
  attemptId: string;
  summary: { questions: number; time_used_seconds: number };
};

/** User-actionable errors inside the iframe (session expired, network error). */
type AiqErrorMessage = {
  type: "aiq.error";
  code: "SESSION_EXPIRED" | "ATTEMPT_NOT_FOUND" | "NETWORK_ERROR" | "UNKNOWN";
  message: string;
};

/** Response to aiq.close-request when an attempt is in progress. Host should confirm. */
type AiqCloseBlockedMessage = { type: "aiq.close-blocked"; reason: "attempt_in_progress" };

type AiqOutboundMessage =
  | AiqReadyMessage | AiqHeightMessage | AiqAttemptStartedMessage
  | AiqAttemptSubmittedMessage | AiqErrorMessage | AiqCloseBlockedMessage;

// ── Host → AssessIQ (inbound) ───────────────────────────────────────────────

/** Runtime theme overrides. Keys validated against /^--aiq-[a-z][a-z0-9-]*$/ (D2). */
type AiqThemeMessage = { type: "aiq.theme"; tokens: Record<string, string> };

/** Change display locale (validated against allowlist). */
type AiqLocaleMessage = { type: "aiq.locale"; locale: "en" | "en-IN" | "hi-IN" };

/** Host wants to close the iframe (user navigates away, parent app closes modal). */
type AiqCloseRequestMessage = { type: "aiq.close-request" };

type AiqInboundMessage = AiqThemeMessage | AiqLocaleMessage | AiqCloseRequestMessage;
```

**Origin verification rule (in `embedBus` client module).**

- **Inbound:** `if (e.origin not in window.__AIQ_EMBED_CONFIG__.allowedOrigins) → silently drop` all messages.
- **Outbound:** use `targetOrigin` set to the LAST verified inbound message origin. Exception: `aiq.ready` uses `targetOrigin: '*'` because the host origin is unknown at mount time. `aiq.ready` carries no secret data (tenantId and assessmentId are already in the URL). The `embedBus` module keeps a module-level `verifiedParentOrigin: string | null`; all outbound messages after the first verified inbound use it.
- `embedBus.emit()` and `embedBus.on()` from `## Public surface` remain the contract surface; these types add the type-level spec.

**Source.** `09-INT` § postMessage protocol reference; `04-AUTH` Flow 3; `BRAIN` embed surface description.

**Rationale.** `aiq.ready` with `targetOrigin: '*'` is a deliberate trade-off: the message carries no secrets (token is already burned server-side), and the host needs a reliable handshake signal. `aiq.close-blocked` makes the close flow bidirectional — host apps can show a "leave during assessment?" dialog instead of abruptly tearing down the iframe.

**Alternatives rejected.** (a) A dedicated `aiq.resize` inbound type — rejected; redundant with proactive `aiq.height` emissions from ResizeObserver. (b) `aiq.cancel` as separate from `aiq.close-request` — rejected; identical semantics, one type. (c) A pre-shared `aiq.hello` handshake before `aiq.ready` — rejected; adds host-side complexity with no security benefit (security is in the JWT, not postMessage).

**Downstream impact.** `embedBus` in `modules/12-embed-sdk/src/client/` is the ONLY source for `window.parent.postMessage` calls in the SPA. Direct `postMessage` from `modules/11-candidate-ui/` is forbidden; all cross-frame communication must route through `embedBus`.

---

### D4 — Key rotation procedure

**Decision.**

- **Trigger.** Admin clicks "Rotate" on an embed secret → `POST /api/admin/embed-secrets/:id/rotate` → server inserts a new row (`status='active'`), sets old row `status='rotated'`, `rotated_at=now()`.
- **Grace window.** **24 hours default.** Configurable per-tenant via `tenant_settings.features` JSONB path `.embed.rotation_grace_hours` (integer, 1–168; default 24). No new column on `embed_secrets`; grace is derived as `rotated_at + <grace_hours> hours > now()`.
- **Verification during grace.** `verifyEmbedToken` (01-AUTH §5) tries `status='active'` first; if signature fails, tries the most-recent `status='rotated'` secret WHERE the derived grace condition passes. Max 2 keys tried. Secrets outside the grace window are treated as revoked even if `status='rotated'`.
- **Revocation.** A new `status='revoked'` terminal state is added (Phase 4). The verify path only tries `status IN ('active', 'rotated')`. Setting `status='revoked'` is an immediate hard-stop with no grace window.
- **No `grace_ends_at` column.** The grace window is derived at query time from `rotated_at + interval '<grace_hours> hours'`. This keeps the schema minimal; the derive is O(1) SQL arithmetic.

**Source.** `01-AUTH` §5 (two-key rotation, max 2 keys); `04-AUTH` Flow 3 ("Rotate every 90 days"); `03-API` embed-secrets rotate endpoint.

**Rationale.** 24h is security-forward: hosts that cannot rotate within 24 hours have a process problem worth surfacing. The per-tenant JSONB override accommodates the rare enterprise scenario where 24h is too aggressive (max 168h = 7 days). Derived grace avoids a separate background job to expire rotated keys.

**Conflict with 01-AUTH §5 phrasing.** `01-AUTH` §5 uses "90-day rotation grace." `04-AUTH` Flow 3 says "Rotate every 90 days; revoke immediately on suspected compromise." The 90-day figure in both sources refers to the **rotation cadence** (how often to rotate), not the **grace window** (how long the old key is valid after rotation). The 01-AUTH §5 code contract sets no specific grace duration — it only specifies the two-key max and the try-active-then-try-rotated logic. This session pins 24h as the Phase 4 default. **Flag for user review before Phase 4 starts:** if the intent was a 90-day grace window (not cadence), override `rotation_grace_hours` to 2160 in `tenant_settings.features.embed`.

**Downstream impact.** `tenant_settings.features` JSONB gains `.embed.rotation_grace_hours` path in application code (no migration column needed — JSONB path is set at runtime). Phase 4 admin UI adds a grace-window input in the embed-secrets rotation modal. The Phase 4 session handoff must document the 24h default in `docs/04-auth-flows.md` § Token & secret standards.

---

### D5 — Replay cache horizon

**Decision.** The embed JWT replay cache `aiq:embed:jti:<jti>` has a **maximum TTL of 600 seconds**. This follows directly from the frozen 01-AUTH §5 constraint: `exp - iat <= 600s`. Any JWT with `exp - iat > 600s` is rejected at claim-validation, before replay cache lookup. Therefore no Redis key for an embed JTI will ever live longer than 10 minutes. No additional replay-cache constraint is needed in Phase 4; this decision documents the calculation explicitly.

**Memory exposure bound.** At a sustained theoretical rate of 10,000 mints/second (implausible without credential theft detectable at the rate-limiter), the JTI cache accumulates at most `10,000 × 600 = 6,000,000` keys × ~100 bytes ≈ 600 MB worst case — within Redis operational bounds and detectable via rate-limiting long before it becomes a problem.

**Source.** `01-AUTH` §5 (`exp - iat <= 600s enforced`; `TTL = floor(exp - now)`).

**Rationale.** This is a validation of the frozen 01-AUTH contract, not a new constraint. Short JWT lifetimes minimize the window for stolen-token replay. The host re-mints per candidate session (a per-assessment action, not per-request), so there is no user-friction reason to lengthen the window.

**Downstream impact.** None; `verifyEmbedToken` in `01-auth` already enforces this. Phase 4 implementation inherits it unchanged.

---

### D6 — Embed session duration

**Decision.** Embed sessions follow the **standard session lifetime** from `01-AUTH` §1: 8h max hard expiry, 30-minute idle eviction (`now - lastSeenAt > 30min`). The embed JWT `exp` (max 600s) is NOT the session lifetime — it is the single-use token's validity window. Once the JWT is verified and burned (JTI cached), it is irrelevant to the resulting session's duration.

**Cookie name.** `aiq_embed_sess` (distinct from `aiq_sess`). Redis key: `aiq:embed:sess:<sha256(cookie)>` (separate namespace). Postgres `sessions` table stores both under the same schema; a new `session_type TEXT NOT NULL DEFAULT 'standard' CHECK (session_type IN ('standard','embed'))` column distinguishes them — added by Phase 4 migration `0071_tenants_embed_metadata.sql`.

**Embed session isolation.** `aiq_embed_sess` is valid ONLY for `/take/*` and `/api/me/*` routes. `sessionLoader` middleware is extended to: (1) try `aiq_embed_sess` first when the request path is under `/take/*` or `/api/me/*`; (2) try `aiq_sess` for all `/api/auth/*`, `/api/admin/*` requests. An embed session presented to an `/api/admin/*` endpoint is rejected `403 AUTHZ_FAILED` regardless of the session document's role — structural guard, defence-in-depth.

**Source.** `01-AUTH` §1 (session lifecycle, 8h sliding, 30min idle); `04-AUTH` Flow 2b (`totpVerified=true`, `role='candidate'` for candidate sessions).

**Rationale.** Session-lifetime = JWT-exp would expire the candidate's session 10 minutes after the iframe loads, breaking any assessment longer than 10 minutes. The correct model: JWT is a one-time auth credential; the session it mints follows the same lifecycle as any other candidate session. The 30-minute idle eviction is a non-issue in practice — the attempt engine autosaves every 5 seconds, which extends `lastSeenAt` continuously during an active attempt.

**Alternatives rejected.** (a) JWT-exp as session lifetime — breaks assessments longer than 10 minutes. (b) Configurable embed session TTL per tenant — deferred; the standard 8h/30min rules cover all realistic assessment durations. (c) No `session_type` column — rejected; auditing embed vs. standard sessions requires distinguishing them; a column is unambiguous.

**Downstream impact.** Phase 4 touches `modules/01-auth/` (sessionLoader changes, SameSite=None cookie option). Per CLAUDE.md load-bearing-paths rule, these changes require Opus diff review + `codex:rescue` adversarial sign-off before push. This is the primary load-bearing Phase 4 change in `01-auth`.

---

### D7 — Cross-origin cookies

**Decision.**

- **Cookie name.** `aiq_embed_sess`.
- **Cookie flags.** `HttpOnly; Secure; SameSite=None; Path=/`.
- **Why `SameSite=None`.** In a third-party iframe context (host at `portal.wipro.com`, AssessIQ at `assessiq.automateedge.cloud`), browsers treat the AssessIQ cookie as third-party. `SameSite=Lax` cookies are NOT sent in cross-site subframe requests — the session cookie would be silently absent on every API call from within the iframe. `SameSite=None; Secure` is the only portable mechanism for third-party cookies as of 2026 (Chrome, Firefox, Safari all enforce this).
- **`aiq_sess` unchanged.** The standard admin/candidate `aiq_sess` cookie retains `SameSite=Lax; HttpOnly; Secure; Path=/`. It provides CSRF protection for the admin panel; this must not be weakened.
- **CSRF on embed routes.** Because `aiq_embed_sess` is `SameSite=None`, state-changing embed requests (POST/PATCH on `/take/*`, `/api/me/*`) MUST validate the `Origin` header: reject any state-changing request whose `Origin` does not equal `https://assessiq.automateedge.cloud`. This is effective because the `Origin` header is not forgeable by the attacker's page (cross-origin iframes cannot spoof `Origin`). This replaces the standard double-submit CSRF cookie for embed routes.

**Source.** `04-AUTH` § Session cookie spec (`aiq_sess` flags); RFC 6265bis § 5.3.7 (SameSite=None requires Secure).

**Rationale.** Third-party iframe = third-party cookie. The separate cookie name enforces structural isolation: no code path can accidentally accept an `aiq_embed_sess` on an admin endpoint. Origin-header CSRF for embed routes is appropriate because the iframe always runs on `assessiq.automateedge.cloud`, not on the host origin.

**Alternatives rejected.** (a) Token-based auth (session ID in URL / postMessage) — URL session IDs leak in referrer headers and browser history; postMessage session revival re-introduces the JTI-replay problem at the session level. (b) Using `aiq_sess` with `SameSite=None` — widens blast radius of a stolen embed cookie to the admin panel.

**Downstream impact.** `01-auth` `sessions.create()` gains a `sameSiteNone: boolean` option; embed handler passes `true`; all other callers omit it (defaults to `false`). Caddy global policy does NOT rewrite cookies from the upstream — standard Caddy reverse-proxy mode passes `Set-Cookie` headers unchanged — so the `SameSite=None` attribute set by Fastify reaches the browser intact. Phase 4 deploy step must verify this with `curl -I /embed?token=...` and confirm `Set-Cookie: aiq_embed_sess=...; SameSite=None; Secure`.

---

### D8 — CSP `frame-ancestors` per-tenant override

**Decision.**

- **Current state (Phase 3 live, production-blocking for embed).** The global Caddy `security-headers` snippet includes `Content-Security-Policy: frame-ancestors 'none'` (confirmed in `docs/06-deployment.md` § "What's live"). This BLOCKS all iframe embedding of AssessIQ in every browser. Phase 4 MUST address this before the embed surface is usable.
- **Mechanism.** The Fastify `/embed` route handler sets `reply.header('Content-Security-Policy', 'frame-ancestors ' + tenant.embed_origins.join(' '))` after resolving the tenant from the JWT. For requests where the token is invalid (before tenant resolution), the handler sets `frame-ancestors 'none'` (fail-closed). The handler also sets `reply.removeHeader('X-Frame-Options')` — Caddy's `security-headers` may also inject `X-Frame-Options: DENY`; removing it ensures browsers that check `X-Frame-Options` (pre-CSP) also allow the embed.
- **Caddy non-interference.** Caddy in reverse-proxy mode does NOT rewrite upstream response headers unless an explicit `header` directive modifies them. The Fastify-set CSP reaches the browser intact. Phase 4 deploy verification step (below) confirms this empirically.
- **Other routes.** `frame-ancestors 'none'` from the Caddy snippet remains in effect for all non-embed routes (`/admin/*`, `/api/*`, SPA). The override is surgical — only the embed handler changes this header.

**Phase 4 required deploy verification.**

```bash
curl -sI 'https://assessiq.automateedge.cloud/embed?token=<valid-jwt>' \
  | grep -i 'content-security-policy'
# Must show: frame-ancestors https://portal.wipro.com (or the tenant's configured origins)
# Must NOT show: frame-ancestors 'none'
```

**Source.** `docs/06-deployment.md` § "What's live" (frame-ancestors 'none' confirmed); `04-AUTH` Flow 3 (embed uses iframe).

**Rationale.** Per-request (per-tenant) CSP is the only correct mechanism — Caddy cannot resolve the tenant from the request path alone (tenant is resolved from the JWT claim). The global Caddy default of `'none'` is appropriate for all non-embed routes (clickjacking protection on admin panel); the embed handler's surgical override is the minimal change that enables embedding.

**Alternatives rejected.** (a) Removing `frame-ancestors 'none'` from the Caddy global snippet — rejected; would enable clickjacking on admin pages. (b) A Caddy `handle_path /embed*` block that strips the CSP header before proxying — an acceptable alternative; Phase 4 can implement either this or the Fastify-header approach as long as the deploy verification passes. Document the chosen approach in the Phase 4 session handoff.

**Downstream impact.** `docs/06-deployment.md` needs a Phase 4 same-PR note on the per-tenant CSP mechanism and the deploy verification step. No Caddy change is needed in this pre-flight session (pure docs; no VPS touches per CLAUDE.md rule #8).

---

### D9 — Webhook for embed attempts

**Decision.**

- **Webhook channel.** The existing `13-notifications` webhook infrastructure (G3.B, live 2026-05-03) covers embed attempts without modification. Events `attempt.started`, `attempt.submitted`, `attempt.graded`, `attempt.released` fire for every attempt regardless of whether it originated from an embed JWT or a direct magic-link. No new webhook event type is needed in v1.
- **Embed origin flag.** Phase 4 migration `0073_attempt_embed_origin.sql` (co-located in `modules/12-embed-sdk/migrations/`) adds `embed_origin BOOLEAN NOT NULL DEFAULT FALSE` to the `attempts` table (owned by `06-attempt-engine`). The `/embed` route handler sets `embed_origin=TRUE` when creating the attempt. This flag appears in webhook payloads as `"embed_origin": true` so host apps can filter their traffic.
- **`external_id` JWT claim.** `external_id` (optional claim in the embed JWT — see `09-INT` § Token claims) is stored in `users.metadata.external_id` at JIT user creation and at each embed-login merge. It flows through to webhook payloads via the `user` object (`"user": { ..., "external_id": "EMP-12345" }`). This is already shown in the `03-API` webhook example.
- **Webhook signing secret.** `tenant_settings.webhook_secret` (AES-256-GCM, distinct from `embed_secrets.secret_enc`) signs all outbound webhook deliveries. The two secrets are NEVER interchangeable. Rotation of the embed secret does not affect the webhook secret and vice versa.
- **Polling endpoint.** `GET /api/embed/attempts/:id` deferred. The webhook model is already live; a polling fallback is only needed if an integration partner cannot receive webhooks. Add in a follow-up PR if requested.

**Source.** `09-INT` § Webhooks; `03-API` § Admin — Webhooks; `04-AUTH` Flow 3; `BRAIN` architecture overview (webhook out on submit).

**Rationale.** Re-using the existing webhook channel avoids a parallel notification path. The `embed_origin` flag is the minimal addition for host apps to distinguish embed traffic from direct-magic-link traffic for the same assessment. Separate `embed_secret` and `webhook_secret` is already the architecture; making it explicit in this addendum prevents Phase 4 from wiring the wrong secret.

**Alternatives rejected.** (a) A new `embed.attempt.submitted` event — host apps would need to update receivers; the `embed_origin` boolean is additive and non-breaking. (b) `embed_secret` as the webhook signing key — rejected; rotation semantics differ (embed secrets have a grace window, webhook secrets do not), and cross-purpose would break one flow when the other rotates.

**Downstream impact.** `06-attempt-engine` `attempts` schema gains `embed_origin` via Phase 4 migration. `13-notifications` webhook payload serializer includes `embed_origin` from the `attempts` row. Both are Phase 4 implementation tasks; migration file location is pinned above.

---

### D10 — Host SDK delivery

**Decision.** Phase 4 ships **both** delivery mechanisms in the same PR.

**1. `/embed/sdk.js`** — compiled, minified, self-contained JavaScript (target ≤ 3 KB gzipped) served at `GET /embed/sdk.js`. No install required. Registers `window.AssessIQ`:

```ts
interface AssessIQSDK {
  mount(
    selector: string | HTMLElement,
    opts: {
      token: string;           // signed embed JWT from your backend
      theme?: Record<string, string>;  // --aiq-* CSS vars (D2)
      locale?: "en" | "en-IN" | "hi-IN";
      onReady?: () => void;
      onSubmit?: (result: { attemptId: string; summary: { questions: number; time_used_seconds: number } }) => void;
      onError?: (err: { code: string; message: string }) => void;
    }
  ): { destroy: () => void };  // cleanup handle
}
declare var AssessIQ: AssessIQSDK;
```

`mount()` creates an `<iframe>`, sets `src` to `/embed?token=<JWT>&sdk_version=<version>`, appends it to the target element, wires postMessage listeners to the callbacks, and returns a `destroy()` cleanup handle.

**2. `@assessiq/embed` npm package** — shipped in the same PR. Exports:
- `mintEmbedToken({ secret, tenantId, user: { sub, email, name, externalId? }, assessmentId })` — server-side Node.js JWT signer. Returns `{ token: string, url: string }`.
- `AssessIQMount(el, opts)` — same as `window.AssessIQ.mount()` as an importable function (no framework wrapper in v1).
- `AssessIQEmbedUrl(baseUrl, token)` — URL builder convenience.

**npm publication.** `@assessiq/embed` is published as **public** to npm. The package contains no secrets (JWT signing uses the host's own secret; the package provides the signing helper and iframe wrapper). Making it public enables external partners without a private registry. Flag as open question below.

**Source.** `09-INT` § Iframe HTML (script-snippet pattern); `BRAIN` (JS snippet drop-in); existing SKILL.md `## Public surface` (`@assessiq/embed` package spec).

**Rationale.** `/embed/sdk.js` serves zero-build hosts (intranet portals). The npm package serves modern framework-aware hosts. Both share the same iframe-mount + postMessage wiring; the minified JS file is the canonical build artifact and the npm package re-exports it with type declarations. Dual delivery at ≤3 KB is worth the minor redundancy.

**Alternatives rejected.** (a) npm-only — excludes hosts that cannot run npm. (b) CDN hosting (jsDelivr/unpkg) — deferred; serving from the AssessIQ origin gives version control and same-origin CSP benefits. (c) React/Vue/Angular wrappers in v1 — deferred; wait for first external request.

**Open question for user.** Public npm publication is pinned above. If the first integration partners are all internal (Wipro), a private or unlisted package is viable and can be changed by toggling the `npm publish` visibility flag — no code changes required.

**Downstream impact.** `apps/api/src/server.ts` registers `GET /embed/sdk.js` (served from a static build artifact). `modules/12-embed-sdk/` gains `package.json` for `@assessiq/embed`. `apps/api/package.json` gains `@assessiq/embed: workspace:*`.

---

### D11 — Integration testing harness

**Decision.**

- **Location.** `apps/embed-test/index.html` — a single static HTML file, no build step. Loadable via `file://` or `vite --root apps/embed-test/`.
- **Dev-only endpoint.** `GET /embed/test-mint?assessmentId=<uuid>` returns a signed embed JWT using the first active `embed_secret` for the test tenant. Three-layer gate: (1) `ENABLE_EMBED_TEST_MINTER=1` env var — absent or `0` → handler returns `501 Not Implemented`; (2) `NODE_ENV !== 'production'` secondary guard; (3) admin session required (`requireAuth({ roles: ['admin'] })`). This endpoint does NO AI processing — it is pure JWT signing (Node `jsonwebtoken`). CLAUDE.md Rule #1 (no ambient AI) is not implicated.
- **Test HTML content.** Mounts the iframe via `window.AssessIQ.mount()` (loaded from `/embed/sdk.js`). Displays a postMessage event log. Controls: "Send aiq.theme", "Send aiq.locale", "Send aiq.close-request". Token-expiry countdown. Provides a complete manual smoke-test of the D3 protocol.

**Source.** User brief (integration testing strategy); CLAUDE.md Rule #1 (ambient AI ban — confirms this is not implicated).

**Rationale.** Three-layer gating: env var is the primary production guard; `NODE_ENV` is the backstop for accidental env var exposure; admin session prevents anonymous token minting even when the endpoint is enabled in dev.

**Alternatives rejected.** (a) A separate Express server for embed-test — over-engineering; a single HTML file is auditable in one read. (b) Playwright E2E for postMessage — deferred; requires a fixture that renders two origins; file under `apps/web/e2e/` in a follow-up.

**Downstream impact.** `apps/api/src/server.ts` registers `GET /embed/test-mint` conditionally. `infra/docker-compose.yml` does NOT set `ENABLE_EMBED_TEST_MINTER=1` in any container — must be set manually on dev machines. `docs/06-deployment.md` Phase 4 same-PR note should list this endpoint under "Dev-only surfaces."

---

### D12 — SDK versioning strategy

**Decision.**

- **SemVer** for `@assessiq/embed` and `/embed/sdk.js`.
- **Version param.** `/embed?token=<JWT>` accepts optional `?sdk_version=N.N.N`. `window.AssessIQ.mount()` appends this automatically using the package version baked at build time.
- **Minimum enforcement.** Env var `EMBED_SDK_MIN_VERSION` (absent = no minimum; default absent). If `sdk_version` is present AND below the minimum, the `/embed` handler returns:
  ```
  HTTP 426 Upgrade Required
  {"error":{"code":"SDK_VERSION_TOO_OLD","message":"Your embed SDK is below the minimum supported version. Please upgrade.","details":{"minimum":"1.1.0","current":"1.0.0","upgrade_url":"..."}}}
  ```
- **Absent `sdk_version`.** No version check. Hosts using plain iframes (no SDK) are not blocked.
- **Deprecation header.** For versions between "deprecated" and "minimum", the server sets `X-AssessIQ-SDK-Deprecation: version=<v>; sunset=<ISO-date>; upgrade_url=<url>` on all embed responses. The JS SDK surfaces this as a `console.warn`. The initial minimum is `1.0.0` and no `EMBED_SDK_MIN_VERSION` is set at Phase 4 launch — enforcement starts when an incompatible protocol change ships.
- **Deprecation policy.** Announce 6 months before forcing an upgrade via: (a) deprecation header, (b) email to tenants with active webhook endpoints, (c) release notes.

**Source.** `03-API` § Convention (path-based versioning precedent); user brief (versioning strategy).

**Rationale.** Opt-in version check (absent = pass) prevents breaking unversioned embeds that predate the SDK. `426 Upgrade Required` is the correct HTTP status for "server requires a different protocol version." The deprecation header gives automated host apps a machine-readable warning. 6 months is enough for enterprise integration teams to schedule a dependency update.

**Alternatives rejected.** (a) Hard gate from day 1 — breaks hosts that embedded the iframe before the SDK version param existed. (b) Version in the JWT — the JWT is signed before the host knows the server's minimum; a mismatch wastes the JTI. URL param is read before JWT processing. (c) SemVer range matching (`^1.0.0`) — complexity for marginal benefit; exact minimum is simpler.

**Downstream impact.** `/embed` handler reads `req.query.sdk_version`. `modules/00-core/src/config.ts` gains optional `EMBED_SDK_MIN_VERSION` env var. Neither change requires a migration.

---

### D13 — DPDP / data residency gate for embed

**Decision.**

- **Technical gate.** `POST /api/admin/embed-secrets` (create an embed secret) returns `403 EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE` unless `tenant.privacy_disclosed = TRUE`. This is enforced at the service layer, not at a DB constraint, so an admin can set `privacy_disclosed=TRUE` without a schema migration after the fact.
- **Schema.** Phase 4 migration `0071_tenants_embed_metadata.sql` adds `privacy_disclosed BOOLEAN NOT NULL DEFAULT FALSE` to the `tenants` table. All existing tenants bootstrap with `FALSE`; existing embed secrets (none at Phase 4 start — no embed is live) are unaffected.
- **Admin UI gate.** The embed-secrets creation UI (Phase 4 `10-admin-dashboard` component) shows a "Confirm privacy disclosure" checkbox + link to DPDP documentation before allowing creation. On confirm, `PATCH /api/admin/tenant { privacy_disclosed: true }` is called. The flag persists — the admin is not re-prompted on subsequent secret rotations.
- **Scope.** This session pins the TECHNICAL gate only. The LEGAL content (DPDP compliance certification, data-flow documentation, DPA agreements) is out of scope for Phase 4 and requires legal review before AssessIQ is offered as an embed surface to Indian tenants.
- **Universality.** `privacy_disclosed` applies to ALL tenants (not just Indian). GDPR and CCPA impose similar notice requirements for data-flow disclosure. The field is privacy-framework-agnostic.

**Source.** `BRAIN` (DPDP Act compliance mention for Indian tenants); user brief (DPDP / data residency section).

**Rationale.** A two-line service check prevents inadvertent non-compliance while legal review proceeds. Universal application avoids an `if (data_region == 'in')` branch (CLAUDE.md Rule #2: domain lives in data, not code). Deferring the legal audit is pragmatic — the technical gate is the accountable mechanism; the legal certification follows at the organization's pace.

**Alternatives rejected.** (a) DPDP gate only for `data_region='in'` — rejected; data subject location determines applicability, not tenant's declared region. (b) Soft warning instead of hard block — rejected; warnings do not prevent non-compliant use.

**Downstream impact.** `tenants` table gains `privacy_disclosed` column. `docs/09-integration-guide.md` Phase 4 same-PR note: "Before creating embed secrets, your tenant admin must confirm privacy disclosure in Settings → Integrations → Privacy." The `PATCH /api/admin/tenant` endpoint (Phase 1 stub, `03-API` status "Phase 1") needs to accept `privacy_disclosed` in its body — a one-field addition to the existing handler.

---

## Phase 4 migration plan (pre-seeded)

> Phase 4 writes the actual SQL. This section documents the intended migration file names and schema purpose so the implementer can start immediately.
>
> Numbering: Phase 3 used `0055`–`0058`; `0060`–`0069` are reserved for G3.A (`14-audit-log`) and G3.C (`15-analytics`). Phase 4 (`12-embed-sdk`) starts at **`0070`**. See `modules/12-embed-sdk/migrations/README.md` for per-migration schema sketches with `docs/02-data-model.md` line references.

| File | Owns | Purpose |
|---|---|---|
| `0070_embed_origins.sql` | `tenants.embed_origins` | `TEXT[] NOT NULL DEFAULT '{}'` column on `tenants`; index `GIN`; Phase 4 adds the column referenced by `04-AUTH` Flow 3 but not yet in the `tenants` table. |
| `0071_tenants_embed_metadata.sql` | `tenants.privacy_disclosed`, `sessions.session_type` | `privacy_disclosed BOOLEAN NOT NULL DEFAULT FALSE` on `tenants` (D13); `session_type TEXT NOT NULL DEFAULT 'standard' CHECK (...)` on `sessions` (D6). Both in one migration — same PR as they share a table. |
| `0072_embed_help_seed.sql` | `help_content` rows | Seeds the three help IDs declared in SKILL.md `## Help/tooltip surface`: `admin.integrations.embed-secrets.create`, `admin.integrations.embed-origins.add`, `admin.integrations.test-embed`, `admin.integrations.npm-package`. |
| `0073_attempt_embed_origin.sql` | `attempts.embed_origin` | `embed_origin BOOLEAN NOT NULL DEFAULT FALSE` on `attempts` table (owned by `06-attempt-engine` but migration co-located here per D9). Phase 4 must update `modules/06-attempt-engine/src/types.ts` and the attempt-create service to pass `embed_origin=TRUE` for embed-initiated attempts. |

---

## Spec drifts resolved (2026-05-03)

The Phase 0 pre-flight read found three spec drifts between existing docs and what Phase 4 requires. Each is called out in the relevant decision above; summaries below for the implementer:

1. **`tenants.embed_origins` column does not yet exist.** `04-AUTH` Flow 3 and the existing SKILL.md text both reference `tenant.embed_origins` as an already-existing column. It is NOT in the `tenants` CREATE TABLE in `docs/02-data-model.md` and NOT in `modules/02-tenancy/migrations/`. Resolution: Phase 4 migration `0070_embed_origins.sql` adds it (D2). Same-PR note appended to `docs/04-auth-flows.md` Flow 3.

2. **`frame-ancestors 'none'` in the live Caddy block blocks all iframe embedding (production-visible).** The live Caddy `security-headers` snippet confirmed in `docs/06-deployment.md` sets `frame-ancestors 'none'` globally. If Phase 4 deploys `/embed` without addressing this, every iframe embed will be blocked by the browser. Resolution: per-tenant CSP override in the Fastify embed handler (D8). Same-PR note appended to `docs/04-auth-flows.md` Flow 3.

3. **`external_id` JWT claim undocumented in this SKILL.md.** `docs/09-integration-guide.md` shows `external_id` as an optional JWT claim; `01-AUTH` §5 required-claims list does not include it; neither does the existing SKILL.md. Resolution: pinned in D9 as an optional claim stored in `users.metadata.external_id` at JIT user creation.

---

## Security review note

This addendum was authored in a **Sonnet-only pre-flight session** (2026-05-03, user instruction). Per CLAUDE.md load-bearing-paths rule, Phase 4 will touch `modules/01-auth/` (sessionLoader changes in D6, `SameSite=None` option in D7) and MUST gate those specific changes with Opus diff review + `codex:rescue` adversarial sign-off before push. This pre-flight session makes **zero changes** to `modules/01-auth/`.
