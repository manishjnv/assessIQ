# 04 — Auth Flows

> Phase 1 ships **Google SSO + TOTP**. All other methods are designed in but admin-toggled per tenant in Phase 2. The architecture below assumes them all from day one so we don't refactor the session and identity model later.

## Identity model summary

| Concept | Where it lives |
|---|---|
| **Who you are** | `users` (per tenant) — one row per (tenant, email) |
| **How you proved it** | `oauth_identities`, `user_credentials` |
| **Active sessions** | `sessions` (Redis-mirrored for fast lookup) |
| **Service-to-service** | `api_keys` |
| **Embed access** | `embed_secrets` (per tenant; signs JWT) |
| **Audit** | `audit_log` (every login, MFA, override) |

A `users` row exists *before* the first login. Admins create users (or import via CSV/SCIM in v2); SSO links the Google identity to that pre-existing row on first login. **No self-registration in v1** — protects against tenant pollution.

---

## Roles and capabilities

Four roles exist in the `Role` union. The `requireAuth` gate uses **exact set membership** (`opts.roles.includes(sess.role)`) — passing `roles: ['admin']` does NOT admit a `super_admin` session. Each route lists every accepted role explicitly. (`modules/01-auth/src/sessions.ts:23`, `modules/01-auth/src/middleware/require-auth.ts:26`)

| Role | Scope | Auth method | TOTP enforced | Typical access |
|---|---|---|---|---|
| `candidate` | Per-tenant | Magic link or Google SSO | Optional (tenant-configurable) | `/take/*`, `/api/me/*` |
| `reviewer` | Per-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Read-only admin routes |
| `admin` | Per-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Full `/api/admin/*` for their tenant |
| `super_admin` | Cross-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Routes explicitly gated to `['super_admin']` only |

**super_admin detail (commit d59ade4):** authenticates via the same Google SSO → TOTP path as admin. Session still carries a `tenant_id` (the tenant the operator authenticated against); cross-tenant writes are enabled in specific service functions (e.g. `updateAiGenerateMode` accepts a target `tenantId` as an explicit argument). Shipped endpoints gated to `roles: ['super_admin']`:

| Endpoint | Purpose |
|---|---|
| `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` | Flip AI generation mode for any tenant (atomic audit via `auditInTx`) |
| `POST /api/admin/analytics/refresh` | Manual materialized-view refresh (cross-tenant) |

(`apps/api/src/routes/admin-super.ts:25,41`, `apps/api/src/server.ts:225,229`)

**Question-bank authoring is super_admin-only (Phase B1, 2026-05-21).** Beyond the cross-tenant `/super/*` routes above, all question-bank **mutation** routes — pack/level/question CRUD, publish, archive, activate-questions, import, save-rubric, bulk-status (13 paths in `modules/04-question-bank/src/routes.ts`) — are gated `roles:['super_admin']`; tenant admins retain `GET` read access only and get `403 AUTHZ_FAILED` on writes. This extends the earlier generation-route re-gate so the whole shared-library authoring surface is operator-only. Per-tenant taxonomy (`POST /admin/domains`, `/admin/categories`) stays `admin`. Full table + SPA gating: `docs/03-api-contract.md` § "Phase B1 (cont.) — question-bank authoring re-gated to super_admin".

> **DB note (resolved 2026-05-17):** the earlier "`011_sessions.sql` lacks `super_admin`" caveat is **closed**. Slice-1 migration `modules/01-auth/migrations/016_super_admin.sql` (Steps 1a/1b) drops+re-adds `sessions_role_check` and `users_role_check` to include `'super_admin'`, and seeds the platform tenant (`00000000-0000-7000-0000-000000000001`, slug `platform`) + the bootstrap super_admin user (`…0002`, manishjnvk@gmail.com). Applied surgically to prod and confirmed (the platform Google-SSO branch is reachable end-to-end).

## P1 — Tenant-less login + cross-tenant identity resolution (2026-05-19, commit `62c2558`)

**Spec:** `docs/superpowers/specs/2026-05-19-login-identity-simplification-design.md`. Load-bearing `modules/01-auth`. No session/JWT/RLS/data-model change. (P2 — admin/reviewer email-OTP — is a separate, not-yet-built phase.)

**Why:** the same email is a separate identity per tenant (`UNIQUE(tenant_id,email)`). The old flow forced the user to type their tenant slug to disambiguate. P1 removes that.

**Flow:**
1. `/admin/login` has **no Tenant field** — "Continue with Google" only. `GET /api/auth/google/start` no longer requires the `?tenant=` query param; OAuth state is now `random[|returnTo]` (the tenantId segment is removed). CSRF-state + nonce + id_token RS256/JWKS verification are **byte-unchanged**.
2. New **step 4b**: the login is rejected unless Google asserts `email_verified` (email is now the sole cross-tenant identity key; robust to boolean `true` / stringized `"true"`; fail-closed, generic error).
3. `resolveLoginIdentities(verifiedEmail)` — runs **only after** full id_token verification, in a bounded `SET LOCAL ROLE assessiq_system` (BYPASSRLS) transaction, returning every `active`, non-deleted `users` row matching `lower(email)` across all tenants. **Gate-2 preserved:** a `super_admin`/platform-tenant identity is included **only if** the email ∈ `SUPER_ADMIN_EMAILS` (else filtered out entirely — never returned/counted/shown).
4. **0 identities** → generic `AuthnError` (no enumeration). **1** → `mintForIdentity` immediately (behaviour-identical to the pre-P1 callback). **≥2** → a single-use Redis **login-continuation token** (32-byte random, sha256-keyed, TTL 300 s, ip/ua-bound, fail-closed, HttpOnly cookie, **never in a URL**) + redirect to `/admin/select-identity`.
5. SPA `/admin/select-identity` (no `RequireSession` — a pre-session step) calls `GET /api/auth/login/identities` (publicAuthChain; non-consuming **peek** of the continuation) to render a "Role @ Organisation" picker, then `POST /api/auth/login/select { userId }`.
6. `selectLoginIdentity`: atomically **consumes** the continuation (single-use `getdel`), asserts `userId ∈ payload.candidates` **and** in a **fresh re-resolve** (double anti-tamper — a caller can only mint an identity the verified email actually owns), then `mintForIdentity`.

**`mintForIdentity` (shared by the single-identity callback path and `/select`):** super_admin/platform → fresh platform `users` re-read (role/status/deleted) → `sessions.create(totpVerified=false)` → redirect `/admin/mfa` **always** (Gate-4) → **no `oauth_identities` write** (Gate invariant). Customer → fresh `status='active' AND deleted_at IS NULL` re-check → `oauth_identities` JIT-link `ON CONFLICT (provider,subject) DO NOTHING` → mint → redirect (`candidate`→`/`; else `MFA_REQUIRED?'/admin/mfa':(safeReturnTo(returnTo)||'/admin')`). On the `/select` path there are no Google `claims`; the allowlist is still enforced because `resolveLoginIdentities`'s Gate-2 filter runs at both continuation-store time and the fresh re-resolve.

**super_admin** appears in the picker like any identity but selecting it is routed through the unchanged isolated always-MFA gates (Gate-2 via the resolver filter; Gate-3/4 in `mintForIdentity`). Email-OTP (P2) will never be able to satisfy super_admin.

**Behaviour delta (accepted, fail-closed):** the pre-P1 Pass-1 `oauth_identities`-by-`subject` lookup is gone (resolution is now by verified email). A user who changed their Google email but kept the same Google account would be **rejected** (fail-closed) rather than logged in by subject — never the wrong user; common (stable-email) path is identical.

**Adversarial gate (mandatory, 01-auth):** Sonnet review **VERDICT accept** — all 7 highest-stakes invariants CLEAN with traced proofs (no super-admin escalation on either path; cross-tenant read post-verification only; `normalizeEmail` = trim+lowercase only → no dot/plus impersonation; `/select` anti-tamper double-checked; always-MFA; CSRF/nonce sound; behaviour-preserving). Opus adjudication: finding-1 (`email_verified`) **fixed** (step 4b above); **finding-2 — open accepted residual:** the continuation ip-binding derives client IP via `cf-connecting-ip ?? req.ip`, spoofable if the origin is reached without Cloudflare in front — this is a **pre-existing codebase-wide pattern** (sessions, candidate-login, rate-limit derive IP identically) and is gated behind a 256-bit HttpOnly single-use token; the correct fix is an app-wide `trustProxy`/CF-range config (tracked follow-up, not a P1-scoped change); finding-3 (non-consuming peek) is design-intent, SameSite=Lax-bounded.

### P2 — email-OTP for admin/reviewer (2026-05-19, commit `a16fdb1`)

An **alternative primary login to Google SSO, for `admin` and `reviewer` only.** `super_admin` can NEVER use it (Google + authenticator MFA only); `candidate` magic-link is untouched. Reuses P1's resolver/continuation/picker/`mintForIdentity`.

- **Login page** gains "Email me a sign-in code" → `/admin/login/email` (two-step: enter email → enter 6-digit code). New module `modules/01-auth/src/email-otp.ts`.
- `POST /api/auth/login/email/request {email}` (`publicAuthChain`) — **always** `200 {ok:true,"If that email can sign in, we've sent a 6-digit code."}`. A code is generated/sent **only if** `resolveLoginIdentities(email)` has ≥1 identity passing `filterEligible` = `role∈{admin,reviewer} && !isPlatform` (positive allowlist — structurally excludes super_admin & candidate). 6-digit CSPRNG; only `sha256(code)` in Redis; 10-min TTL; one active code per email (a new request overwrites). Two fail-closed rate-limits (candidate-login Lua idiom): per-`(IP,email)` 5/h **and** per-email IP-independent 10/h (anti IP-rotation email-bombing). `sendEmail` is called with the eligible tenant's `tenantId` (audited; never the dev-emails.log plaintext-code fallback). Email template `admin_email_otp` (modules/13-notifications).
- `POST /api/auth/login/email/verify {email,code}` (`publicAuthChain`) — atomic `ATTEMPT_LUA` (≤5 attempts then the code is burned), ip/ua bind, constant-time `sha256` compare, single-use delete on success. On success → fresh `resolveLoginIdentities` + the SAME `filterEligible`: 0→fail, 1→`mintForIdentity` (customer branch; **no Google `subject`** ⇒ no `oauth_identities` link written), ≥2→`storeLoginContinuation` (`subject:undefined`, `candidates`=admin/reviewer userIds) → `/admin/select-identity` (P1 picker reused). Any failure → generic `200 {ok:false,error:'invalid_code'}` (no expired/wrong/locked distinction).
- **super_admin impossibility — triple-blocked & adversarially proven:** (a) request `filterEligible`; (b) verify re-filter; (c) the continuation `candidates` only ever holds admin/reviewer userIds, so P1 `selectLoginIdentity`'s `userId ∈ candidates` assertion rejects a super_admin userId even though its internal re-resolve returns all roles. A mixed email (super_admin@platform + admin@tenantX) gets a code (admin eligible) but only the admin identities are ever selectable.
- **Anti-enumeration is constant-WORK, not just constant-floor:** `_requestWork` runs `resolveLoginIdentities` unconditionally first on every path (rate-limited / ineligible / unknown / send), and `MIN_REQUEST_MS` is 800 ms (above the resolve p99) on both request and verify — so response latency cannot distinguish a provisioned admin/reviewer email from an unknown one.
- **P1-code change:** `mintForIdentity.ctx.subject` is now optional; the `oauth_identities` INSERT is wrapped `if (subject !== undefined)`. Google callback + P1 `/select` always pass a `subject` ⇒ those paths are byte-unchanged; only email-OTP (no Google identity) skips the link. `LoginContinuationPayload.subject` widened to `string | undefined`; `selectLoginIdentity` logic unchanged (only the subject-forwarding spread).
- **Adversarial gate (mandatory, 01-auth):** Sonnet review VERDICT *revise* — all security invariants HELD with traced proofs (super_admin/candidate impossible incl. races; brute-force infeasible: 5 tries/code over a 10⁶ space + dual rate-limit; recipient-injection/code-exfil blocked by resolve-before-send; P1 byte-preservation; continuation reuse). Opus adjudication: **BLOCKER-1** (missing `admin_email_otp` template — feature DOA) FIXED; **MAJOR-2** (timing oracle breaking anti-enum) FIXED (constant-work + 800 ms floor); **MINOR-3** (per-email cap) FIXED; **MINOR-4** (tenantId → audited send, no plaintext-code dev-log) FIXED; **MINOR-5** (`cf-connecting-ip` spoofable) = accepted PRE-EXISTING codebase-wide residual (same as P1 finding-2; app-wide `trustProxy` follow-up, not P2-scoped).

