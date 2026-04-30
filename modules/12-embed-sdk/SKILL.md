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
