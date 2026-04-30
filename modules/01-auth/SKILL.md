# 01-auth — Identity, sessions, MFA, embed JWT, API keys

> See `docs/04-auth-flows.md` for full sequence diagrams. This skill is the implementation orientation for that doc.

## Purpose
Authenticate every request: humans via Google SSO + TOTP, host applications via embed JWT, server-to-server via API keys.

## Scope
- **In:** OIDC client for Google (extensible to Microsoft/Okta/generic), TOTP enroll + verify + recovery codes, magic-link issuance + redemption, session creation/destruction, embed JWT verification, API key validation, rate limiting on auth routes, account lockout.
- **Out:** user CRUD (lives in 03-users), tenant settings UI (10-admin-dashboard), audit writes (delegated to 14-audit-log via emitted events).

## Dependencies
- `00-core` — config, errors, context, IDs
- `02-tenancy` — to resolve `tenant_id` and read `tenant_settings.auth_methods`
- `03-users` — to find/create user records on SSO callback
- `13-notifications` — to send magic-link emails
- `14-audit-log` — to emit `auth.*` events

## Public surface
Fastify plugins registered as:
```ts
fastify.register(authPlugin, { prefix: "/api/auth" });
fastify.register(embedAuthPlugin, { prefix: "/embed" });
fastify.register(magicLinkPlugin, { prefix: "/take" });

// Decorators available on every request after sessionLoader
req.session?: { id, userId, tenantId, totpVerified, expiresAt }
req.requireAuth(roles?: Role[], opts?: { freshMfa?: boolean })
req.apiKey?: { id, tenantId, scopes }
```

## Data model touchpoints
Owns: `sessions`, `oauth_identities`, `user_credentials`, `totp_recovery_codes`, `api_keys`, `embed_secrets`, `user_invitations` (auth-related portion).

Reads: `users` (existence check), `tenants`, `tenant_settings`.

## Key flows (recap)
- **Admin login:** `/api/auth/google/start` → Google → `/api/auth/google/cb` → pre-MFA session → `/admin/mfa` → `/api/auth/totp/verify` → fully-authenticated session
- **TOTP enroll:** server generates secret + QR; user confirms; recovery codes shown once
- **Embed:** `/embed?token=<JWT>` → verify HS256 with tenant secret → mint session → SPA in embed mode
- **API key:** `Authorization: Bearer aiq_live_*` → sha256 lookup → tenant context set

## Help/tooltip surface
- `admin.auth.totp.enroll` — explains TOTP enrollment, app recommendations, recovery codes
- `admin.auth.recovery.use` — when/how to use a recovery code
- `admin.settings.auth-methods.totp_required` — toggle implications
- `admin.settings.embed-secrets.rotate` — rotation grace period explained
- `admin.api-keys.scopes` — scope catalog with examples
- `candidate.auth.magic-link` — what to do if magic link expired

## Open questions
- Passkeys (WebAuthn) priority vs SAML — decide after first 3 enterprise inquiries
- Whether to enforce TOTP for *all* admin sessions or just elevated actions (currently: all admin sessions, step-up for sensitive actions)