## Super-admin "Edit admin" — email is the login identity (2026-05-24, branch `feat/platform-edit-admin`, PR-pending)

**What:** the Platform page gains a per-row "Manage ▸ Edit admin" modal that edits the primary-contact admin's `name`, `role` (`admin`↔`reviewer`), and `email` via `PATCH /api/admin/super/users/:userId` (gate: `super_admin` + fresh MFA). See `docs/03-api-contract.md` for the full contract.

**Why this is an auth-flow concern:** because login resolution is **by Google-verified email** (`resolveLoginIdentities(verifiedEmail)` — "the SOLE cross-tenant identity key", per the P1 section below), `users.email` *is* the login identity. There is no separate immutable login id that survives an email change. Therefore editing an admin's email is not a contact-detail edit — it changes who can sign into that account.

**Semantics (enforced server-side; the UI confirm checkbox is defence-in-depth only):**
- **Pending** admin (invite not yet accepted, never logged in): the email is freely re-addressable. In-transaction we retire the old-address invitation; post-commit we re-issue a fresh invite to the new address. No confirmation needed.
- **Active or disabled** admin (a real account exists): changing the email **transfers account ownership** and requires `confirmEmailIdentityChange:true`. On change we (a) `UPDATE users.email` in the tenant tx, (b) delete the stale `oauth_identities` Google link (login is email-keyed, so the old `(provider,subject)` row is inert but removed for hygiene and to allow JIT re-link at the new address), and (c) sweep the user's sessions after commit (forced re-login). The operator is warned in the UI that the admin must control a Google account at the new address or be locked out.
- New email colliding with another user in the same tenant → `409 USER_EMAIL_EXISTS` (the `UNIQUE(tenant_id,email)` constraint). `super_admin` users cannot be edited via this endpoint.

**Relation to P1 finding-2 (residual):** this introduces no new IP-trust surface; the fresh-MFA gate and `super_admin` role check are the controls. The known app-wide `cf-connecting-ip` spoofability residual is unchanged by this change.

**Adversarial gate (mandatory, touches 01-auth identity):** Sonnet review **VERDICT revise** — two real findings fixed before merge: (F5) email change on a *disabled* account also requires the identity-transfer confirm (the guard now keys on `status !== 'pending'`, not just `active`); (F2) a post-rename invite-send failure returns `200 reinvited:false` instead of a `500` (the rename already committed; recover via "Resend invite"). Finding-1 (cross-tenant invitation DELETE) verified safe — `user_invitations` carries the `tenant_isolation` RLS policy (`FOR ALL`), so the `withTenant`-scoped DELETE cannot cross tenants. Opus independent second pass: **ACCEPT** after fixes. (GLM-5.1 half blocked by the harness data-exfiltration classifier; Opus took the second-reviewer slot.)

### Super-admin platform login (option c — isolated path)

> **⚠ SUPERSEDED BY P1 (2026-05-19) — see "## P1 — Tenant-less login + cross-tenant identity resolution" below.** The Tenant field is removed; super_admin is no longer reached by typing `platform`. The Gate-2/3/4 *semantics* (allowlist, platform users row, always-MFA, no `oauth_identities`) are **unchanged** — they now live in `resolveLoginIdentities` (Gate-2 filter) + `mintForIdentity` (Gate-3/4), reached after cross-tenant resolution + the identity picker instead of a typed tenant slug embedded in OAuth state. The historical description below is kept for the pre-P1 contract.

The super-admin logs in through the **normal `/admin/login` page with the Tenant field set to `platform`** (not `wipro-soc`). This embeds the platform tenant id in the OAuth state; `handleGoogleCallback` takes the isolated platform branch: Gate1 id_token (RS256/JWKS/nonce/CSRF) · Gate2 email ∈ `SUPER_ADMIN_EMAILS` (defaults to manishjnvk@gmail.com) · Gate3 platform-tenant `users` row `role='super_admin' status='active'` · Gate4 mint session `totpVerified=false` and redirect `/admin/mfa`. No `oauth_identities` row is read or written on this path (the global `UNIQUE(provider,subject)` constraint stays intact for customer tenants). (`modules/01-auth/src/google-sso.ts:336-428`)

### First-login MFA bootstrap (RCA 2026-05-17 — lockout fix)

`super_admin` is **always-MFA** regardless of `MFA_REQUIRED`. But a pre-TOTP super_admin must still be able to *reach* the screens that set TOTP, or it is permanently locked out. The contract:

- The **read-only state-probe / bootstrap routes** — `whoami`, `logout`, and the four `/api/auth/totp/*` routes — explicitly pass `requireTotpVerified:false`. `require-auth.ts` honors an *explicit* `requireTotpVerified===false` for **every** role including super_admin, so a pre-TOTP super_admin can call them. The 4 TOTP routes additionally list `'super_admin'` in `roles[]` (the backend role gate is exact `includes()` — no hierarchy).
- `whoami`'s `computeMfaStatus()` reports `'pending'` for a pre-TOTP super_admin **regardless of `MFA_REQUIRED`** (super_admin is always-MFA), so the SPA `RequireSession` routes it to `/admin/mfa` to enrol/verify rather than to the dashboard.
- Every **cross-tenant ACTION route** (`/api/admin/super/*`) omits `requireTotpVerified:false` *and* additionally sets `freshMfaWithinMinutes` — so super_admin actions remain fully MFA-gated (`totpVerified=true` + TOTP within 15 min). The bootstrap relaxation never reaches the dangerous surface.

(`modules/01-auth/src/middleware/require-auth.ts:43-67`, `apps/api/src/routes/auth/{whoami,totp,logout}.ts`; regression suites `super-admin-mfa-bootstrap.test.ts`, `whoami-mfa-status.test.ts`)

### `totpVerified` at mint — rate-limit trust tier (RCA 2026-05-30)

**`totpVerified` is a "all *required* second factors satisfied" flag, not "the user typed a TOTP code".** `mintForIdentity` (customer-tenant branch) computes it live at mint:

```
totpVerified = user.role === "candidate" || !config.MFA_REQUIRED
```

- **What changed.** Previously the customer branch always minted `totpVerified=false`. It now mints `true` for `candidate` (parity with magic-link, which hardcodes `true`) and for `admin`/`reviewer` **when `MFA_REQUIRED=false`**. (`modules/01-auth/src/google-sso.ts` ~line 486.) The super_admin branch is unchanged — it always mints `false` and always requires TOTP (Gate-4 above), and is never reached by this line.
- **Why.** Production runs `MFA_REQUIRED=false` (opt-in MFA, pre-launch). With the old code an SSO admin was `totpVerified=false` for the entire 8h session and there is **no TOTP step to ever flip it true** — so `rate-limit.ts` permanently kept them in the conservative **60/min `aiq:rl:user:<id>`** tier (vs 300/min for verified admins). A normal dashboard page fires >60 authenticated calls/min (`whoami` + `/api/admin/assessments` + `/api/billing/usage` + polling), exhausting the bucket; every subsequent request then `429`s with `scope=user` — including `GET /api/auth/google/start` (the session cookie is still sent), so the admin can't even re-login out of the lockout. Recurring 3× because all three prior fixes raised **IP-scope** caps (anon 30→120, IP-admin 100→500, verified-admin 5000) and never the per-user tier that was actually binding. See `docs/RCA_LOG.md` 2026-05-30.
- **Why this is safe (adversarial-reviewed, VERDICT accept).** `require-auth.ts` wraps the **entire** TOTP-verified gate *and* the fresh-MFA step-up gate in `if (isSuperAdmin || config.MFA_REQUIRED)` (require-auth.ts:59). So for non-super_admin roles when `MFA_REQUIRED=false`, `totpVerified` is **never read by any auth gate** — flipping it `true` only restores the correct rate-limit tier and relaxes **no** authorization. super_admin is always-MFA on a separate branch. Credential endpoints keep their own 20/min per-route bucket regardless of tier, so brute-force protection is unaffected.
- **Considered and rejected.** (a) Bumping the hardcoded `60` user cap — that is a 4th whack-a-mole on a symptom; a heavy page can exceed any fixed number, and it leaves the trust-tier semantics wrong. (b) Making the rate-limit tier itself `MFA_REQUIRED`-aware without touching the session field (Option A) — smaller blast radius but leaves `totpVerified` semantically dishonest; rejected in favour of fixing the field at the source.
- **NOT included / known residual (V3).** A session minted `totpVerified=true` while `MFA_REQUIRED=false` persists ~8h in Redis. If an operator flips `MFA_REQUIRED=true` mid-session, that stale session **bypasses the newly-enabled TOTP gate until it expires** (≤8h). This is a bounded, operator-initiated (config change + redeploy), non-attacker-exploitable risk and is accepted; super_admin is unaffected. If a future deploy enables MFA, treat it as a session-invalidation event (or accept the ≤8h tail).
- **Downstream impact.** `rate-limit.ts` (tier resolution — no code change, reads the field), the email-OTP login path (reaches the same customer-branch mint, so admin/reviewer email-OTP logins get the same fix). No schema or API-contract change.

---

## Flow 1 — Admin login (Google SSO + TOTP)

> **Status (2026-05-01, Phase 0 closure — route layer + first API deploy live end-to-end):** library + DB layer + Fastify route layer + container deploy ALL LIVE on `origin/main`. Commits `d9cfeb4` (W4 library + migrations 010-015), `58eba33` (assessiq-api Dockerfile + auth route layer), `335d055` (dev-auth shim swap → real `@assessiq/auth` chain across `apps/api` and `apps/web`), `0789e4f` (Dockerfile build-strategy fix + `getTenantBySlug` system-role implementation). Routes serving Flow 1: `GET /api/auth/google/start?tenant=<slug>` (302 to Google, sets `aiq_oauth_state` + `aiq_oauth_nonce`), `GET /api/auth/google/cb` (mints pre-MFA `aiq_sess`, redirects to `/admin/mfa`), `POST /api/auth/totp/enroll/start` + `POST /api/auth/totp/enroll/confirm` (returns 10 plaintext recovery codes ONCE), `POST /api/auth/totp/verify` (promotes to `totp_verified`), `POST /api/auth/totp/recovery`, `POST /api/auth/logout`, `GET /api/auth/whoami`. Container live behind Caddy split-route on `https://assessiq.automateedge.cloud/api/*`; verified by direct curl on the deployed surface. **Drill B (curl `/api/auth/google/start` 302) is DEFERRED** — route + tenant resolution PASS but `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty in `/srv/assessiq/.env`, so the route returns 401 `"Google SSO is not configured"` cleanly (rate-limit headers populated, no leak, no stack trace). To clear: provision OAuth client in Google Cloud Console with redirect URI `https://assessiq.automateedge.cloud/api/auth/google/cb`, add credentials to `.env`, restart `assessiq-api`. **Drill 1 (full-stack browser SSO+MFA flow) is DEFERRED** — `assessiq-frontend` Dockerfile is a Phase 1+ deliverable, so the `/admin/login` HTML route currently serves the Caddy default placeholder, not the SPA. The dev-auth `FIXME(post-01-auth)` markers are now ZERO across the repo (`apps/api/src/middleware/dev-auth.ts` deleted; `apps/web` SPA edits in commit `335d055`).

The strict path. Every admin must clear both factors.

> **Post-login redirect contract (updated 2026-05-04, commit `473fef1`):** The canonical post-authentication landing is always `/admin` (the dashboard). Previously `MFA_REQUIRED=false` redirected to `/admin/users` and post-TOTP `nav()` calls in `apps/web/src/pages/admin/mfa.tsx` also targeted `/admin/users`. Both are now `/admin`. **Correction (2026-05-30):** the earlier claim that "in production `MFA_REQUIRED=true` always" is **stale** — production currently runs `MFA_REQUIRED=false` (opt-in MFA, pre-launch). With MFA enforced the path is `Google callback → /admin/mfa → TOTP verify → /admin`; with MFA off (current prod) it is `Google callback → /admin` directly, and the session is minted `totpVerified=true` (see "### `totpVerified` at mint" above).

```
┌──────────┐                ┌────────────┐                  ┌────────────┐
│ Browser  │                │ AssessIQ   │                  │  Google    │
└────┬─────┘                └─────┬──────┘                  └─────┬──────┘
     │                            │                               │
     │ GET /admin                 │                               │
     ├───────────────────────────▶│                               │
     │  302 → /api/auth/google/start                              │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │ GET /api/auth/google/start                                 │
     ├───────────────────────────▶│                               │
     │  Build OIDC AuthN request: client_id, redirect_uri,        │
     │  state (signed), nonce, scope=openid email profile,        │
     │  hd=<tenant.domain> (if domain restriction enabled)        │
     │  302 → accounts.google.com/o/oauth2/v2/auth?...            │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │     GET accounts.google.com/...                            │
     ├──────────────────────────────────────────────────────────▶ │
     │     User authenticates with Google                         │
     │◀────────────────────────────────────────────────────────── │
     │     302 → assessiq.in/api/auth/google/cb?code&state │
     │                            │                               │
     │ GET /api/auth/google/cb    │                               │
     ├───────────────────────────▶│                               │
     │                            │ POST oauth2/token (code)      │
     │                            ├──────────────────────────────▶│
     │                            │ id_token + access_token       │
     │                            │◀──────────────────────────────┤
     │                            │ Verify id_token sig + claims  │
     │                            │ (iss=accounts.google.com,     │
     │                            │  aud=client_id, exp, nonce)   │
     │                            │ Resolve user:                 │
     │                            │  - find oauth_identities by   │
     │                            │    (provider='google',sub)    │
     │                            │  - else find users by         │
     │                            │    (tenant_id,email)+link     │
     │                            │  - else 403 (no self-reg)     │
     │                            │ Check tenant.domain allow-list│
     │                            │ Create pre-MFA session        │
     │                            │ (totp_verified=false)         │
     │  Set-Cookie: aiq_sess (httpOnly,Secure,SameSite=Lax)       │
     │  302 → /admin/mfa          │                               │
     │◀───────────────────────────┤                               │
     │                            │                               │
     │ GET /admin/mfa             │                               │
     ├───────────────────────────▶│                               │
     │  If totp_enrolled_at IS NULL: enroll flow (next section)   │
     │  Else: prompt for 6-digit code                             │
     │                            │                               │
     │ POST /api/auth/totp/verify {code}                          │
     ├───────────────────────────▶│                               │
     │  Decrypt totp_secret_enc, verify TOTP (RFC 6238, ±1 step)  │
     │  Update sessions.totp_verified=true                        │
     │  audit_log: 'auth.login.totp_success'                      │
     │  302 → /admin                                              │
     │◀───────────────────────────┤                               │
```

**Session cookie spec:**
- Name: `aiq_sess`
- Value: 32-byte random; only the `sha256` hash is stored
- Flags: `HttpOnly; Secure; SameSite=Lax; Path=/`
- Lifetime: 8 hours sliding (idle 60 min)
- On every request: middleware reads cookie → looks up Redis → checks `totp_verified` → loads tenant context

**Security middleware order (Fastify) — updated 2026-05-04:**
1. `requestId` (correlation)
2. `cookieParser` (`@fastify/cookie`, registered globally at app startup — runs as `onRequest` before any `preHandler`)
3. `sessionLoader` (sets `req.session` from Redis — **runs before rateLimit** so the role can be read for IP bucket resolution; short-circuits in <1 ms when no `aiq_sess` cookie is present)
4. `rateLimit` (role-aware per-IP on all routes; per-user 60/min; per-tenant 600/min — see § Role-aware IP rate limiting below)
5. `tenantContext` (sets `app.current_tenant` for the DB connection)
6. `requireAuth(roles, mfaRequired=true)` — applied per route

> **Chain reorder note (2026-05-04):** The original order was `requestId → rateLimit → cookieParser → sessionLoader → ...`. sessionLoader was moved before rateLimit so role-aware IP bucket resolution can inspect `req.session`. This is safe: `@fastify/cookie` runs as an `onRequest` hook (before all `preHandlers`), so `req.cookies` is always populated when `sessionLoader` runs. Anonymous requests (no `aiq_sess` cookie) incur zero extra overhead — sessionLoader short-circuits on missing cookie without touching Redis.

## Flow 1a — TOTP enrollment (first admin login)

```
1. Server generates random 20-byte secret, base32-encodes for QR
2. Encrypts with AES-256-GCM using MASTER_KEY env var, stores in user_credentials.totp_secret_enc
3. Generates `otpauth://totp/AssessIQ:user@x.com?secret=...&issuer=AssessIQ&period=30&digits=6&algorithm=SHA1` (SHA-1 explicit — Google Authenticator / Authy / 1Password default but ambiguous if omitted)
4. Renders QR code + manual entry code
5. User scans with Authy / Google Authenticator / 1Password
6. User enters first 6-digit code → server verifies with ±1 time step tolerance
7. On success:
   - generates 10 single-use recovery codes (cryptographically random, 8 chars each)
   - hashes each with argon2id, stores in totp_recovery_codes
   - shows codes to user ONCE with prominent download/print prompt
   - sets totp_enrolled_at = now()
   - audit_log: 'auth.totp.enrolled'
```

**Recovery codes:**
- One-time use, marked `used_at` on consumption
- User can regenerate (admin can force regenerate); old codes invalidated
- Used at the same `/admin/mfa` prompt with a "Use recovery code instead" link

## Flow 1b — Step-up MFA for sensitive actions

Some admin actions require fresh MFA even within an active session:
- Override an AI grading score
- Delete an assessment with submitted attempts
- Rotate API keys or embed secrets
- Change tenant auth methods

Implementation: routes annotated `requireFreshMfa(maxAgeMinutes=15)`. If `sessions.last_totp_at < now() - 15min`, return `403 mfa_required` with a re-auth challenge. Frontend shows the TOTP modal, then retries the original action.

---

## Flow 2 — Candidate login

Two modes per assessment, set by admin:

### Mode A: SSO (default, internal)

Same Google SSO flow as admin, but:
- `requireAuth(role: 'candidate', mfaRequired: tenant.totp_required_for_candidates)` — TOTP optional for candidates by default; enforced if tenant requires it
- No admin UI access, candidate routes only
- Redirect target after auth: the assessment they were invited to (`/take/<invitation-token>`)

### Mode B: Magic link (cross-org, external candidates)

```
1. Admin invites candidate by email
   → POST /api/admin/invitations { email, assessment_id }
   → token = randomBytes(32).toString('base64url')
   → store token_hash (sha256), expires_at = now + 72h
   → email candidate: https://assessiq.in/take/<token>

2. Candidate clicks link
   → GET /take/<token>
   → verify token_hash exists, not expired, status='pending'
   → mark status='viewed'
   → render landing page; CTA "Begin assessment"
   (mobile: same DOM, single-column reflow per docs/10-branding-guideline.md § 15.3 — M1)

3. Candidate clicks "Begin"
   → POST /api/take/start { token }
   → mark invitation status='started'
   → create attempt, create session bound to user_id, totp_verified=true (TOTP not required for magic link mode)
   → return session cookie
```

**Magic links are single-attempt:** once `attempt.status` moves past `in_progress`, the token is dead. If the candidate's browser crashes mid-attempt, they re-use the same link until the attempt is `submitted`. After that, the link returns "already submitted, contact your admin."

---

## Flow 3 — Embed (host application iframes AssessIQ)

> **Status: LIVE 2026-05-03 (Phase 4 commit `b20858b`).** All implementation gaps in the spec-drift note below have been resolved. The `/embed` handler is fully implemented in `apps/api/src/routes/auth/embed.ts`. Migrations 0070–0073 have been applied to production. The `aiq_embed_sess` ↔ `aiq_sess` cookie bridge is live in `apps/api/src/server.ts`.

Used when AssessIQ is dropped inside another app (Wipro internal portal, client product, etc.). The host app already authenticated the user; AssessIQ trusts the host's assertion via signed JWT.

### Setup (one-time per tenant)
1. Tenant admin creates an embed secret in AssessIQ admin UI
   → `POST /api/admin/embed-secrets { name }`
   → server returns the secret value ONCE (then stores only encrypted form)
2. Host app stores the secret in its own backend env var

### Per-request flow

```
Host app backend builds JWT:
{
  "iss": "host-app-name",
  "aud": "assessiq",
  "sub": "<host-user-id>",
  "tenant_id": "<aiq-tenant-uuid>",
  "email": "candidate@host-domain.com",
  "name": "Jane Doe",
  "assessment_id": "<aiq-assessment-uuid>",
  "exp": <now + 600 seconds>,
  "iat": <now>,
  "jti": "<random uuid>"        // for replay protection
}
Sign with HS256 using tenant's embed secret.

Host renders: <iframe src="https://assessiq.in/embed?token=<JWT>">

AssessIQ /embed handler (Phase 4 implementation — LIVE):
1. Decode JWT header → reject if alg != 'HS256' (D5: alg=none and RS256 rejected)
2. Look up tenant by 'tenant_id' claim
3. Fetch tenant's embed_secrets (try active, then rotated within grace period)
4. Verify signature
5. Validate claims: aud='assessiq', exp>now, iat<=now, exp-iat ≤ 600s (D5 max window), jti not in replay cache (Redis SET with TTL=exp)
6. Resolve/create JIT user via `resolveJitUser()`:
   - find users by (tenant_id, email)
   - if not found: create guest user with role='candidate' (JIT provisioning, always enabled in v1)
7. Build per-tenant CSP: `frame-ancestors <tenant.embed_origins.join(' ')>` — removes `X-Frame-Options` header (D8)
8. Mint embed session via `mintEmbedSession()`: creates `sessions` row with `session_type='embed'` (D6)
9. Set `aiq_embed_sess` cookie: `HttpOnly; Secure; SameSite=None; Path=/` (D7). The server's `onRequest` hook bridges this cookie to `aiq_sess` for downstream middleware.
10. Call `startAttempt({ embedOrigin: true })` → sets `attempts.embed_origin = TRUE`
11. `reply.redirect('/take/a/<attemptId>?embed=true', 302)` — SPA detects `?embed=true` and renders `<EmbedLayout>`
```

**Host-host trust boundary:** AssessIQ trusts whatever the JWT says about identity. If the host signs a token claiming to be `ceo@wipro.com`, AssessIQ believes them. This is the correct model — but means embed secrets are valuable. Rotate every 90 days; revoke immediately on suspected compromise.

**postMessage protocol** (for iframe ↔ parent communication):
- AssessIQ → host: `{ type: 'aiq.attempt.started', attemptId }`, `{ type: 'aiq.attempt.submitted', attemptId, summary }`, `{ type: 'aiq.height', px }` (auto-resize), `{ type: 'aiq.ready', tenantId, assessmentId }` (initial handshake), `{ type: 'aiq.error', code, message }`, `{ type: 'aiq.close-blocked', reason }` (response to close-request when attempt in progress)
- Host → AssessIQ: `{ type: 'aiq.theme', tokens: {...} }` (runtime theming), `{ type: 'aiq.locale', locale: 'en-IN' }`, `{ type: 'aiq.close-request' }` (host wants to close iframe)
- Origin pinned via `tenant.embed_origins` allowlist (see spec-drift note below)
- Full TypeScript type definitions for all message types: `modules/12-embed-sdk/SKILL.md` § D3

> **Phase 4 spec drift — RESOLVED (2026-05-03 commit `b20858b`).**
>
> Two gaps that existed as "spec drift" before Phase 4 have been resolved:
>
> 1. **`tenants.embed_origins` column** — Migration `0070_embed_origins.sql` adds `embed_origins TEXT[] NOT NULL DEFAULT '{}'` to `tenants` with a GIN index. The `/embed` handler reads this column via `getEmbedOrigins()` and builds a per-tenant `frame-ancestors` CSP.
>
> 2. **`frame-ancestors 'none'` override** — The Fastify `/embed` handler sets `reply.header('Content-Security-Policy', 'frame-ancestors ' + origins.join(' '))` and removes `X-Frame-Options`. Caddy in reverse-proxy mode does not overwrite upstream response headers, so the per-tenant header reaches the browser intact. Production smoke test confirmed: `curl -sI '/embed/health'` returns `content-security-policy` from Fastify, not Caddy's `frame-ancestors 'none'` fallback.
>
> 3. **Cookie bridging** — `aiq_embed_sess` (SameSite=None) and `aiq_sess` (SameSite=Lax) are distinct cookies. An `onRequest` hook in `apps/api/src/server.ts` copies the embed cookie value to the standard cookie name so all existing auth-chain middleware works unmodified on embed requests.

### Embed JWT — claim contract

All claims are required. The verifier rejects any token with a missing or wrong-type field before touching the DB. (`modules/01-auth/src/embed-jwt.ts:25-36,188-199`)

| Claim | Type | Constraint |
|---|---|---|
| `iss` | string | Host-app name; free-text label; not verified by AssessIQ |
| `aud` | `"assessiq"` | Hard literal; any other value → rejected immediately |
| `sub` | string | Host's internal user ID |
| `tenant_id` | UUID string | AssessIQ tenant UUID; used to look up the embed secret |
| `email` | string | Candidate email for JIT user lookup/create |
| `name` | string | Display name for JIT user create |
| `assessment_id` | UUID string | AssessIQ assessment UUID |
| `iat` | unix seconds | Must be ≤ now + 5 s (5-second clock-skew allowance) |
| `exp` | unix seconds | Must be > now; `exp − iat` must not exceed 600 s |
| `jti` | UUID string | Replay guard; cached in Redis for `exp − now` seconds |

### Embed secret rotation

`rotateEmbedSecret()` is a two-step atomic operation within a single `withTenant` transaction:

1. Mark the current `status='active'` row as `status='rotated'` (sets `rotated_at = now()`).
2. Insert a new `status='active'` row.

The verification path tries the active key first. On **signature mismatch only**, it falls back to the single most-recent rotated row (`ORDER BY rotated_at DESC LIMIT 1`). Any other failure (`alg` confusion, expired `exp`, wrong `aud`, malformed payload) does NOT trigger the fallback — it rejects immediately. No TTL is enforced on rotated rows in the DB; the 90-day rotation cadence is a convention, not a code constraint. (`modules/01-auth/src/embed-jwt.ts:244-265`, `modules/01-auth/migrations/014_embed_secrets.sql:7-10`)

### Embed JWT — request sequence

```
Host app backend           Browser (iframe)           AssessIQ /embed handler
──────────────────────────────────────────────────────────────────────────────
Build JWT:
  { tenant_id, email, name,
    assessment_id, sub,
    aud:'assessiq',
    exp:now+600, jti:uuid }
Sign HS256 + embed_secret
Set iframe src="…/embed?token=<JWT>"
                           Load iframe
                           GET /embed?token=<JWT>
                           ──────────────────────────────────────────────────▶
                                                  [1] Decode header; alg must be HS256
                                                  [2] Decode + validate all required claims
                                                  [3] Reject if exp-iat > 600s or iat > now+5s
                                                  [4] withTenant(tenant_id):
                                                        load active embed_secret
                                                        jwtVerify(HS256)
                                                        (sig fail only → try rotated once)
                                                  [5] Redis SET NX: aiq:embed:jti:<tid>:<jti>
                                                        → 401 if jti already used (replay)
                                                  [6] resolveJitUser: find or create candidate
                                                  [7] Build per-tenant frame-ancestors CSP
                                                  [8] mintEmbedSession → sessions row (type='embed')
                                                  [9] startAttempt(embedOrigin=true)
                                                  Set-Cookie: aiq_embed_sess
                                                    (SameSite=None; Secure; HttpOnly; Path=/)
                                                  302 → /take/a/<attemptId>?embed=true
                           ◀──────────────────────────────────────────────────
                           (subsequent calls: server bridges aiq_embed_sess → aiq_sess slot)
```

Consumer-facing integration guide: `docs/09-integration-guide.md`.

---

## Flow 4 — API key (back-end integration)

For host applications that don't iframe but call the REST API server-to-server.

```
Authorization: Bearer aiq_live_<32-char-random>
```

- Keys are tenant-scoped, with `scopes` array (e.g. `['attempts:read','results:read','assessments:write']`)
- Server stores `key_hash` (sha256); the full key shown to user only at creation
- Display prefix: first 8 chars (`aiq_live_abc12345…`) for identification in admin UI
- Rate limits: per-key (configurable, default 1000 req/hour) and per-tenant aggregate
- `last_used_at` updated async (don't block requests)
- Rotation: admin creates new key, has 30-day grace period to migrate, then revokes old

**Scope catalog (v1):**
- `assessments:read`, `assessments:write`
- `users:read`, `users:write`
- `attempts:read`, `attempts:write`
- `results:read`
- `webhooks:manage`
- `admin:*` (rare, for full automation)

---

## Flow 4b — Public credential verify (auth-bypass surface)

> **Status: LIVE 2026-05-11 (commit 7208008).** Phase 5 Session 3.

Recruiters and external verifiers check a certificate's authenticity at `GET /verify/:credentialId` — no account, session cookie, API key, or tenant context required.

### Why this is safe without authentication

The route accesses `certificates` via a **GUC-based RLS policy** (`public_verify_lookup`) rather than the standard `withTenant()` + `app.current_tenant` path. The policy covers SELECT only; UPDATE/INSERT/DELETE are never permitted through it. (`modules/18-certification/migrations/0074_public_verify_policy.sql`)

```sql
CREATE POLICY public_verify_lookup
  ON certificates FOR SELECT
  USING (current_setting('app.public_verify', true) = 'true');
```

`withPublicVerifyContext()` opens a transaction, sets the GUC transaction-local (`is_local=true`), runs the callback, and commits. The GUC reverts on COMMIT/ROLLBACK and cannot leak across pool connections. `credential_id` is globally unique across all tenants — no `tenant_id` predicate is needed or added. (`modules/18-certification/src/repository.ts:193-210`)

```
BEGIN
SET LOCAL ROLE assessiq_app                               -- re-engages RLS (dev safety)
SELECT set_config('app.public_verify', 'true', true)     -- transaction-local; auto-reverts
SELECT ... FROM certificates WHERE credential_id = $1    -- public_verify_lookup allows this
COMMIT                                                    -- GUC reverts here
```

### HMAC guard (app-layer)

Every render calls `verifyCertificateSignature()` using `crypto.timingSafeEqual`. Three outcomes, all HTTP 200 when the credential exists:

- **green badge** — HMAC valid, `revoked_at IS NULL`
- **red "Revoked" badge** — `revoked_at IS NOT NULL`; revocation reason is shown
- **red "Invalid Signature" badge** — HMAC mismatch (data tampered post-issuance)

404 is returned only when `credential_id` is unknown. A recruiter who sees "Revoked" knows the credential existed but was invalidated — they do not mistake it for a forgery. (`modules/18-certification/src/routes-public.ts:327-368`)

### Rate limiting and view dedup

- Per-IP: 60 req/hour, fixed-window, in-memory, 10 000-bucket cap. (`routes-public.ts:54-56`)
- Per-(IP, credentialId) view dedup: 1 h window, 50 000-entry cap. (`routes-public.ts:96-97`)
- `verification_views` counter: fire-and-forget via a **separate** `withTenant()` transaction; the main request path uses `withPublicVerifyContext` and never sets `app.current_tenant`. (`routes-public.ts:355-361`)

### Request sequence

```
Recruiter / LinkedIn crawler     apps/api (no authChain, no tenant middleware)
────────────────────────────────────────────────────────────────────────────────
GET /verify/<credential_id>
────────────────────────────────────────────────────────────────────────────────▶
                                 [1] CREDENTIAL_ID_REGEX validation → 404 HTML on fail
                                 [2] Per-IP rate limit → 429 JSON on exceed
                                 [3] withPublicVerifyContext():
                                       BEGIN
                                       SET LOCAL ROLE assessiq_app
                                       set_config('app.public_verify','true',true)
                                       SELECT by credential_id (no tenant_id predicate)
                                       COMMIT
                                 [4] null → 404 HTML
                                 [5] revoked_at IS NOT NULL → 200 HTML (red revoked badge)
                                 [6] verifyCertificateSignature (timingSafeEqual)
                                       mismatch → 200 HTML (red invalid badge)
                                       match   → 200 HTML (green verified badge)
                                 [fire-and-forget] withTenant(cert.tenant_id) → views++
◀────────────────────────────────────────────────────────────────────────────────
No session cookie set or consumed. No auth header. No app.current_tenant in main path.
```

Routes are registered by `registerVerifyRoutes(app)` at `apps/api/src/server.ts:239-241` with no `authChain` argument. The global `tenantContextMiddleware` auto-skips when `req.session?.tenantId` is `undefined` (`modules/02-tenancy/src/middleware.ts:84-86`).

Also ships: `GET /verify/:credentialId/og.svg` — 1200×630 SVG for LinkedIn link previews; `Cache-Control: public, max-age=3600`. Same RLS path, same HMAC check. (`routes-public.ts:374-424`)

---

## Flow 6 — Candidate magic-link login

> **Status: LIVE 2026-05-13 (Phase 5).** Migration `0076_candidate_login_tokens.sql` applied to production. Routes `POST /api/auth/candidate/request-link` and `POST /api/auth/candidate/verify-link` registered in `apps/api/src/routes/auth/candidate.ts`. Implementation in `modules/01-auth/src/candidate-login.ts`. See `modules/01-auth/SKILL.md` § Candidate magic-link login.
>
> **Why the verify endpoint is POST, not GET.** Email-preview crawlers (Gmail, Outlook, Slack, Teams) prefetch link URLs with GET to render previews and scan for malware. A GET verify-link would consume the single-use token on prefetch, before the candidate ever clicked. The email link therefore points at a SPA route `/candidate/login/verify?token=…`, which is safe to prefetch (it returns HTML); the actual verification is a POST from that page's JavaScript, which crawlers do not execute. Crawlers also don't follow `Set-Cookie` headers, so even a successful crawler GET wouldn't mint a session — but the token would be burned, locking the real candidate out.

This flow lets a candidate sign in to view their certificates at `/candidate/certificates` without a password. It is deliberately separate from the assessment-taking magic link (Flow 2 / `/take/:token`): that link is invitation-scoped and single-use-per-attempt; this login link is identity-scoped and produces a long-lived 30-day session so candidates can return to their certificate portfolio at any time without admin re-intervention.

The trigger is the candidate navigating to `/candidate/login` on their own — either via a "View my certificates" link in a notification email or directly. There is no admin action required per login; the admin only needs to have previously registered the candidate as a `users` row in the tenant.

```
┌──────────┐              ┌────────────┐              ┌────────────┐
│ Browser  │              │ AssessIQ   │              │  Email     │
└────┬─────┘              └─────┬──────┘              └─────┬──────┘
     │                          │                           │
     │ GET /candidate/login      │                           │
     ├─────────────────────────▶│                           │
     │  200 — login page (email input)                      │
     │◀─────────────────────────┤                           │
     │                          │                           │
     │ POST /api/auth/candidate/request-link                │
     │  { email: "candidate@example.com",                   │
     │    tenant_slug: "wipro-soc" }                        │
     ├─────────────────────────▶│                           │
     │                          │ Resolve slug →            │
     │                          │  tenant_id (system role)  │
     │                          │ withTenant(tenant_id):    │
     │                          │  Look up users by email   │
     │                          │  under RLS (Fix 1)        │
     │                          │ If found: generate        │
     │                          │  token = randomBytes(32)  │
     │                          │  store sha256(token) +    │
     │                          │  expires_at = now+15min   │
     │                          │  in candidate_login_tokens│
     │                          │  emit auth.candidate.     │
     │                          │   login_link_requested    │
     │                          ├──────────────────────────▶│
     │                          │  Send email: click link   │
     │                          │  → /candidate/login/      │
     │                          │    verify?token=<t>       │
     │                          │  (SPA route, crawler-safe)│
     │  204 (always — even if email not found)              │
     │◀─────────────────────────┤                           │
     │                          │                           │
     │  (candidate clicks link in email → SPA loads)        │
     │  GET /candidate/login/verify?token=<t>               │
     │  → SPA JS reads ?token=, then POSTs:                 │
     │                          │                           │
     │ POST /api/auth/candidate/verify-link  {token}        │
     ├─────────────────────────▶│                           │
     │                          │ Destroy prior aiq_sess    │
     │                          │  cookie if present        │
     │                          │  (Fix 4, fire-and-forget) │
     │                          │ sha256(token) lookup in   │
     │                          │  candidate_login_tokens   │
     │                          │  WHERE consumed_at IS NULL│
     │                          │  AND expires_at > now()   │
     │                          │ atomic UPDATE consumed_at │
     │                          │  = now() RETURNING id     │
     │                          │ sessions.create(          │
     │                          │  role='candidate',        │
     │                          │  totpVerified=true,       │
     │                          │  expiresAt=now+30d)       │
     │                          │ emit auth.candidate.      │
     │                          │   login_link_consumed     │
     │  Set-Cookie: aiq_sess (httpOnly,Secure,SameSite=Lax) │
     │  200 { ok: true, redirect: '/candidate/certificates' }│
     │◀─────────────────────────┤                           │
     │  (SPA navigates to /candidate/certificates)          │
     │                          │                           │
     │  (failure path — token invalid/expired/consumed)     │
     │  200 { ok: false, error: 'invalid_link' }            │
     │◀─────────────────────────┤                           │
     │  (SPA navigates to /candidate/login?error=invalid_link)│
```

### Session cookie spec for candidate sessions

The session produced by this flow uses the same `aiq_sess` cookie as admin and assessment-taking sessions; the role discriminator inside the session (`role='candidate'`) is what `requireAuth` checks.

| Property | Value |
|---|---|
| Cookie name | `aiq_sess` |
| Value | 32-byte CSPRNG; only `sha256` hash stored in DB |
| Flags | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| Lifetime | **30 days fixed** — NOT sliding. `extends_at` is never updated on access. |
| `totpVerified` | `true` — the magic link itself is the authentication factor; no TOTP step |
| Role | `candidate` |
| `session_type` | `standard` (not `embed`) |

The 30-day fixed lifetime is intentional and differs from the 8-hour sliding admin session. Candidates are not expected to visit daily; a long fixed window avoids forcing re-auth on infrequent returners. Idle eviction (the 60-minute `lastSeenAt` check in sessionLoader) is **disabled** for candidate sessions — see `modules/01-auth/src/candidate-login.ts` for the `skipIdleEviction: true` flag on `sessions.create`.

### Anti-enumeration

`POST /api/auth/candidate/request-link` returns `204 No Content` regardless of whether the submitted email address matched, the tenant slug was valid, or the rate limit was exceeded. This is intentional: callers must never be able to distinguish "found" from "not found" or "slug valid" from "slug invalid" via HTTP responses.

**Timing oracle defence (Fix 3 — 2026-05-13):** The no-match path (slug miss before any DB work) was measurably faster than the match path (slug resolve + RLS user SELECT + token INSERT + audit + email enqueue). `requestCandidateLoginLinkSystem` now wraps all work in `Promise.all([actualWork, sleep(200)])` so both paths complete in ≥ 200 ms. The 200 ms floor swamps the ~10–50 ms timing difference at network noise levels.

Do not add any response field that differentiates "email found" from "email not found". If a future feature requires a "we could not find that address" UX, it must be implemented with a server-side hint that is time-limited and authenticated (e.g., a short-lived signed cookie), not an inline HTTP body diff.

### Rate limits

| Dimension | Limit | Window | Notes |
|---|---|---|---|
| Per (IP, email) | 5 requests | 60 minutes | Fixed-window Redis counter `aiq:rl:cand-login:<ip>:<sha256(lower(email))>`; checked before any DB work in `requestCandidateLoginLinkSystem` |
| Response on exceed | `204 No Content` | — | Anti-enumeration: returning 429 would leak whether an email is active. The request is silently dropped. |
| Token TTL | 15 minutes | — | `candidate_login_tokens.expires_at = now() + interval '15 minutes'` |
| Token cardinality | Single-use | — | Atomic `UPDATE … WHERE consumed_at IS NULL RETURNING id`; a second click returns no row → redirect to `/candidate/login?error=invalid_link` |

**Rate-limit key design:** The email component of the Redis key is `sha256(lower(email))` — the raw email address is never written to Redis keyspace, logs, or memory dumps. Only the IP component is plaintext (IPs are already logged by Caddy/Fastify).

Unconsumed, expired tokens are swept by the existing session expiry sweeper (Phase 3 follow-up). The partial index `candidate_login_tokens_user_unconsumed_idx ON (user_id) WHERE consumed_at IS NULL` keeps the live-token lookup fast even with a long history of expired rows.

### Mobile rendering (M1 — 2026-05-20)

The candidate magic-link UI (`/candidate/login`, `/candidate/login/verify`) is mobile-tuned via CSS only; **no flow, no API, no semantics change.** Under `[data-viewport="mobile"]` (M0 mechanism — see [`docs/10-branding-guideline.md` § 15](./10-branding-guideline.md#15-mobile)) the two-pane layout collapses to a single column, the right aside is hidden via `display: none`, and `<main>` padding shrinks from `48px 64px` to `24px 22px`. `CandidateLoginVerify` (centered spinner) is viewport-agnostic and unchanged.

Anti-enumeration timing, rate-limit copy, the unconditional 204 response, and the magic-link token semantics are identical across viewports. See [`docs/10-branding-guideline.md` § 15.3](./10-branding-guideline.md#153-pattern-reflows-catalog--populated-incrementally-by-later-phases) for the full reflow catalog entry.

---

## Flow 5 — Future auth methods (designed in)

Tenant admin opens *Settings → Authentication* and toggles:

| Method | Phase | Notes |
|---|---|---|
| Google SSO | 1 (default) | OIDC; domain restrict via `hd` param |
| TOTP MFA | 1 (default for admin) | RFC 6238; recovery codes; admin can require for candidates too |
| Magic link | 2 | Single-use email link, 72h TTL |
| Microsoft Entra ID | 2 | OIDC; for Wipro internal deployment |
| Generic OIDC | 2 | Bring-your-own provider config |
| SAML 2.0 | 3 | For enterprise clients with legacy IdPs |
| Password (email + pwd) | 3 | Argon2id, min 12 chars, breach-list check (HIBP API), only enabled if SSO not viable |
| Passkeys / WebAuthn | 4 | Replaces TOTP for users who opt in |

Each method is a Fastify plugin under `01-auth/providers/`. The `tenant_settings.auth_methods` JSONB tells the login page which buttons to show. Adding a new method is: add a provider plugin + add to the toggle UI + add to tenant settings JSON schema.

---

## Token & secret storage standards

| Secret | Storage | Reveal policy |
|---|---|---|
| Session cookie value | sha256 hashed in `sessions.token_hash` | Never revealed after issuance |
| TOTP secret | AES-256-GCM in `user_credentials.totp_secret_enc` | Never revealed after enrollment (QR shown once) |
| Recovery codes | argon2id hashed | Plaintext shown once at generation |
| API keys | sha256 hashed | Plaintext shown once at creation |
| Embed secrets | AES-256-GCM | Plaintext shown once at creation |
| Passwords (if used) | argon2id (m=64MB, t=3, p=4) | Never revealed |
| Webhook signing secrets | AES-256-GCM | Plaintext shown once |

Master encryption key: 32-byte random, in env var `ASSESSIQ_MASTER_KEY` (base64). For v1, plain env file with strict perms (0600, owned by service user). For v2, integrate Doppler / Vault.

## Security must-do checklist

- [ ] Verify every JWT signature (no `alg: none` ever)
- [ ] CSRF protection on state-changing routes (double-submit cookie)
- [x] **Role-aware IP rate limiting on all routes** (2026-05-15) — four-tier design, see § below
- [ ] Account lockout after 5 failed TOTP attempts in 15 min

## Tenant + User lifecycle state machines (Phase B + Phase C, 2026-05-20)

Commits: `ae89669` (Phase B — tenant lifecycle), `2af9849` + `a888a43` (Phase C — user lifecycle + super-admin drill-down).

### Tenant state machine

States: `provisioning`, `active`, `suspended`, `archived`.

**Allowed transitions** (source arrays from `performLifecycleTransition` in [`modules/02-tenancy/src/service.ts:366–444`](modules/02-tenancy/src/service.ts#L366)):

| Transition | Trigger | Session effect |
|---|---|---|
| `provisioning` → `active` | First admin invite accepted (separate onboarding flow) | — |
| `active` → `suspended` | `POST /api/admin/super/tenants/:tenantId/suspend` | `destroyAllForTenant` |
| `active` → `archived` | `POST /api/admin/super/tenants/:tenantId/archive` | `destroyAllForTenant` |
| `suspended` → `active` | `POST /api/admin/super/tenants/:tenantId/resume` | none |
| `suspended` → `archived` | `POST /api/admin/super/tenants/:tenantId/archive` | `destroyAllForTenant` |
| `archived` → `active` | `POST /api/admin/super/tenants/:tenantId/unarchive` | none |

**Disallowed transitions** (throw `ConflictError { code: "INVALID_LIFECYCLE_TRANSITION" }`):

- `provisioning` → `suspended` / `archived`
- `archived` → `suspended`

Any transition where source equals target is **idempotent**: the endpoint returns `200` with `noOp: true`, no audit row is written, and no session sweep runs.

**Session revocation.** `suspend` and `archive` both call `sessions.destroyAllForTenant(tenantId)` ([`modules/01-auth/src/sessions.ts:296–323`](modules/01-auth/src/sessions.ts#L296)) immediately after the DB status flip. The sweep collects all `user_id`s with active Postgres session rows for the tenant, then calls `destroyAllForUser` per user — clearing both the Redis hash keys and the Postgres `sessions` rows — so every active cookie becomes invalid on the very next request. This is defence-in-depth: even a cookie-holder who did not observe the suspend cannot reuse their session. `resume` and `unarchive` do **not** recreate sessions; affected users must sign in again normally.

---

### User state machine

States: `pending`, `active`, `disabled` (the `users.status` column) plus the orthogonal `deleted_at IS NOT NULL` soft-delete flag. The two axes are independent: a user can be `disabled` and then soft-deleted, or `active` and soft-deleted.

**Allowed transitions** (source: [`modules/03-users/src/invariants.ts:70–83`](modules/03-users/src/invariants.ts#L70) for status, service layer for soft-delete/restore):

| Transition | Trigger | Session effect |
|---|---|---|
| `pending` → `active` | `acceptInvitation` (magic-link; out of scope here — see Flow 1a / 2) | — |
| `pending` → `disabled` | admin revoke-before-accept via `PATCH status=disabled` | none (no sessions yet) |
| `active` → `disabled` | `POST /api/admin/users/:id/disable` (tenant-admin) or `POST /api/admin/super/users/:userId/disable` (super-admin) | `sweepUserSessions(userId)` |
| `disabled` → `active` | `POST /api/admin/users/:id/reenable` / `…/super/…/reenable` | — |
| `active` → soft-deleted (`deleted_at` set) | `DELETE /api/admin/users/:id` / `…/super/…/:userId` | `sweepUserSessions(userId)` + cascades pending invitations |
| `disabled` → soft-deleted | same endpoints | `sweepUserSessions(userId)` + cascades pending invitations |
| soft-deleted → (prior status) | `POST /api/admin/users/:id/restore` / `…/super/…/restore` | none; status column unchanged |

`restore` clears `deleted_at` only — the `status` column reverts to whatever it was before deletion (could be `active` or `disabled`). Pending invitations are **not** recreated on restore.

**Last-admin invariant.** Cannot disable or soft-delete the last `active` + `role='admin'` + `deleted_at IS NULL` user in a tenant. Enforced by `assertNotLastAdmin` ([`modules/03-users/src/invariants.ts:19–51`](modules/03-users/src/invariants.ts#L19)) on the tenant-admin path via a `FOR NO KEY UPDATE` CTE to prevent TOCTOU races. The super-admin path inlines its own equivalent SQL ([`apps/api/src/routes/admin-super.ts:1154–1173`](apps/api/src/routes/admin-super.ts#L1154)) and bypasses when `confirm_last_admin: true` **and** `reason` is non-empty — details.code remains `"LAST_ADMIN"` on refusal. The `assertNotLastAdmin` function itself is never called from the super-admin path.

**Self-action guards.** The tenant-admin path (`apps/api/src/routes/admin-users.ts`) throws `ConflictError { code: "CANNOT_DISABLE_SELF" }` and `{ code: "CANNOT_DELETE_SELF" }` when the actor targets their own user record. The super-admin path has no equivalent guard: `super_admin` sessions carry the platform tenant context and do not live inside any company tenant, so the guard does not apply.

---

### Session-loader enforcement contract

Every authenticated request runs `userIsActive` then `tenantIsActive` inside `sessionLoaderMiddleware` ([`modules/01-auth/src/middleware/session-loader.ts:86–178`](modules/01-auth/src/middleware/session-loader.ts#L86)), after the Redis session lookup and idle-eviction check.

Both functions throw `AuthnError("session rejected")` on failure; the session token is destroyed before the throw so the cookie cannot be replayed.

**Structured `details` payload:**

| `details.scope` | `details.reason` | Condition |
|---|---|---|
| `"user"` | `"inactive"` | `users.status !== 'active'` OR `users.deleted_at IS NOT NULL` ([`session-loader.ts:52`](modules/01-auth/src/middleware/session-loader.ts#L52)) |
| `"user"` | `"check_failed"` | DB error during user check — fail-closed ([`session-loader.ts:139`](modules/01-auth/src/middleware/session-loader.ts#L139)) |
| `"tenant"` | `"inactive"` | `tenants.status NOT IN ('active', 'provisioning')` ([`session-loader.ts:75`](modules/01-auth/src/middleware/session-loader.ts#L75)) |
| `"tenant"` | `"check_failed"` | DB error during tenant check — fail-closed ([`session-loader.ts:161`](modules/01-auth/src/middleware/session-loader.ts#L161)) |

User check runs **first** — a disabled user receives a `scope: "user"` error even if their tenant is also suspended, keeping the error scope unambiguous.

**Error-message hygiene.** The `AuthnError` message is intentionally the generic string `"session rejected"` for both scopes. A cookie-holding attacker cannot distinguish "my account was disabled" from "my tenant was suspended" via the error string. The `details.scope` field is surfaced in the API error envelope for **internal observability** (server logs, operator tooling) and is the contract Phase D will use to render state-aware copy on post-auth screens. State-aware copy is not a security boundary — operators may still observe the scope via logs.

`tenantIsActive` allows both `'active'` and `'provisioning'` — the latter permits the `createTenant` orchestration window (seed + invite steps) without blocking the first admin's session mid-flow.

---

### Audit log emissions

Source: [`modules/14-audit-log/src/types.ts`](modules/14-audit-log/src/types.ts) `ACTION_CATALOG`.

**Tenant lifecycle actions:**

- `tenant.suspended` — active → suspended
- `tenant.resumed` — suspended → active
- `tenant.archived` — active/suspended → archived
- `tenant.unarchived` — archived → active
- `tenant.purged` — forward-compat for 6-month retention purge; wired in a later phase

**User lifecycle actions:**

- `user.disabled` — active → disabled
- `user.reenabled` — disabled → active
- `user.soft_deleted` / `user.deleted` — any status → soft-deleted. The catalog keeps both names for backward compatibility:
  - Tenant-admin path: `auditInTx` (audit_log) emits `user.deleted`; `logLifecycleEvent` (operational JSONL) emits `user.soft_deleted`.
  - Super-admin path: BOTH channels emit `user.soft_deleted`.
  - Catalog comment in [`modules/14-audit-log/src/types.ts:157`](modules/14-audit-log/src/types.ts#L157) notes the two are functionally equivalent — the duplicate exists so admin queries scoped to `user.deleted` don't miss historic rows.
- `user.restored` — soft-deleted → prior status
- `user.invitation_cancelled` — pending invitation explicitly cancelled before acceptance

Audit rows are written inside the **same `withTenant` transaction** as the status mutation via `auditInTx` — if the audit write fails, the status change rolls back. No-op transitions (idempotent same-state calls) do not emit an audit row.

**Override rows.** When the super-admin bypass path is used (`confirm_last_admin: true` + non-empty `reason`), the audit row's `after` JSONB column includes `is_override: true` ([`admin-super.ts:1199`](apps/api/src/routes/admin-super.ts#L1199), [`admin-super.ts:1412`](apps/api/src/routes/admin-super.ts#L1412)). `logLifecycleEvent` emits at `WARN` level when `isOverride=true` ([`admin-super.ts:1066`](apps/api/src/routes/admin-super.ts#L1066)).

---

### Lifecycle carry-forwards (not in this commit)

- **Mint-time `assertTenantActive` on magic-link / SSO / email-OTP session creation.** Session creation endpoints do not call `assertTenantActive` at mint time. A suspended tenant's new-login attempt is not blocked at the `createSession` call — it is blocked by `sessionLoaderMiddleware` on the very next authenticated request (so no privilege escalation is possible), but the minted cookie exists for a brief window before the next request evicts it. Listed as a carry-forward hardening pass.
- **Provisioning TTL.** There is no TTL on `tenants.status = 'provisioning'`. A tenant whose first admin never accepts the invitation will sit in `provisioning` indefinitely; a background cleanup sweep is not implemented.
- **Phase D state-aware copy.** The frontend does not yet render different UI copy for `details.scope = "user"` vs `"tenant"`. The structured field exists in the error envelope so it can be wired to Phase D screens without a backend change.

## Role-aware IP rate limiting

> **Status: LIVE 2026-05-15** — redesign replaces the 2026-05-04 opt-in bypass. See `modules/01-auth/src/middleware/rate-limit.ts` + `apps/api/src/middleware/auth-chain.ts`.

### Design

Role is resolved per-request from `req.session.role`, `req.apiKey`, or anonymous fallback:

| Tier | Bucket max (default) | Env var | Scope |
|---|---|---|---|
| admin / reviewer session | 100 req/min/IP | `RATE_LIMIT_IP_ADMIN` | **All routes** |
| candidate session | 30 req/min/IP | `RATE_LIMIT_IP_USER` | **All routes** |
| anonymous (no session, no key) | 30 req/min/IP | `RATE_LIMIT_IP_ANON` | **All routes** |
| API key (`Authorization: Bearer aiq_live_*`) | 600 req/min/IP | `RATE_LIMIT_IP_APIKEY` | **All routes** |
| Per-user | 60 req/min | — (unchanged) | Authenticated sessions |
| Per-tenant | 600 req/min | — (unchanged) | Authenticated + API-key |

All four `RATE_LIMIT_IP_*` env vars are optional — `00-core` Zod config provides safe defaults via `.default(N)`, so existing deploys work without `.env` changes.

### Chain order (unchanged from 2026-05-04)

`sessionLoader` runs before `rateLimit` so `resolveIpBucketMax(req)` can read `req.session.role` when choosing the bucket max. Anonymous requests (no `aiq_sess` cookie) short-circuit sessionLoader in <1 ms — no Redis hit.

### Bypass — removed

`allowVerifiedAdminBypass: boolean` in `rateLimitMiddleware(opts)` and `authChain({ allowVerifiedAdminBypass })` is **gone** as of this redesign. There is no opt-in per-route bypass; the IP bucket scales automatically with the session role.

The old bypass predicate required `session.totpVerified === true`, which was **never true** while `MFA_REQUIRED=false` (production default). The bypass was effectively dead code in production, causing every admin login flow (`/start` → `/cb` → `/whoami` × retries) to hit the old 10/min/IP cap and 429 itself.

### Path N decision — TOTP/recovery endpoints not special-cased

`POST /api/auth/totp/verify`, `POST /api/auth/totp/recovery`, `POST /api/auth/totp/enroll/confirm` are **not** given a separate tighter IP bucket. Admin/reviewer sessions hit 100/min/IP on these routes, same as all other routes.

**Security posture:** an attacker on `/api/auth/totp/verify` must already hold a **pre-MFA session** (valid `aiq_sess` with `totpVerified=false`), which requires controlling the Google identity that minted it. The effective rate is `min(IP_bucket, user_bucket)` = 60/min (user bucket, unchanged). The **5-fail-in-15min account-lockout** (decision #4) is the primary TOTP brute-force defense and remains unchanged.

**Brute-force window regression:** old design — 10/min/IP on auth routes → ~35 days before lockout triggers at anon rate. New design — 30/min anon, 100/min verified admin → ~3.5 days at admin rate before lockout. Deliberate regression, accepted by user on 2026-05-15. Pinned in `modules/01-auth/src/__tests__/middleware.test.ts` test "admin gets 100/min/IP on TOTP verify (Path N — blacklist dropped per user decision 2026-05-15, brute-force window ~3.5 days)".

### Production override — admin IP cap 100 → 500 (2026-05-20)

**What changed:** `RATE_LIMIT_IP_ADMIN=500` set in `/srv/assessiq/.env` on the production VPS. Code default in `modules/00-core/src/config.ts` stays at 100 — dev/test/CI continue at the conservative default; only prod takes the higher cap.

**Why:** operator-observed real 429s during normal admin navigation. Log analysis of the burning IP showed `/api/auth/whoami` re-fetched on every nav (50 calls / 10 min from a single user), plus dashboard `/api/admin/dashboard/queue` polling (~22/10 min), plus the natural Google SSO / MFA / logout cycles during testing. Combined, a single admin's session can sustain >100 req/min in 60s windows during legitimate use. 100/min was tuned for the *security-only* tradeoff; under real client-side traffic patterns it is over-tight.

**Considered and rejected:**

- *Stay at 100/min and fix the `whoami` spam.* Still the right structural fix (cuts ~40% of admin request volume), but it is its own session — separating it from this immediate UX unblock.
- *Raise the code default to 500.* Rejected: it weakens dev/test/CI's ability to catch a client-side request storm early. Env override keeps the safety net in non-prod.
- *Raise per-user (60/min) or per-tenant (600/min) instead.* Doesn't help — the bucket actually exhausting is the per-IP one (the most restrictive of the three for a single admin).

**Not included:** ANON (30/min), USER/candidate (30/min), and APIKEY (600/min) tiers unchanged — none have shown legitimate-traffic 429s. Code defaults in `00-core` unchanged. `trustProxy:true` and origin-verify gate unchanged.

**Security trade-off (accepted):**

- Brute-force window per IP: ~3.5d → ~0.7d for a single TOTP (5× the rate).
- **Primary TOTP defense is unchanged:** the 5-failures-in-15-min per-user lockout (counter `aiq:auth:totpfail:<userId>` + `aiq:auth:lockedout:<userId>` TTL 15m) keeps any one user's TOTP at ~2.85 years to brute-force *regardless of the IP limit*. The IP bucket is a *mass-scale* throttle (one IP probing many users), not the per-TOTP defense.
- Origin-verify `enforce` is live (`3b2fe73`, 2026-05-19) — IP spoofing via direct-to-origin is blocked, so the 500/min only applies to verified Cloudflare traffic. An attacker can't trivially rotate IPs to evade.
- Net: this loosens mass-scale single-IP throttling 5×, which is the right tradeoff because the per-user lockout already carries the primary defense.

**Supersedes** the "100/min admin / ~3.5d brute-force window" sentence above **for production only**. Dev/test still sees 100/min. Reverse on prod by removing the `.env` line and `force-recreate assessiq-api`; timestamped `.env.bak.<TS>` backups exist on the VPS.

**Downstream impact:** the `middleware.test.ts` PathN test updated (2026-05-20) to use `totpVerified: false` explicitly; the credential bucket test was added as PathN-Credential. Future tuning should revisit if (a) the per-user lockout decision #4 ever changes, or (b) origin-verify ever drops from `enforce`. Both invariants would need to be re-reasoned together.

### Tiered model by auth state (2026-05-20 redesign)

**Status: LIVE 2026-05-20** — shifts the model from single-cap-by-role to a two-layer model: a per-IP cap that scales with MFA state, plus an immovable per-route credential cap that protects TOTP/OTP endpoints regardless of tier.

#### What changed

Three new env vars added to `modules/00-core/src/config.ts`, three new rate-limit buckets in `modules/01-auth/src/middleware/rate-limit.ts`:

| Bucket | Key | Default | Applies to | Condition |
|---|---|---|---|---|
| IP — verified admin | `aiq:rl:ip:<ip>` | `RATE_LIMIT_IP_VERIFIED_ADMIN=5000/min` | All routes | role∈{admin,reviewer,super_admin} AND `totpVerified===true` |
| Per-user — verified admin | `aiq:rl:user:<userId>` | `RATE_LIMIT_USER_VERIFIED_ADMIN=300/min` | Authenticated routes | Same condition |
| Credential | `aiq:rl:cred:<routePath>:<ip>` | `RATE_LIMIT_CREDENTIAL=20/min` | 5 credential routes only | ALWAYS (regardless of session tier) |

**Pre-MFA admin (`totpVerified !== true`) is byte-identical to before:** IP cap stays at `RATE_LIMIT_IP_ADMIN` (100/min code default, 500/min prod override), user cap stays at 60/min.

Credential routes with `credentialEndpoint: true` (the 9 token/credential-consuming endpoints — expanded from the original 5 after the 2026-05-20 adversarial review surfaced 4 additional surfaces):

- `POST /api/auth/totp/enroll/start` (`apps/api/src/routes/auth/totp.ts`) — generates fresh TOTP secret; defense-in-depth against rapid secret cycling (adversarial finding 1)
- `POST /api/auth/totp/enroll/confirm` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/totp/verify` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/totp/recovery` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/login/email/request` (`apps/api/src/routes/auth/google.ts`)
- `POST /api/auth/login/email/verify` (`apps/api/src/routes/auth/google.ts`)
- `GET /api/auth/login/identities` (`apps/api/src/routes/auth/google.ts`) — reads continuation token, consistency with other token-consuming endpoints (adversarial finding 5)
- `POST /api/auth/login/select` (`apps/api/src/routes/auth/google.ts`) — consumes continuation token + chooses identity (adversarial finding 2)
- `POST /api/auth/candidate/verify-link` (`apps/api/src/routes/auth/candidate.ts`) — magic-link consume (adversarial finding 4)

**super_admin tier inclusion (behaviour change for an already-rare role):** the pre-2026-05-20 code at `rate-limit.ts:106` listed only `admin || reviewer` for the admin tier — `super_admin` fell through to the conservative candidate-tier IP cap (30/min). The redesign explicitly adds `super_admin` to the admin role set (`role === "admin" || role === "reviewer" || role === "super_admin"`) so a verified super_admin gets the same 5000/min tier as a verified tenant admin. No practical regression: super_admin sessions were migration-blocked until 2026-05-17 (`obs 3106`), so this changes a previously-broken-then-30/min-throttled tier to the intended 5000/min for the platform-administration role.

**Credential bucket key construction (adversarial finding 3):** the per-route bucket key is built from `req.routeOptions?.url ?? "unknown"`. The `req.url` fallback was REMOVED — `req.url` includes query params, which would let an attacker vary the query (`?nonce=1`, `?nonce=2`…) to mint fresh per-query buckets and defeat the 20/min cap. With the fix, an unmatched route falls into one shared `"unknown"` bucket — strictly safer than an attacker-controllable key.

#### Why

Operator-observed: verified admins (post-MFA) doing normal admin work were being throttled by the same 100/min cap as brute-force attackers. The redesign separates concerns:
- **Verified admin** → relaxed IP cap (5000/min, DoS ceiling only); per-user (300/min) and credential (20/min) are the actual meaningful constraints.
- **Brute-force surface (credential endpoints)** → IMPROVED from 100/min to 20/min. The IP lift for verified admins does not weaken TOTP protection because the credential bucket is unconditional.
- **Everyone else** → unchanged.

#### What was considered and rejected

- *Apply the credential cap to ALL routes for all tiers.* Rejected — the goal is targeted protection for credential endpoints, not global tightening. Credential cap on non-credential routes would throttle legitimate admin workflows.
- *Raise per-user from 60 to 300 for all admins (not just verified).* Rejected — pre-MFA sessions are lower-assurance; conservative 60/min is correct until TOTP is proven.
- *Configurable per-route caps.* Rejected — scope creep. The credential cap is a security invariant, not a tuning knob. Making it per-route invites drift.
- *Use the existing `RATE_LIMIT_IP_ADMIN` at a higher value.* Rejected — conflates pre-MFA and post-MFA admins into one bucket; the redesign preserves independent control.

#### What is NOT included

- Verified-admin bypass of the credential cap. The 20/min credential cap is unconditional by design — there is no `credentialEndpointBypass` option and none will be added.
- Dynamic credential cap (auto-tighten on surge). Not included; account-lockout (decision #4) handles per-user surge.
- Candidate-session differentiation from pre-MFA admin at the IP layer. Both stay at their existing tiers.

#### Downstream impact

- `modules/00-core/src/config.ts`: three new Zod env vars (`RATE_LIMIT_IP_VERIFIED_ADMIN`, `RATE_LIMIT_USER_VERIFIED_ADMIN`, `RATE_LIMIT_CREDENTIAL`).
- `modules/01-auth/src/middleware/rate-limit.ts`: `resolveIpBucketMax` updated; `RateLimitOptions.credentialEndpoint` added; `Limit.scope` extended with `"credential"`; per-user bucket is tier-aware; `resolveIpBucketMax` exported (was already exported since 2026-05-15 redesign).
- `apps/api/src/middleware/auth-chain.ts`: `credentialEndpoint` option added to `AuthChainOpts`; `_rateLimitCredential` instance + `publicCredentialAuthChain` export added.
- `apps/api/src/routes/auth/totp.ts`: `credentialEndpoint: true` added to all three TOTP routes.
- `apps/api/src/routes/auth/google.ts`: email-OTP routes switch from `publicAuthChain` to `publicCredentialAuthChain`.
- `modules/01-auth/src/__tests__/rate-limit-tiered.test.ts`: NEW — Redis-free unit coverage for T1-T9 (IP tier, user tier, credential bucket composition).
- `modules/01-auth/src/__tests__/middleware.test.ts`: PathN test updated; PathN-Credential added.
- `modules/00-core/src/__tests__/config.test.ts`: three default tests + three override tests + three invalid tests added.
- `.env.example`: three new vars with comments.

#### 2026-05-22 — anon IP cap raised 30 → 120 (login-screen 429 fix)

`RATE_LIMIT_IP_ANON` default raised 30 → **120/min** (`modules/00-core/src/config.ts`, commit `ad88f72`). The anonymous tier gates the ENTIRE pre-auth surface — every load/return to a protected `/admin/*` route fires a `GET /api/auth/whoami` probe (`RequireSession`), and the login/MFA flow is anonymous until the cookie is set. At 30/min a single admin reloading the live login page (or several users behind one NAT) exhausted it and got `RATE_LIMITED (scope=ip)` **on the login screen** — before they could reach MFA and the 5000/min verified-admin tier. 120/min is a DoS knob only; credential brute-force stays on the unconditional 20/min credential bucket above, unaffected. Not pinned in prod `.env`, so the code default applies. The frontend pairs this with the Phase D `whoami` 429-backoff (commit `60d4d23`; honours `retryAfterSeconds`, no re-fire storm). Full RCA: `docs/RCA_LOG.md` 2026-05-22 "429 on the admin login screen". NB: the "What changed vs 2026-05-04" comparison table below still reads "100/30/30/600 per tier" for the historical redesign — **anon is now 120**.

### Redis key

Old: `aiq:rl:auth:ip:<ip>` (applied to `/api/auth/*` only)
New: `aiq:rl:ip:<ip>` (applies to all routes)

Old keys expire naturally within 60 seconds — no migration script required.

### What changed vs 2026-05-04 design

| Component | Before | After |
|---|---|---|
| IP bucket scope | `/api/auth/*` only | All routes |
| IP bucket max | 10/min (anon), dev=100/min | Role-aware: 100/30/30/600 per tier |
| Bypass mechanism | `allowVerifiedAdminBypass: boolean` opt-in per route | Removed — no bypass |
| Always-strict blacklist | `totp/*`, `google/cb`, `take/start` | Removed — not needed without bypass |
| Env var knobs | None (hardcoded) | `RATE_LIMIT_IP_{ADMIN,USER,ANON,APIKEY}` |
| Redis key | `aiq:rl:auth:ip:<ip>` | `aiq:rl:ip:<ip>` |

### What was considered and rejected

- **Keep bypass but widen predicate to `MFA_REQUIRED=false` path.** Rejected — the opt-in whitelist design requires every new route to opt in; missed routes silently have the wrong limit. Role-aware design is correct-by-default.
- **Separate tighter buckets for TOTP endpoints.** Rejected — account-lockout (decision #4) is the right defense for TOTP brute force; a second bucket adds complexity without meaningful security gain given the session pre-requisite.
- **Configurable per-endpoint limits.** Rejected — scope creep; four-tier role-based design covers all known use cases.

### What is NOT included

- Per-endpoint limit overrides.
- Dynamic limit adjustment (e.g., auto-tighten on failed-login surge).
- Candidate session differentiation from reviewer (both use `RATE_LIMIT_IP_USER` default).

### Downstream impact

- `modules/01-auth/src/middleware/rate-limit.ts`: full rewrite — `resolveIpBucketMax()` replaces `shouldBypassIpBucket()`; Redis key renamed.
- `apps/api/src/middleware/auth-chain.ts`: single `rateLimitMiddleware()` instance; `allowVerifiedAdminBypass` removed from `AuthChainOpts`.
- `apps/api/src/routes/auth/{whoami,google,logout}.ts`: `allowVerifiedAdminBypass: true` removed from `authChain()` calls.
- `modules/00-core/src/config.ts`: four new optional env vars with Zod `.default()`.
- `modules/01-auth/src/__tests__/middleware.test.ts`: B1–B12 bypass tests removed; T1–T5 role-tier + N1 (bypass removal proof) + N2 (non-auth route anon bucket) added.
- [ ] Log every authentication outcome to `audit_log`
- [ ] Periodic session sweeper (purge expired from Redis + Postgres)
- [ ] Force re-auth on email change, role change, password reset
- [ ] HSTS header at edge with preload-eligible config
- [ ] CSP header tight enough to prevent inline-script execution in admin UI

---

## Session-revocation UX — state-aware login banner (Phase D, 2026-05-22, LIVE)

**What:** When a session is destroyed mid-use because the operator suspended/archived the tenant or disabled/deleted the user, `session-loader` (`modules/01-auth/src/middleware/session-loader.ts`) throws a 401 carrying `details.scope` (`"tenant"` | `"user"`) and `details.reason`. The SPA captures that scope on the failing `whoami` (`apps/web/src/lib/session.ts` + the admin-dashboard mirror `modules/10-admin-dashboard/src/session.ts`), stores it single-shot in `sessionStorage` under `aiq.lastAuthScope`, and **both** the admin login (`apps/web/src/pages/admin/login.tsx`) and the candidate login (`apps/web/src/pages/candidate/CandidateLogin.tsx`) read + clear it on mount via the shared helper `apps/web/src/lib/authScope.ts` (`readAuthScopeOnce()` + `authScopeCopy(scope, audience)`) to render a state-aware notice with **audience-tuned copy**:

- `scope: "tenant"` → admin **"Your organisation's access is paused."** (operator-facing body) / candidate same title, calmer body ("Your assessment workspace has been suspended. Please contact your assessment administrator.")
- `scope: "user"` → admin **"Your account has been disabled."** / candidate **"Your access has been removed."**
- any unknown / absent scope → no banner (silent fallthrough)

Each page owns its own visual treatment (admin login is single-column; candidate login uses its two-pane warning-soft alert idiom), but the single-shot read and scope→copy mapping live once in `authScope.ts` so the two cannot drift.

**Why:** Before this, a revoked session bounced to a generic "session expired" feel that misrepresented a suspend/disable — the user had no idea their org or account was the cause. The error `code` and raw message are deliberately NOT surfaced; the scope alone drives the copy, so a cookie-holding attacker cannot distinguish "my account was disabled" from "my company was suspended" via the error string (matches the session-loader error-hygiene note).

**Considered & rejected:** Surfacing `details.reason` text directly (rejected — leaks state granularity, and the two-bucket scope copy is sufficient). A toast instead of a login-page banner (rejected — the user has already been redirected to /login by the time the SPA reacts; the banner must live there).

**Excluded:** No `help_id` (CLAUDE.md rule #5) — the banner is a transient pre-auth status notice, not a help-targeted interactive control, and the help system is not active pre-session. (Candidate-login coverage, originally deferred, shipped 2026-05-22 in `7eb8604`.)

**Impact:** Frontend-only; server-side scope enforcement (Phase A, tenant/user status checks in `session-loader`) was already live. Both login pages share `apps/web/src/lib/authScope.ts`; built from design-system tokens (`--aiq-color-warning`, `--aiq-color-bg-sunken`/candidate `--aiq-color-warning-soft`, `--aiq-radius-md`); `role="status"`. Commits `60d4d23` (admin login + the `whoami` 429-backoff) and `7eb8604` (candidate login + shared `authScope.ts` + apps/web jsdom unit-test infra). **Behaviour is now proven by unit tests** — `pnpm --filter @assessiq/web test` (22 pass): `authScope.test.ts` (single-shot read, scope parse, audience copy), `admin/login.test.tsx` + `candidate/CandidateLogin.test.tsx` (tenant/user/none + single-shot), plus the now-unblocked `mfa.test.tsx`. No longer "pending operator"; banner copy also confirmed in the served bundle. The web test-infra mirrors `modules/10-admin-dashboard` (`@testing-library/react` + `jsdom` + `vitest`, `apps/web/vitest.config.ts`); run per-package like the other UI packages (not yet in the root `pnpm test` include — same gap as the existing UI packages).

---

## Auth-bypass route inventory

The canonical trust-boundary table. Every route that runs without a `requireAuth` session gate is listed here with the alternative trust model that makes it safe. Security reviews start here.

(`apps/api/src/server.ts` — see registration order for context)

| Route(s) | Alternative auth model | Security rationale |
|---|---|---|
| `GET /health` | None | Liveness probe; no user data, no side effects |
| `GET /api/auth/google/start` | None (per-IP rate-limited) | Auth-establishing; no session exists yet |
| `GET /api/auth/google/cb` | OIDC `state` + `nonce` (PKCE-equivalent) | OAuth callback; state param is the CSRF guard |
| `POST /api/auth/totp/verify` | Pre-MFA session (`totp_verified=false`) | Completes the second factor; not auth-bypassing |
| `POST /api/auth/totp/recovery` | Pre-MFA session | Recovery-code path; same session gate as totp/verify |
| `POST /api/auth/logout` | Optional session | Idempotent; no-session logout is a safe no-op |
| `GET /api/auth/whoami` | Optional session | Returns 401 when no session; read-only |
| `/take/:token` | Magic-link token (sha256-hashed in DB) | Token IS the credential; session created after hash validation |
| `GET /embed?token=<JWT>` | Embed JWT (HS256, per-tenant secret) | JWT replaces session cookie in cross-origin iframe context |
| `GET /embed/sdk.js` | None | Static JS bundle; no user data |
| `GET /embed/health` | None | Liveness probe |
| `GET /verify/:credentialId` | GUC-based RLS (`public_verify_lookup`) | credential_id is globally unique; policy restricts visible rows to SELECT |
| `GET /verify/:credentialId/og.svg` | GUC-based RLS (`public_verify_lookup`) | Same scoping as verify page; SVG only |
| `GET /help/...` (public routes) | None | Public help content; no user data |
| `POST /help/track` | None | Anonymous help-view analytics |
| `POST /api/auth/candidate/request-link` | None (per-IP+email rate-limited; 204 always) | Auth-establishing; anti-enumeration requires unconditional 204 |
| `POST /api/auth/candidate/verify-link` | `candidate_login_tokens` sha256 hash (DB lookup); body `{token}` | Token IS the credential; session minted after hash validation + atomic consume. POST (not GET) to avoid email-preview crawler prefetch consuming the single-use token before the candidate clicks. |

> Routes using `publicChain: authChain({ requireSession: false })` (e.g. `/take/*`) still pass through the session-loader hook — a valid session is loaded if present, but its absence is not an error. This is auth-**optional**, not auth-bypassed.

> Routes in `/api/auth/*` are auth-**establishing** — they CREATE or complete sessions. They are listed here because they accept unauthenticated callers, not because they skip authorization logic.

---

## Origin-verify header (anti-IP-spoof)

### Threat

Production topology is `Cloudflare (DNS-proxy) → shared Caddy → assessiq-api (Fastify)`. The origin IP `:443` is directly reachable — an attacker can bypass Cloudflare and set arbitrary `cf-connecting-ip` headers, spoofing any client IP. This defeats all per-IP rate limits (§ Rate limit tiers) and any IP-bound session tokens (magic-link, email-OTP continuation).

### Mechanism

Cloudflare injects a shared secret as the `x-origin-verify` request header via a **Cloudflare Transform Rule** (operator-applied out-of-band; see TODO below). The API extracts the client IP via `extractClientIp(req)` (implemented in `modules/01-auth/src/client-ip.ts`) which validates this header before trusting `cf-connecting-ip`.

Config vars (`modules/00-core/src/config.ts`, `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `ORIGIN_VERIFY_SECRET` | _(unset)_ | Shared secret Cloudflare injects as `x-origin-verify`. Unset = dev/test/CI boot safely. **When set, must be ≥16 chars** (Zod `.min(16)`) — an empty/short secret would make the constant-time compare trivially satisfiable. |
| `ORIGIN_TRUST_MODE` | `off` | Controls enforcement level (see modes below). |

**Boot guard (config `superRefine`):** `ORIGIN_TRUST_MODE=enforce` with a missing/short `ORIGIN_VERIFY_SECRET` **refuses to load config** — the process exits at startup rather than booting into a state where `isOriginVerified()` returns `false` for every request (which would make the rate-limit fail-closed path throw on *every* request = silent site-wide outage). A failed config load means the new container never goes healthy and the old one keeps serving — loud and recoverable. `off`/`log` with no secret boot fine.

### Three modes

| Mode | Behaviour | Use when |
|---|---|---|
| `off` | Returns `cf-connecting-ip ?? req.ip` — **byte-identical to the old inline expression.** Zero behaviour change. | Default; safe to deploy before Transform Rule is live. |
| `log` | Same return value as `off`. Emits one structured `warn` (`event: 'origin-unverified'`) when `x-origin-verify` is absent or mismatched. **Never changes the returned IP.** | Transform Rule is deployed; confirm logs show verified requests before enforcing. |
| `enforce` | Verified (`x-origin-verify` matches): trust `cf-connecting-ip`. **Unverified** behaviour differs by consumer: the **rate-limit middleware** (`extractRateLimitClientIp`) returns `null` → flows into the *existing* production fail-closed `throw RateLimitError` (request **rejected** — not bucketed by a spoofed cf-ip nor by the constant shared-Caddy socket IP). The **generic `extractClientIp`** (12 audit/log/login-binding sites) returns `req.socket.remoteAddress ?? req.ip` and never honours `cf-connecting-ip`/`x-forwarded-for`. | Transform Rule confirmed in logs, secret set. |

Secret comparison: both sides are hashed to fixed-length 32-byte **SHA-256 digests**, then compared with `crypto.timingSafeEqual`. There is no length-mismatch branch, so comparison time is independent of both attacker-input and secret length — zero length-oracle surface (never uses `===`).

The function never throws — the entire body is wrapped in a try/catch that returns `req.ip ?? '0.0.0.0'` on any unexpected error, preventing a crypto exception from crashing every request.

### Rollout order — **all 4 steps DONE (2026-05-19/20)**

1. ✅ **Deployed `off`** (`3b2fe73`, 2026-05-19) — no behaviour change.
2. ✅ **Cloudflare Transform Rule `assessiq-origin-verify`** added (Hostname == assessiq.automateedge.cloud → set request header `x-origin-verify: <64-hex secret>`); matching secret in `/srv/assessiq/.env` (NOT `.env.local` — that's inert).
3. ✅ **Flipped to `log`** — soak confirmed real CF traffic carries the verified header; the only "unverified" log was the benign loopback `/api/health` heartbeat (not rate-limited, no enforce impact). 0 false-positives on real traffic.
4. ✅ **Flipped to `enforce`** — spoofed-IP probe on a rate-limited route now returns **429** (was 200). Legit CF traffic 200. Health 200. crontab scan confirmed no internal HTTP callers to rate-limited routes.

**Rollback (operational, in case an internal job ever 429s):** edit `/srv/assessiq/.env` `ORIGIN_TRUST_MODE=enforce`→`log`, redeploy api+worker. `.env.bak.<TS>` backups exist on the VPS.

See **Network-layer origin lockdown (AOP)** below — the second, stronger layer added 2026-05-20 that closes the residual at the TLS handshake itself.

### Adjudicated adversarial residuals (Sonnet review + Opus adjudication)

The 01-auth gate (`feedback-adversarial-reviewer-routing`) ran a Sonnet adversarial pass (verdict REVISE, 7 findings) adjudicated by Opus. Fixed-with-tests: F1 boot guard (CRITICAL), F5 SHA-256 compare, F6 secret min-16, F7 extractor rename. Remaining **accepted residuals**:

- ~~**F4 — unverified login IP-binding (tracked, NOT a regression).**~~ **CLOSED 2026-05-20** — the network-layer AOP lockdown (see below) rejects direct-to-origin TLS handshakes entirely, so an "unverified request" can no longer reach the application at all. The degenerate-binding scenario's preconditions are gone. Verified (real-Cloudflare) sessions remain strictly stronger than the pre-2026-05-19 baseline.
- **F3 — `_log.ts checkIpRateLimit` shares one bucket for unverified traffic.** *By design.* Verified traffic uses its real cf-ip (independent buckets, unaffected); unverified traffic sharing one throttled bucket is the intended conservative posture for traffic that did not provably traverse Cloudflare.
- **F2 — `mint-session.ts` sentinel `'0.0.0.0'` vs old `'127.0.0.1'`.** The one site where `off` mode is not byte-identical. Dev-only (`NODE_ENV`-gated), and the sentinel is unreachable in practice (`req.ip` always populated under Fastify). Inline comment at the site; audit-cosmetic only.

### Network-layer origin lockdown (Cloudflare Authenticated Origin Pulls) — **LIVE 2026-05-20**

The shared-secret app-layer above is one half of the defense. The **complete** fix is at the TLS layer: make the origin refuse any TLS handshake that isn't presenting Cloudflare's client certificate. With AOP enforcing, a direct-to-origin attacker can't even open an HTTPS connection — they're rejected before any HTTP header (spoofed or not) reaches the application.

**Architecture.** `Cloudflare (AOP-enabled) → ti-platform Caddy (require_and_verify) → assessiq-api`. Cloudflare presents its zone-level Origin Pull client cert on every outbound connection to origin; Caddy's per-site `client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/ssl/cf-origin-pull-ca.pem }` rejects everything else at the TLS handshake.

**Neighbor-safe by design.** Of the 5 Caddy site blocks on the shared box (`intelwatch.in`, `ti.intelwatch.in`, `automateedge.cloud`, `accessbridge.space`, `assessiq.automateedge.cloud`), **only** the AssessIQ block carries `client_auth` — neighbors keep standard TLS. Verified post-flip: all 5 neighbor hostnames still serve HTTP 200.

**CA cert identity.** `/etc/caddy/ssl/cf-origin-pull-ca.pem` is the canonical Cloudflare zone-level Origin Pull CA: `CN = origin-pull.cloudflare.net, O = "CloudFlare, Inc.", OU = Origin Pull`, SHA-256 `9A:1A:C2:B4:BE:15:F9:F2:7E:EE:20:A7:34:CB:A4:E9:89:8F:61:00:1B:3B:D7:C8:4B:69:B5:6A:3E:25:A2:B9`, valid through Nov 2029.

**Rollout: canary flip with auto-revert.** Phase 1 (`mode request` — asks for cert but doesn't reject; no-op) was staged 2026-05-20 05:32 UTC. Phase 2 (`mode require_and_verify`) was flipped via a single sed truncate-write (per the `cat >` bind-mount-inode rule from RCA 2026-04-30, *never* `mv`), `caddy validate` + `caddy reload`, then a 4-probe acceptance gate:

| Probe | Expected | Result |
|---|---|---|
| `https://assessiq.automateedge.cloud/api/health` via Cloudflare | 200 | **200** ✓ |
| Direct-to-origin spoof (`curl --resolve` to origin IP + spoofed CF-Connecting-IP) | TLS rejected (curl HTTP `000`) | **000** ✓ vuln closed |
| `https://accessbridge.space` (neighbor) | 200 | **200** ✓ |
| `https://automateedge.cloud` (neighbor apex) | 200 | **200** ✓ |

The canary script (see `docs/06-deployment.md § Authenticated Origin Pulls (AOP)`) auto-reverts from the UTC-stamped backup if the CF probe fails — keeps exposure under ~30s if the flip ever needed to be undone.

**Rollback.** `cat /opt/ti-platform/caddy/Caddyfile.bak.<latest> > /opt/ti-platform/caddy/Caddyfile && docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. Truncate-write only (never `mv`/`cp` over the live Caddyfile).

### What is NOT included

- **`trustProxy: false`** — the Fastify `trustProxy: true` flag (`server.ts:44`) is intentionally untouched. With AOP enforcing, Fastify only ever sees TLS connections from CF (via Caddy), so XFF coming through that path is trustworthy by construction. Still: a separate audit of `trustProxy` semantics is a low-priority hygiene follow-up.
- **Automatic secret rotation** for `x-origin-verify` — operator responsibility (Transform Rule + `.env`). Now defense-in-depth (network-layer AOP is the primary), so rotation cadence is no longer the only thing holding back an attacker.
- **`trusted_ca_cert_file` → `trust_pool` migration** — Caddy v2.11 deprecation warning, cosmetic; tracked as low-priority Caddyfile hygiene.
- **Caddyfile formatting** — `caddy fmt --overwrite` would clean line-38 inconsistencies; not applied this round to keep the diff minimal and the inline RCA comments intact.

### Downstream impact

- `modules/00-core/src/config.ts`: two new env vars (`ORIGIN_VERIFY_SECRET`, `ORIGIN_TRUST_MODE`).
- `modules/01-auth/src/client-ip.ts`: new module; exports `extractClientIp(req): string`.
- `modules/01-auth/src/middleware/index.ts`: re-exports `extractClientIp` from `client-ip.ts` (replaces the rate-limit-internal one in the public barrel).
- `modules/01-auth/src/index.ts`: `extractClientIp` now resolves to `client-ip.ts` via the middleware barrel.
- `apps/api/src/server.ts:77,146`: inline expressions replaced.
- `apps/api/src/routes/_log.ts:87`: inline expression replaced (also fixes the `_log` in-memory rate limiter, which had the same spoofable-CF-header issue).
- `apps/api/src/routes/auth/candidate.ts:66,133`, `embed.ts:80,196`, `google.ts:105,167,217,279,319`, `dev/mint-session.ts:194`: all 13 call sites replaced.
- `.env.example`: two new vars with rollout comments.

> **TODO (operator, out-of-band):** Apply the Cloudflare Transform Rule to inject `x-origin-verify: <secret>` on every request to the zone. This is a Cloudflare dashboard action — it is NOT applied by any code in this repo. Until it is applied, `ORIGIN_TRUST_MODE=off` is the correct setting.
