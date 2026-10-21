# 04 — Auth Flows

*Type: explanation* — This page explains how sign-in, two-factor codes, sessions, embed tokens and API keys work.

> Phase 1 ships **Google SSO + TOTP**. Phase 2 designs in all other methods, and an admin turns each on for each tenant. The architecture below assumes all methods from day one, so we do not refactor the session and identity model later.

This page explains how a person or a program proves who it is to AssessIQ, and how AssessIQ keeps that proof safe. It covers identity, sessions, each sign-in flow, the user and tenant life cycle, rate limits and edge trust. The last section lists the dated decisions.

Read the sections in order for the full picture. Each section explains how a mechanism works and why it works that way.

## Identity and roles

An identity is a `users` row for one email in one tenant. This section explains who can exist, what each role may do and how a login finds the right identity.

### Identity model summary

| Concept | Where it lives |
|---|---|
| **Who you are** | `users` (per tenant) — one row per (tenant, email) |
| **How you proved it** | `oauth_identities`, `user_credentials` |
| **Active sessions** | `sessions` (Redis-mirrored for fast lookup) |
| **Service-to-service** | `api_keys` |
| **Embed access** | `embed_secrets` (per tenant; signs JWT) |
| **Audit** | `audit_log` (every login, MFA, override) |

A `users` row exists *before* the first login. Admins create users (or import them through CSV or SCIM in v2). On first login, SSO links the Google identity to that existing row. **No self-registration in v1**, which protects against tenant pollution.

### Roles and capabilities

Four roles exist in the `Role` union. The `requireAuth` gate uses **exact set membership** (`opts.roles.includes(sess.role)`). For example, `roles: ['admin']` does NOT admit a `super_admin` session. Each route lists every accepted role explicitly. (`modules/01-auth/src/sessions.ts:23`, `modules/01-auth/src/middleware/require-auth.ts:26`)

| Role | Scope | Auth method | TOTP enforced | Typical access |
|---|---|---|---|---|
| `candidate` | Per-tenant | Magic link or Google SSO | Optional (tenant-configurable) | `/take/*`, `/api/me/*` |
| `reviewer` | Per-tenant | none (removed 2026-10-03) | n/a | No access. The value is also removed from the DB CHECKs (migrations 0179, 0180, 0181; 2026-10-16). See the note at the end of this page. |
| `admin` | Per-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Full `/api/admin/*` for their tenant |
| `super_admin` | Cross-tenant | Google SSO | Yes (when `MFA_REQUIRED=true`) | Routes explicitly gated to `['super_admin']` only |

**super_admin detail (commit d59ade4):** A `super_admin` signs in through the same Google SSO and TOTP path as an admin. The session still carries a `tenant_id` (the tenant the operator signed in against). Specific service functions enable cross-tenant writes. For example, `updateAiGenerateMode` accepts a target `tenantId` as an explicit argument. These shipped endpoints accept only `roles: ['super_admin']`:

| Endpoint | Purpose |
|---|---|
| `PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode` | Flip AI generation mode for any tenant (atomic audit via `auditInTx`) |
| `POST /api/admin/analytics/refresh` | Manual materialized-view refresh (cross-tenant) |

(`apps/api/src/routes/admin-super.ts:25,41`, `apps/api/src/server.ts:225,229`)

**Question-bank authoring is super_admin-only (Phase B1, 2026-05-21).** The cross-tenant `/super/*` routes above are not the only `super_admin` routes. All question-bank **mutation** routes also accept only `roles:['super_admin']`. These routes are pack/level/question CRUD, publish, archive, activate-questions, import, save-rubric and bulk-status (13 paths in `modules/04-question-bank/src/routes.ts`). Tenant admins keep `GET` read access only. They get `403 AUTHZ_FAILED` on writes. This extends the earlier generation-route re-gate, so only the operator can author in the whole shared library. Per-tenant taxonomy (`POST /admin/domains`, `/admin/categories`) stays `admin`. For the full table and the SPA gating, see `docs/03-api-contract.md` § "Phase B1 (cont.) — question-bank authoring re-gated to super_admin".

> **DB note (resolved 2026-05-17):** The earlier caveat "`011_sessions.sql` lacks `super_admin`" is **closed**. Slice-1 migration `modules/01-auth/migrations/016_super_admin.sql` (Steps 1a/1b) drops and re-adds `sessions_role_check` and `users_role_check` so that they include `'super_admin'`. It also seeds the platform tenant (`00000000-0000-7000-0000-000000000001`, slug `platform`) and the bootstrap super_admin user (`…0002`, manishjnvk@gmail.com). The team applied the migration surgically to production and confirmed it. The platform Google-SSO branch is reachable end to end.

### Tenant-less login and cross-tenant identity resolution

*History: 2026-05-19, commit `62c2558`. This section replaces the older tenant-slug login.*

**Spec:** `docs/superpowers/specs/2026-05-19-login-identity-simplification-design.md`. Load-bearing `modules/01-auth`. No session, JWT, RLS or data-model change. (P2, the admin/reviewer email-OTP, is a separate phase that is not yet built.)

**Why:** the same email is a separate identity for each tenant (`UNIQUE(tenant_id,email)`). The old flow forced the user to type the tenant slug to tell the identities apart. P1 removes that step.

**Flow:**

1. `/admin/login` has **no Tenant field**. It shows "Continue with Google" only. `GET /api/auth/google/start` no longer requires the `?tenant=` query parameter. The OAuth state is now `random[|returnTo]` (the tenantId segment is removed). The CSRF state, the nonce and the id_token RS256/JWKS verification are **byte-unchanged**.
2. New **step 4b**: the login fails unless Google asserts `email_verified`. Email is now the sole cross-tenant identity key. The check accepts the boolean `true` and the string `"true"`. It fails closed and returns a generic error.
3. `resolveLoginIdentities(verifiedEmail)` runs **only after** full id_token verification. It runs in a bounded `SET LOCAL ROLE assessiq_system` (BYPASSRLS) transaction. It returns every `active`, non-deleted `users` row that matches `lower(email)` across all tenants. **Gate-2 is preserved:** the result includes a `super_admin` or platform-tenant identity **only if** the email is in `SUPER_ADMIN_EMAILS`. Otherwise the resolver filters the identity out entirely, and the system never returns, counts or shows it.
4. The number of identities decides the next step:
   - **0 identities**: the flow returns a generic `AuthnError` (no enumeration).
   - **1 identity**: the flow calls `mintForIdentity` immediately. The behaviour is identical to the callback before P1.
   - **2 or more identities**: the flow creates a single-use Redis **login-continuation token** and redirects to `/admin/select-identity`. The token is a 32-byte random value, keyed by sha256, with TTL 300 s. It is bound to the ip and ua, fails closed, travels in an HttpOnly cookie and **never appears in a URL**.
5. The SPA page `/admin/select-identity` has no `RequireSession`, because it is a step before the session. It calls `GET /api/auth/login/identities` (publicAuthChain; a non-consuming **peek** of the continuation) to show a "Role @ Organisation" picker. Then it calls `POST /api/auth/login/select { userId }`.
6. `selectLoginIdentity` atomically **consumes** the continuation (single-use `getdel`). It checks that `userId ∈ payload.candidates` **and** that the same user id is in a **fresh re-resolve**. This double check prevents tampering: a caller can mint only an identity that the verified email actually owns. Then it calls `mintForIdentity`.

**`mintForIdentity` (shared by the single-identity callback path and `/select`):**

- For super_admin or platform, the flow works in this order: fresh platform `users` re-read (role, status, deleted) → `sessions.create(totpVerified=false)` → redirect to `/admin/mfa` **always** (Gate-4) → **no `oauth_identities` write** (Gate invariant).
- For a customer, the flow works in this order: fresh `status='active' AND deleted_at IS NULL` re-check → `oauth_identities` JIT-link `ON CONFLICT (provider,subject) DO NOTHING` → mint → redirect (`candidate`→`/`; else `MFA_REQUIRED?'/admin/mfa':(safeReturnTo(returnTo)||'/admin')`).
- The `/select` path has no Google `claims`. The allowlist still applies, because the Gate-2 filter of `resolveLoginIdentities` runs at both continuation-store time and the fresh re-resolve.

**super_admin** appears in the picker like any identity. Selecting it goes through the unchanged isolated always-MFA gates (Gate-2 through the resolver filter; Gate-3 and Gate-4 in `mintForIdentity`). Email-OTP (P2) can never satisfy super_admin.

**Behaviour delta (accepted, fail-closed):** The lookup of `oauth_identities` by `subject` (Pass-1 before P1) is gone. Resolution now uses the verified email. A user who changed the Google email but kept the same Google account is **rejected** (fail-closed). The system does not log that user in by subject. The system never logs in the wrong user. The common path (stable email) is identical.

**Adversarial gate (mandatory, 01-auth):** Sonnet review **VERDICT accept**. All 7 highest-stakes invariants are CLEAN, with traced proofs:

- There is no super-admin escalation on either path.
- The cross-tenant read happens only after verification.
- `normalizeEmail` = trim + lowercase only, so there is no dot or plus impersonation.
- The `/select` anti-tamper check is double-checked.
- The flow is always-MFA.
- The CSRF and nonce checks are sound.
- The change is behaviour-preserving.

Opus adjudication: finding-1 (`email_verified`) is **fixed** (step 4b above).

**Finding-2 is an open, accepted residual.** The continuation ip-binding derives the client IP through `cf-connecting-ip ?? req.ip`. An attacker can spoof it if the attacker reaches the origin without Cloudflare in front. This is a **pre-existing pattern in the whole codebase** (sessions, candidate-login and rate-limit derive the IP the same way). A 256-bit HttpOnly single-use token gates it. The correct fix is an app-wide `trustProxy` or CF-range configuration. This is a tracked follow-up, not a change in the P1 scope.

Finding-3 (the non-consuming peek) is the design intent, and SameSite=Lax bounds it.

### Email one-time code for admin

*History: 2026-05-19, commit `a16fdb1`. The reviewer part was removed on 2026-10-03.*

An **alternative primary login to Google SSO, for `admin` only.** (Until 2026-10-03 `reviewer` could also use it. The role is removed.) `super_admin` can NEVER use it (Google and authenticator MFA only). The `candidate` magic link is untouched. It reuses the P1 resolver, continuation, picker and `mintForIdentity`.

- **Login page** gains "Email me a sign-in code" → `/admin/login/email` (two steps: enter the email, then enter the 6-digit code). The new module is `modules/01-auth/src/email-otp.ts`. **S29 (2026-10-19, owner Q17):** the code page signs in on the 6th digit with no extra click (the server already returned `redirectTo` with the session cookie), and every failure (wrong, expired, locked) shows one message: "That code is not right. Check it and try again." The message and the timing do not tell an unknown account from a wrong code. Server limits, TTL, attempts and ip/ua binding are unchanged. A "Send a new code" link returns to the email step.
- `POST /api/auth/login/email/request {email}` (`publicAuthChain`) **always** returns `200 {ok:true,"If that email can sign in, we've sent a 6-digit code."}`. The system generates and sends a code **only if** `resolveLoginIdentities(email)` returns at least 1 identity that passes `filterEligible` = `role==='admin' && !isPlatform` (a positive allowlist that structurally excludes super_admin and candidate). The code is a 6-digit CSPRNG value. Redis holds only `sha256(code)`, with a 10-minute TTL. One code is active for each email, and a new request overwrites it. Two fail-closed rate limits apply (the candidate-login Lua idiom): 5/h for each `(IP,email)` **and** 10/h for each email, independent of IP (this prevents email-bombing with IP rotation). `sendEmail` receives the `tenantId` of the eligible tenant (audited; the dev-emails.log plaintext-code fallback is never used). The email template is `admin_email_otp` (modules/13-notifications).
- `POST /api/auth/login/email/verify {email,code}` (`publicAuthChain`) uses the atomic `ATTEMPT_LUA` (≤5 attempts, then the code is burned), an ip/ua bind and a constant-time `sha256` compare. A successful verify deletes the code (single use). On success the flow runs a fresh `resolveLoginIdentities` and the SAME `filterEligible`. With 0 identities the flow fails. With 1 identity it calls `mintForIdentity` (customer branch; **no Google `subject`**, so no `oauth_identities` link is written). With 2 or more identities it calls `storeLoginContinuation` (`subject:undefined`, `candidates`=admin userIds) and goes to `/admin/select-identity` (the P1 picker is reused). Any failure returns a generic `200 {ok:false,error:'invalid_code'}` (no distinction between expired, wrong and locked).
- **super_admin impossibility — triple-blocked and adversarially proven:** (a) the request `filterEligible`; (b) the verify re-filter; (c) the continuation `candidates` hold only admin userIds. So the P1 assertion `userId ∈ candidates` in `selectLoginIdentity` rejects a super_admin userId, even though its internal re-resolve returns all roles. A mixed email (super_admin@platform + admin@tenantX) gets a code (the admin is eligible), but only the admin identities are ever selectable.
- **Anti-enumeration is constant-WORK, not only constant-floor:** `_requestWork` runs `resolveLoginIdentities` unconditionally first on every path (rate-limited, ineligible, unknown, send). `MIN_REQUEST_MS` is 800 ms (above the resolve p99) on both request and verify. So the response latency cannot show the difference between a provisioned admin email and an unknown email.
- **P1-code change:** `mintForIdentity.ctx.subject` is now optional. The `oauth_identities` INSERT is wrapped in `if (subject !== undefined)`. The Google callback and the P1 `/select` always pass a `subject`, so those paths are byte-unchanged. Only email-OTP (no Google identity) skips the link. `LoginContinuationPayload.subject` is widened to `string | undefined`. The `selectLoginIdentity` logic is unchanged (only the subject-forwarding spread changed).
- **Adversarial gate (mandatory, 01-auth):** Sonnet review VERDICT *revise*. All security invariants HELD, with traced proofs:
  - super_admin and candidate are impossible, including races.
  - Brute force is infeasible (5 tries per code over a 10⁶ space, plus the dual rate limit).
  - Resolve-before-send blocks recipient injection and code exfiltration.
  - P1 byte-preservation holds, and so does continuation reuse.

  Opus adjudication: **BLOCKER-1** (missing `admin_email_otp` template, so the feature was DOA) FIXED. **MAJOR-2** (a timing oracle that broke anti-enumeration) FIXED (constant-work and 800 ms floor). **MINOR-3** (per-email cap) FIXED. **MINOR-4** (tenantId → audited send, no plaintext-code dev-log) FIXED. **MINOR-5** (`cf-connecting-ip` is spoofable) is an accepted PRE-EXISTING residual in the whole codebase (the same as P1 finding-2; an app-wide `trustProxy` follow-up, not in the P2 scope).

### Super-admin "Edit admin": email is the login identity

*History: 2026-05-24, branch `feat/platform-edit-admin`, PR-pending.*

**What:** the Platform page gains a "Manage ▸ Edit admin" modal for each row. The modal edits the primary-contact admin's `name`, `role` (fixed to `admin`; since 2026-10-03 the system rejects reviewer with `INVALID_ROLE`) and `email` through `PATCH /api/admin/super/users/:userId` (gate: `super_admin` + fresh MFA). For the full contract, see `docs/03-api-contract.md`.

**Why this is an auth-flow concern:** Login resolution is **by Google-verified email** (`resolveLoginIdentities(verifiedEmail)`, "the SOLE cross-tenant identity key" in the tenant-less login section above). So `users.email` *is* the login identity. No separate immutable login id survives an email change. Therefore an edit of the admin's email is not a contact-detail edit. It changes who can sign in to that account.

**Semantics (enforced server-side; the UI confirm checkbox is only defence in depth):**

- **Pending** admin (the invite is not yet accepted, and the admin never logged in): you can re-address the email freely. In the transaction, we retire the invitation for the old address. After the commit, we issue a fresh invite to the new address. No confirmation is needed.
- **Active or disabled** admin (a real account exists): a change of the email **transfers account ownership** and requires `confirmEmailIdentityChange:true`. On a change, we do three things:
  - (a) We run `UPDATE users.email` in the tenant tx.
  - (b) We delete the stale `oauth_identities` Google link.
  - (c) We sweep the sessions of the user after the commit (forced re-login).

  Login is keyed by email, so the old `(provider,subject)` row is inert. We remove it for hygiene and to allow a JIT re-link at the new address. The UI warns the operator that the admin must control a Google account at the new address, or the admin is locked out.
- A new email that collides with another user in the same tenant returns `409 USER_EMAIL_EXISTS` (the `UNIQUE(tenant_id,email)` constraint). You cannot edit `super_admin` users through this endpoint.

**Relation to P1 finding-2 (residual):** This change adds no new IP-trust surface. The fresh-MFA gate and the `super_admin` role check are the controls. This change does not alter the known app-wide `cf-connecting-ip` spoofability residual.

**Adversarial gate (mandatory, touches 01-auth identity):** Sonnet review **VERDICT revise**. The team fixed two real findings before merge. (F5) An email change on a *disabled* account also requires the identity-transfer confirm (the guard now keys on `status !== 'pending'`, not only on `active`). (F2) If the invite send fails after a rename, the endpoint returns `200 reinvited:false` instead of a `500`. The rename already committed, and you recover with "Resend invite". Finding-1 (cross-tenant invitation DELETE) is verified safe: `user_invitations` carries the `tenant_isolation` RLS policy (`FOR ALL`), so the `withTenant`-scoped DELETE cannot cross tenants. Opus independent second pass: **ACCEPT** after the fixes. (The harness data-exfiltration classifier blocked the GLM-5.1 half. Opus took the second-reviewer slot.)

### Super-admin platform login (superseded)

> **⚠ SUPERSEDED BY P1 (2026-05-19) — see "Tenant-less login and cross-tenant identity resolution" above.** The Tenant field is removed. A user no longer reaches super_admin by typing `platform`. The Gate-2/3/4 *semantics* (allowlist, platform users row, always-MFA, no `oauth_identities`) are **unchanged**. They now live in `resolveLoginIdentities` (Gate-2 filter) and `mintForIdentity` (Gate-3/4). A flow reaches them after cross-tenant resolution and the identity picker, instead of a typed tenant slug embedded in the OAuth state. The historical description below stays for the contract before P1.

The super-admin signs in through the **normal `/admin/login` page with the Tenant field set to `platform`** (not `wipro-soc`). This embeds the platform tenant id in the OAuth state. `handleGoogleCallback` then takes the isolated platform branch: Gate1 id_token (RS256/JWKS/nonce/CSRF) · Gate2 email ∈ `SUPER_ADMIN_EMAILS` (defaults to manishjnvk@gmail.com) · Gate3 platform-tenant `users` row `role='super_admin' status='active'` · Gate4 mint session `totpVerified=false` and redirect to `/admin/mfa`. This path neither reads nor writes an `oauth_identities` row (the global `UNIQUE(provider,subject)` constraint stays intact for customer tenants). (`modules/01-auth/src/google-sso.ts:336-428`)

## Sessions and multi-factor authentication

After a person proves identity, AssessIQ mints a session. This section explains the session flags, the second factor and how the system stores secrets.

### First-login MFA bootstrap (RCA 2026-05-17 — lockout fix)

`super_admin` is **always-MFA** regardless of `MFA_REQUIRED`. But a pre-TOTP super_admin must still be able to *reach* the screens that set TOTP. Otherwise the super_admin is locked out permanently. The contract:

- The **read-only state-probe and bootstrap routes** (`whoami`, `logout` and the four `/api/auth/totp/*` routes) explicitly pass `requireTotpVerified:false`. `require-auth.ts` honors an *explicit* `requireTotpVerified===false` for **every** role, including super_admin. So a pre-TOTP super_admin can call these routes. The 4 TOTP routes also list `'super_admin'` in `roles[]` (the backend role gate is exact `includes()`, with no hierarchy).
- `computeMfaStatus()` of `whoami` reports `'pending'` for a pre-TOTP super_admin **regardless of `MFA_REQUIRED`** (super_admin is always-MFA). So the SPA `RequireSession` routes it to `/admin/mfa` to enrol or verify, not to the dashboard.
- Every **cross-tenant ACTION route** (`/api/admin/super/*`) omits `requireTotpVerified:false` *and* also sets `freshMfaWithinMinutes`. So super_admin actions stay fully MFA-gated (`totpVerified=true` + TOTP within 15 min). The bootstrap relaxation never reaches the dangerous surface.

(`modules/01-auth/src/middleware/require-auth.ts:43-67`, `apps/api/src/routes/auth/{whoami,totp,logout}.ts`; regression suites `super-admin-mfa-bootstrap.test.ts`, `whoami-mfa-status.test.ts`)

### `totpVerified` at mint — rate-limit trust tier (RCA 2026-05-30)

**`totpVerified` is an "all *required* second factors are satisfied" flag, not "the user typed a TOTP code".** `mintForIdentity` (customer-tenant branch) computes it live at mint:

```
totpVerified = user.role === "candidate" || !config.MFA_REQUIRED
```

- **What changed.** Before, the customer branch always minted `totpVerified=false`. It now mints `true` for `candidate` (the same as magic-link, which hardcodes `true`) and for `admin` (and legacy `reviewer`) **when `MFA_REQUIRED=false`**. (`modules/01-auth/src/google-sso.ts` ~line 486.) The super_admin branch is unchanged. It always mints `false` and always requires TOTP (Gate-4 above), and this line never reaches it.
- **Why.** Production runs `MFA_REQUIRED=false` (opt-in MFA, pre-launch). With the old code, an SSO admin was `totpVerified=false` for the entire 8h session, and **no TOTP step exists** to flip it to true. So `rate-limit.ts` kept the admin permanently in the conservative **60/min `aiq:rl:user:<id>`** tier (against 300/min for verified admins). A normal dashboard page fires more than 60 authenticated calls each minute (`whoami` + `/api/admin/assessments` + `/api/billing/usage` + polling), which exhausts the bucket. Every later request then gets `429` with `scope=user`. This includes `GET /api/auth/google/start` (the browser still sends the session cookie), so the admin cannot even sign in again to escape the lockout. The problem recurred 3 times, because all three earlier fixes raised **IP-scope** caps (anon 30→120, IP-admin 100→500, verified-admin 5000) and never raised the per-user tier that was the binding limit. See `docs/RCA_LOG.md` 2026-05-30.
- **Why this is safe (adversarial-reviewed, VERDICT accept).** `require-auth.ts` wraps the **entire** TOTP-verified gate *and* the fresh-MFA step-up gate in `if (isSuperAdmin || config.MFA_REQUIRED)` (require-auth.ts:59). So for non-super_admin roles when `MFA_REQUIRED=false`, **no auth gate ever reads** `totpVerified`. Flipping it to `true` only restores the correct rate-limit tier and relaxes **no** authorization. super_admin is always-MFA on a separate branch. Credential endpoints keep their own 20/min per-route bucket regardless of tier, so brute-force protection is unaffected.
- **Considered and rejected.** (a) Raise the hardcoded `60` user cap. That is a 4th whack-a-mole fix on a symptom. A heavy page can exceed any fixed number, and the trust-tier semantics stay wrong. (b) Make the rate-limit tier itself `MFA_REQUIRED`-aware without a change to the session field (Option A). The blast radius is smaller, but `totpVerified` stays semantically dishonest. We rejected it in favour of a fix of the field at the source.
- **NOT included / known residual (V3).** A session minted with `totpVerified=true` while `MFA_REQUIRED=false` persists for ~8h in Redis. Suppose an operator flips `MFA_REQUIRED=true` mid-session. Then that stale session **bypasses the newly enabled TOTP gate until it expires** (≤8h). This risk is bounded, starts with an operator action (config change + redeploy), and an attacker cannot exploit it. We accept it. super_admin is unaffected. If a future deploy enables MFA, treat it as a session-invalidation event (or accept the ≤8h tail).
- **Downstream impact.** `rate-limit.ts` (tier resolution; no code change, it reads the field) and the email-OTP login path are affected. The email-OTP path reaches the same customer-branch mint, so admin email-OTP logins get the same fix. No schema or API-contract change.

### Session-status cache (R11)

*History: 2026-10-02, commit `d9a0813`.*

- **What.** `modules/01-auth/src/middleware/session-loader.ts` caches the "is this user / tenant still active?" verdict in Redis. This saves two `withTenant` DB round trips for each request (campus drives: hundreds of students on one IP poll). Keys: `aiq:sess-status:u:<userId>` -> the tenantId it was verified under; `aiq:sess-status:t:<tenantId>` -> `"1"`. TTL `SESS_STATUS_TTL_SEC = 30`. The values hold no PII.
- **Invariants (tested in `session-status-cache.test.ts`).**
  1. Positive-only: the cache stores only an "active" verdict. It never caches a negative. So the cache can delay a lockout by 30 s at most, and it never extends a lockout.
  2. Tenant-bound: a user-key hit must equal `session.tenantId`. Otherwise the system ignores the hit.
  3. Invalidation (DEL): `sessions.destroyAllForUser` (user key), `sessions.destroyAllForTenant` (tenant key; used by suspend and archive), `03-users/redis-sweep.sweepUserSessions` (disable and soft-delete) and the admin erase route.
  4. If Redis is down or returns an error on get or set, the system falls through to the DB check. It fails safe and never fails open.
  5. The DB check now also rejects `users.erased_at IS NOT NULL`. Before, erased candidates kept working sessions.
- **Known bounded race.** A DB read that straddles a suspend can write "active" again after the DEL. It expires within 30 s.
- **Considered and rejected.** Caching negatives (this needs invalidation on un-suspend); a longer TTL; a pre-guard before sessionLoader (the middleware order is unchanged).
- **Not included.** Any change to session lifetime, JWT or MFA. The PG pool budget is set at the same time: api 40, worker 15 (`API_PG_POOL_MAX` / `WORKER_PG_POOL_MAX`, Postgres `max_connections` 100).
- **Impact.** Any new "kill sessions" path must DEL these keys. Otherwise the lockout waits up to 30 s.

### Session revocation: state-aware login banner

*History: Phase D, 2026-05-22, LIVE.*

**What:** The operator can suspend or archive the tenant, or disable or delete the user, while the user is active. The system then destroys the session in use. In this case `session-loader` (`modules/01-auth/src/middleware/session-loader.ts`) throws a 401 that carries `details.scope` (`"tenant"` | `"user"`) and `details.reason`. The SPA captures that scope on the failing `whoami` (`apps/web/src/lib/session.ts` and the admin-dashboard mirror `modules/10-admin-dashboard/src/session.ts`). It stores the scope once in `sessionStorage` under `aiq.lastAuthScope`. **Both** the admin login (`apps/web/src/pages/admin/login.tsx`) and the candidate login (`apps/web/src/pages/candidate/CandidateLogin.tsx`) read and clear it on mount through the shared helper `apps/web/src/lib/authScope.ts` (`readAuthScopeOnce()` + `authScopeCopy(scope, audience)`). They show a state-aware notice with **audience-tuned copy**:

- `scope: "tenant"` → admin **"Your organisation's access is paused."** (operator-facing body); candidate: the same title with a calmer body ("Your assessment workspace has been suspended. Please contact your assessment administrator.")
- `scope: "user"` → admin **"Your account has been disabled."** / candidate **"Your access has been removed."**
- any unknown or absent scope → no banner (silent fallthrough)

Each page owns its visual treatment (the admin login is single-column; the candidate login uses its two-pane warning-soft alert idiom). The single-shot read and the scope-to-copy mapping live once in `authScope.ts`, so the two pages cannot drift.

**Why:** Before this change, a revoked session bounced to a generic "session expired" feel. That feel misrepresented a suspend or a disable, and the user did not know that the org or the account was the cause. The UI deliberately does NOT show the error `code` and the raw message. The scope alone drives the copy. So an attacker who holds a cookie cannot use the error string to tell "my account was disabled" from "my company was suspended" (this matches the session-loader error-hygiene note).

**Considered & rejected:** Showing the `details.reason` text directly (rejected: it leaks state granularity, and the two-bucket scope copy is sufficient). A toast instead of a login-page banner (rejected: the SPA redirects the user to /login before it reacts, so the banner must live there).

**Excluded:** No `help_id` (CLAUDE.md rule #5). The banner is a transient pre-auth status notice, not an interactive control that help targets, and the help system is not active before a session exists. (Candidate-login coverage, deferred at first, shipped 2026-05-22 in `7eb8604`.)

**Impact:** Frontend-only. The server-side scope enforcement (Phase A, tenant and user status checks in `session-loader`) was already live. Both login pages share `apps/web/src/lib/authScope.ts`. The banner uses design-system tokens (`--aiq-color-warning`, `--aiq-color-bg-sunken`/candidate `--aiq-color-warning-soft`, `--aiq-radius-md`) and `role="status"`. Commits: `60d4d23` (admin login + the `whoami` 429-backoff) and `7eb8604` (candidate login + shared `authScope.ts` + apps/web jsdom unit-test infra). **Unit tests now prove the behaviour:** `pnpm --filter @assessiq/web test` (22 pass). The tests are `authScope.test.ts` (single-shot read, scope parse, audience copy), `admin/login.test.tsx` + `candidate/CandidateLogin.test.tsx` (tenant/user/none + single-shot), and the now-unblocked `mfa.test.tsx`. It is no longer "pending operator". The served bundle also confirms the banner copy. The web test infrastructure mirrors `modules/10-admin-dashboard` (`@testing-library/react` + `jsdom` + `vitest`, `apps/web/vitest.config.ts`). Run it for each package like the other UI packages (it is not yet in the root `pnpm test` include, the same gap as the existing UI packages).

### Token & secret storage standards

| Secret | Storage | Reveal policy |
|---|---|---|
| Session cookie value | sha256 hashed in `sessions.token_hash` | Never revealed after issuance |
| TOTP secret | AES-256-GCM in `user_credentials.totp_secret_enc` | Never revealed after enrollment (QR shown once) |
| Recovery codes | argon2id hashed | Plaintext shown once at generation |
| API keys | sha256 hashed | Plaintext shown once at creation |
| Embed secrets | AES-256-GCM | Plaintext shown once at creation |
| Passwords (if used) | argon2id (m=64MB, t=3, p=4) | Never revealed |
| Webhook signing secrets | AES-256-GCM | Plaintext shown once |

Master encryption key: 32-byte random value in the env var `ASSESSIQ_MASTER_KEY` (base64). For v1, use a plain env file with strict permissions (0600, owned by the service user). For v2, integrate Doppler or Vault.

### Security must-do checklist

- [ ] Verify every JWT signature (no `alg: none` ever)
- [ ] CSRF protection on state-changing routes (double-submit cookie)
- [x] **Role-aware IP rate limiting on all routes** (2026-05-15) — four-tier design, see § below
- [ ] Account lockout after 5 failed TOTP attempts in 15 min

### Shared AES-256-GCM envelope and fixed-window rate-limit script (N24)

*History: 2026-10-03.*

**What changed.** Commits `34abc0e`, `c58438a`, `9b585a7`.

- `modules/00-core/src/aes-gcm.ts` is the one AES-256-GCM implementation: `sealTagLast`/`openTagLast` and `sealTagMid`/`openTagMid`. Both stored layouts stay. The previous-key fallback stays. The auth tag is 16 bytes. An envelope under 28 bytes fails with "envelope too short".
- Wrappers keep their old names: `modules/01-auth/src/crypto-util.ts` (TagLast), `modules/13-notifications/src/webhooks/crypto.ts` (TagMid), `modules/12-embed-sdk/src/webhook-secret-service.ts` (TagLast, base64).
- `modules/01-auth/src/fixed-window-lua.ts` holds `FIXED_WINDOW_LUA` and `incrFixedWindow`. `rate-limit.ts`, `candidate-login.ts` and `email-otp.ts` use it. `ATTEMPT_LUA` is a different script and is untouched.

**Why.** Three copies of each piece could drift apart (review RV77).

**Considered and rejected.** One stored layout (it needs a data migration, and we could not read the production row counts). A rename of the wrappers (churn).

**Not included.** No data migration, no re-encryption. `tenant_settings.webhook_secret` is write-only (nothing decrypts it). This is an open question for the owner.

**Impact.** Module 00 has a new subpath export `@assessiq/core/aes-gcm` (the `exports` map in its `package.json`). The 13-notifications tests mock the barrel. codex: accept.

## Sign-in flows

Each flow below ends in a session or a token. The flows are: admin login, enrolment, step-up, candidate login, embed, API key, public verify and magic link.

### Flow 1 — Admin login (Google SSO + TOTP)

> **Status (2026-05-01, Phase 0 closure — route layer and first API deploy live end to end):** The library, the DB layer, the Fastify route layer and the container deploy are ALL LIVE on `origin/main`.
>
> - The commits are `d9cfeb4` (W4 library + migrations 010-015), `58eba33` (assessiq-api Dockerfile + auth route layer), `335d055` (dev-auth shim swap → real `@assessiq/auth` chain across `apps/api` and `apps/web`) and `0789e4f` (Dockerfile build-strategy fix + `getTenantBySlug` system-role implementation).
> - These routes serve Flow 1: `GET /api/auth/google/start?tenant=<slug>` (302 to Google, sets `aiq_oauth_state` + `aiq_oauth_nonce`), `GET /api/auth/google/cb` (mints the pre-MFA `aiq_sess` and redirects to `/admin/mfa`), `POST /api/auth/totp/enroll/start` + `POST /api/auth/totp/enroll/confirm` (returns 10 plaintext recovery codes ONCE), `POST /api/auth/totp/verify` (promotes to `totp_verified`), `POST /api/auth/totp/recovery`, `POST /api/auth/logout` and `GET /api/auth/whoami`.
> - The container runs behind the Caddy split route on `https://assessiq.automateedge.cloud/api/*`. A direct curl on the deployed surface verified it.
> - **Drill B (curl `/api/auth/google/start` 302) is DEFERRED.** The route and the tenant resolution PASS. But `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are empty in `/srv/assessiq/.env`, so the route returns a clean 401 `"Google SSO is not configured"` (rate-limit headers are populated, with no leak and no stack trace). To clear it, provision an OAuth client in the Google Cloud Console with the redirect URI `https://assessiq.automateedge.cloud/api/auth/google/cb`, add the credentials to `.env` and restart `assessiq-api`.
> - **Drill 1 (full-stack browser SSO+MFA flow) is DEFERRED.** The `assessiq-frontend` Dockerfile is a Phase 1+ deliverable, so the `/admin/login` HTML route currently serves the Caddy default placeholder, not the SPA.
> - The dev-auth `FIXME(post-01-auth)` markers are now ZERO across the repo (`apps/api/src/middleware/dev-auth.ts` is deleted; the `apps/web` SPA edits are in commit `335d055`).

The strict path. Every admin must clear both factors.

> **Post-login redirect contract (updated 2026-05-04, commit `473fef1`):** The canonical post-authentication landing is always `/admin` (the dashboard). Before, `MFA_REQUIRED=false` redirected to `/admin/users`, and the post-TOTP `nav()` calls in `apps/web/src/pages/admin/mfa.tsx` also targeted `/admin/users`. Both now go to `/admin`. **Correction (2026-05-30):** the earlier claim that "in production `MFA_REQUIRED=true` always" is **stale**. Production currently runs `MFA_REQUIRED=false` (opt-in MFA, pre-launch). With MFA enforced, the path is `Google callback → /admin/mfa → TOTP verify → /admin`. With MFA off (current production), the path is `Google callback → /admin` directly, and the system mints the session with `totpVerified=true` (see "### `totpVerified` at mint" above).

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
2. `cookieParser` (`@fastify/cookie`, registered globally at app startup; runs as `onRequest` before any `preHandler`)
3. `sessionLoader` (sets `req.session` from Redis; **runs before rateLimit** so the middleware can read the role to resolve the IP bucket; short-circuits in <1 ms when no `aiq_sess` cookie is present)
4. `rateLimit` (role-aware per-IP on all routes; per-user 60/min (candidate 120/min); per-tenant `RATE_LIMIT_TENANT` 6000/min; see § Role-aware IP rate limiting and § Campus-scale rate limits below)
5. ~~`tenantContext`~~ (REMOVED 2026-10: it never fired and nothing used it; routes use `withTenant()`, see § Campus-scale)
6. `requireAuth(roles, mfaRequired=true)` (applied for each route)

> **Chain reorder note (2026-05-04):** The original order was `requestId → rateLimit → cookieParser → sessionLoader → ...`. We moved sessionLoader before rateLimit, so the role-aware IP bucket resolution can inspect `req.session`. This is safe. `@fastify/cookie` runs as an `onRequest` hook (before all `preHandlers`), so `req.cookies` is always populated when `sessionLoader` runs. Anonymous requests (no `aiq_sess` cookie) cost no extra overhead, because sessionLoader short-circuits on a missing cookie without a Redis call.

### Flow 1a — TOTP enrollment (first admin login)

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

**Enrolment receipt email (FU-B21, 2026-10-16).** After step 7 succeeds and the session is promoted to verified, `POST /api/auth/totp/enroll/confirm` sends the `totp_enrolled` email (`sendTotpEnrolledEmail`, module 13) to the address of the user. The send is best-effort: the route logs a failure and the response is unchanged. The route sends no email on a wrong code or a lockout. The copy no longer says "change your password". See `docs/13-email-system.md` § FU-B21.

**Recovery codes:**
- One-time use, marked `used_at` on consumption
- The user can regenerate the codes (an admin can force a regeneration). This invalidates the old codes.
- The user enters a recovery code at the same `/admin/mfa` prompt, through a "Use recovery code instead" link

### Flow 1b — Step-up MFA for sensitive actions

Some admin actions require fresh MFA, even in an active session:
- Override an AI grading score
- Delete an assessment with submitted attempts
- Rotate API keys or embed secrets
- Change tenant auth methods

Implementation: routes carry the annotation `requireFreshMfa(maxAgeMinutes=15)`. If `sessions.last_totp_at < now() - 15min`, the route returns `403 mfa_required` with a re-auth challenge. The frontend shows the TOTP modal and then retries the original action.

### Self-service MFA: recovery-code regeneration and admin reset (RW-45)

*History: S10, 2026-10-15.*

**What changed.** Two flows now have a route and a UI. Both write an audit row inside the same transaction as the change.

**Regenerate recovery codes.**
1. An admin or super admin opens `/admin/account-security` and enters a current TOTP code.
2. The client calls `POST /api/auth/totp/recovery-codes/regenerate` with `{code}`.
3. The server verifies the code with the normal TOTP check and the 5-failure lockout (`423 ACCOUNT_LOCKED`).
4. `regenerateRecoveryCodes` (`modules/01-auth/src/totp.ts`) deletes the old codes and inserts 10 new hashes.
5. The same transaction writes `auth.recovery.regenerated` with `after: { issued: 10 }`. It never stores codes or hashes.
6. The response returns the 10 plaintext codes once.

A wrong code touches nothing. The old codes stay valid.

**Admin reset of a user's two-factor.**
1. A super admin calls `POST /api/admin/super/tenants/:tenantId/users/:userId/totp/reset` with a `reason`.
2. `adminResetTotp(adminUserId, tenantId, targetUserId, reason?)` clears the TOTP secret, deletes the recovery codes and deletes the target's Postgres `sessions` rows. All three happen in one transaction.
3. The same transaction writes `auth.totp.reset` with `after: { reason, recoveryCodesPurged, sessionsRevoked }`.
4. After the commit, the function calls `sessions.destroyAllForUser`. Redis holds the authoritative session records. Redis cannot join the Postgres transaction. The Postgres delete makes the call safe to repeat.
5. The target must enrol again at the next login.

**Why in the transaction.** If the audit write fails, the change rolls back. No reset or regeneration can happen without a trace.

**Considered and rejected.**
- A Zod body on regenerate. The sibling TOTP routes use Fastify JSON schema, so this route uses `codeBodySchema` too.
- A recovery-code fallback for regenerate. A stolen recovery code would then mint new codes.
- `superAdminFreshMfa` on reset. The route needs a TOTP-verified super admin session and a written reason. Fresh MFA adds a step-up form for a rare action.

**Not included.** A recovery-code fallback. (A message to the target and a tenant-admin variant were open here. RW-91 below closes both.)

#### Tenant-admin reset and the notice email (RW-91, S10, 2026-10-16)

**What changed.** A tenant admin can reset the two-factor setup of a user in the same organisation. Every reset, from a tenant admin or a super admin, now sends a notice email to the target user.

**Tenant-admin reset flow.**
1. A tenant admin opens the Users page, chooses "Reset two-factor" on a row and writes a reason.
2. The client calls `POST /api/admin/users/:userId/totp/reset` with `{ reason }` (1 to 500 characters). Route: `apps/api/src/routes/admin-users-totp-reset.ts`.
3. The `authChain` gate needs role `admin` and a TOTP check in the last 15 minutes. The handler checks the same 15 minutes itself and returns 401 `FRESH_TOTP_REQUIRED` if the session is older. The UI then shows an inline TOTP step-up and retries.
4. The handler refuses the caller's own account (409 `SELF_RESET_FORBIDDEN`) and a `super_admin` target (403 `SUPER_ADMIN_TARGET`). A user of another tenant returns 404, because RLS hides the row.
5. `adminResetTotp` runs as in the super-admin flow above: it clears the secret, deletes the recovery codes and the sessions, and writes `auth.totp.reset` in one transaction.
6. After the reset returns, the route sends the notice. A send failure is logged and never fails the reset.

**Notice email.** Template `totp_reset_notice`, bulk lane. The subject is "Your two-factor sign-in was reset". The body has the recipient name, the reset time in UTC and who reset it ("an administrator" or "a platform administrator"). It has no secret, no actor name and no link. Both reset routes send it. See [13-email-system.md](13-email-system.md).

**Why the handler checks the fresh TOTP itself.** The generic check in `modules/01-auth/src/middleware/require-auth.ts` sits inside `if (isSuperAdmin || config.MFA_REQUIRED)`. For a tenant admin with `MFA_REQUIRED=false`, the check was skipped, so a stale session could reset another user's two-factor. An adversarial review found this before push (RCA_LOG 2026-10-16). The route now enforces the step-up for every configuration.

**Known gap.** The generic freshness check in the middleware still depends on `MFA_REQUIRED` for non-super roles. Any other route that relies on `freshMfaWithinMinutes` for an `admin` has the same hole while `MFA_REQUIRED=false`. Only this route has its own check. Followup: audit the other `freshMfaWithinMinutes` users, or make the middleware enforce the cap for every role.

**Considered and rejected.**
- A fix in the middleware for all routes in this change. It changes the behaviour of every step-up route and needs its own review.
- A link or the actor name in the notice. The notice must not give an attacker a click target or reveal who acted. The user asks the organisation, not the notice.
- A recovery-code fallback instead of a TOTP check. A stolen recovery code could then reset others.

**Not included.** A reset of a `super_admin` by a tenant admin. A notice to the actor. A retry of a failed notice.

**Downstream impact.** `GET /api/admin/users` items carry `totp_enrolled` (see [03-api-contract.md](03-api-contract.md)). The UI hides the menu item on the caller's own row, on users without TOTP, on candidates, on `super_admin` targets and on inactive or deleted users ([08-ui-system.md](08-ui-system.md) § "Users page: Reset two-factor"). The audit action is unchanged: `auth.totp.reset`.

**Downstream impact.** The super-admin Users list returns `totp_enrolled` (see [03-api-contract.md](03-api-contract.md)). Two new audit actions exist: `auth.recovery.regenerated` and `auth.totp.reset`. For the UI, see [08-ui-system.md](08-ui-system.md) § "Account security page".

### Flow 2 — Candidate login

An admin sets one of two modes for each assessment:

#### Mode A: SSO (default, internal)

The flow is the same Google SSO flow as for an admin, with these differences:

- `requireAuth(role: 'candidate', mfaRequired: tenant.totp_required_for_candidates)`: TOTP is optional for candidates by default. It is enforced if the tenant requires it.
- The candidate has no admin UI access, only candidate routes.
- The redirect target after authentication is the assessment that the candidate received an invitation for (`/take/<invitation-token>`).

#### Mode B: Magic link (cross-org, external candidates)

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
   → (Z-87) REAL invitation + phone/tablet client → 403 DEVICE_NOT_ALLOWED, nothing minted, invitation unused
   → (Z-91) REAL invitation, new attempt, readiness missing/failed → 422 READINESS_FAILED
   → mark invitation status='started'
   → create attempt, create session bound to user_id, totp_verified=true (TOTP not required for magic link mode)
   → return session cookie
```

**Magic links are single-attempt:** once `attempt.status` moves past `in_progress`, the token is dead. If the browser of the candidate crashes during an attempt, the candidate re-uses the same link until the attempt is `submitted`. After that, the link returns "already submitted, contact your admin."

### Flow 3 — Embed (host application iframes AssessIQ)

> **Status: LIVE 2026-05-03 (Phase 4 commit `b20858b`).** All implementation gaps in the spec-drift note below have been resolved. The `/embed` handler is fully implemented in `apps/api/src/routes/auth/embed.ts`. Migrations 0070–0073 have been applied to production. The `aiq_embed_sess` ↔ `aiq_sess` cookie bridge is live in `apps/api/src/server.ts`.

Use this flow when a host app embeds AssessIQ (Wipro internal portal, client product, and so on). The host app already authenticated the user. AssessIQ trusts the assertion of the host through a signed JWT.

#### Setup (one-time per tenant)

1. Tenant admin creates an embed secret in AssessIQ admin UI
   → `POST /api/admin/embed-secrets { name }`
   → server returns the secret value ONCE (then stores only encrypted form)
2. Host app stores the secret in its own backend env var

#### Per-request flow

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

**Host-host trust boundary:** AssessIQ trusts whatever the JWT says about identity. Suppose the host signs a token that claims to be `ceo@wipro.com`. AssessIQ believes the host. This is the correct model, but it means embed secrets are valuable. Rotate them every 90 days. Revoke a secret immediately on a suspected compromise.

**postMessage protocol** (for communication between the iframe and the parent):

- AssessIQ → host: `{ type: 'aiq.attempt.started', attemptId }`, `{ type: 'aiq.attempt.submitted', attemptId, summary }`, `{ type: 'aiq.height', px }` (auto-resize), `{ type: 'aiq.ready', tenantId, assessmentId }` (initial handshake), `{ type: 'aiq.error', code, message }`, `{ type: 'aiq.close-blocked', reason }` (the response to a close request while an attempt is in progress)
- Host → AssessIQ: `{ type: 'aiq.theme', tokens: {...} }` (runtime theming), `{ type: 'aiq.locale', locale: 'en-IN' }`, `{ type: 'aiq.close-request' }` (the host wants to close the iframe)
- The `tenant.embed_origins` allowlist pins the origin (see the spec-drift note below)
- For the full TypeScript type definitions of all message types, see `modules/12-embed-sdk/SKILL.md` § D3

> **Phase 4 spec drift — RESOLVED (2026-05-03 commit `b20858b`).**
>
> Phase 4 resolved two gaps that existed as "spec drift" before it:
>
> 1. **`tenants.embed_origins` column** — Migration `0070_embed_origins.sql` adds `embed_origins TEXT[] NOT NULL DEFAULT '{}'` to `tenants` with a GIN index. The `/embed` handler reads this column through `getEmbedOrigins()` and builds a per-tenant `frame-ancestors` CSP.
>
> 2. **`frame-ancestors 'none'` override** — The Fastify `/embed` handler sets `reply.header('Content-Security-Policy', 'frame-ancestors ' + origins.join(' '))` and removes `X-Frame-Options`. Caddy in reverse-proxy mode does not overwrite upstream response headers, so the per-tenant header reaches the browser intact. The production smoke test confirmed it: `curl -sI '/embed/health'` returns `content-security-policy` from Fastify, not the `frame-ancestors 'none'` fallback of Caddy.
>
> 3. **Cookie bridging** — `aiq_embed_sess` (SameSite=None) and `aiq_sess` (SameSite=Lax) are distinct cookies. An `onRequest` hook in `apps/api/src/server.ts` copies the value of the embed cookie to the standard cookie name, so all existing auth-chain middleware works unmodified on embed requests.

#### Embed JWT — claim contract

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

#### Embed secret rotation

`rotateEmbedSecret()` is a two-step atomic operation within a single `withTenant` transaction:

1. Mark the current `status='active'` row as `status='rotated'` (sets `rotated_at = now()`).
2. Insert a new `status='active'` row.

The verification path tries the active key first. On **signature mismatch only**, it falls back to the single most recent rotated row (`ORDER BY rotated_at DESC LIMIT 1`). Any other failure (`alg` confusion, expired `exp`, wrong `aud`, malformed payload) does NOT trigger the fallback. It rejects the token immediately. The DB enforces no TTL on rotated rows. The 90-day rotation cadence is a convention, not a code constraint. (`modules/01-auth/src/embed-jwt.ts:244-265`, `modules/01-auth/migrations/014_embed_secrets.sql:7-10`)

#### Embed JWT — request sequence

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

#### Embed JIT user rules (FR4)

*History: 2026-10-03.*

**What changed.** `resolveJitUser` in `modules/12-embed-sdk/src/jit-user.ts` (commits `eafeeac`, `7e2af3d`).
- It inserts only real `users` columns: id, tenant_id, email, name, role `candidate`, status, metadata, timestamps. The old code wrote `password_hash` and `email_verified`, which do not exist, so every first embed login failed.
- The insert uses `ON CONFLICT (tenant_id, email) DO NOTHING` and then a re-select, so two parallel first logins end with one row.
- The lookup is case-insensitive (`lower(email)`).
- It refuses with `AuthzError` 403 unless EVERY case-variant row has role `candidate`, status `active`, `deleted_at` null and `erased_at` null.

**Why.** The old code accepted any existing row, also an admin row (a privilege risk). A mixed-case admin row could shadow a lower-case candidate row.

**Considered and rejected.** Accept the first matching row (the shadow risk). A migration for a unique index on `lower(email)` (not needed, because the check reads all variants).

**Not included.** Embed iframe and Caddy `frame-ancestors` (FU-B13), FU-B14, FU-B15.

**Impact.** Behaviour change: embed now refuses an invited user in status `pending`. The Module 12 SKILL.md and `docs/RCA_LOG.md` carry the same facts.

### Flow 4 — API key (back-end integration)

Use this flow for host applications that do not use an iframe but call the REST API from server to server.

```
Authorization: Bearer aiq_live_<32-char-random>
```

- Keys are tenant-scoped, with a `scopes` array (for example `['attempts:read','results:read','assessments:write']`)
- The server stores `key_hash` (sha256). The system shows the full key to the user only at creation.
- Display prefix: the first 8 characters (`aiq_live_abc12345…`) identify the key in the admin UI
- Rate limits: for each key (configurable, default 1000 req/hour) and as a per-tenant aggregate
- The system updates `last_used_at` asynchronously (it does not block requests)
- Rotation: an admin creates a new key and has a 30-day grace period to migrate. Then the admin revokes the old key.

**Scope catalog (v1):**
- `assessments:read`, `assessments:write`
- `users:read`, `users:write`
- `attempts:read`, `attempts:write`
- `results:read`
- `webhooks:manage`
- `admin:*` (rare, for full automation)

### Flow 4b — Public credential verify (auth-bypass surface)

> **Status: LIVE 2026-05-11 (commit 7208008).** Phase 5 Session 3.

Recruiters and external verifiers check the authenticity of a certificate at `GET /verify/:credentialId`. They need no account, session cookie, API key or tenant context.

#### Why this is safe without authentication

The route reads `certificates` through a **GUC-based RLS policy** (`public_verify_lookup`), not through the standard `withTenant()` + `app.current_tenant` path. The policy covers SELECT only. It never permits UPDATE, INSERT or DELETE. (`modules/18-certification/migrations/0074_public_verify_policy.sql`)

```sql
CREATE POLICY public_verify_lookup
  ON certificates FOR SELECT
  USING (current_setting('app.public_verify', true) = 'true');
```

`withPublicVerifyContext()` opens a transaction, sets the GUC transaction-local (`is_local=true`), runs the callback and commits. The GUC reverts on COMMIT or ROLLBACK, and it cannot leak across pool connections. `credential_id` is globally unique across all tenants, so the query needs no `tenant_id` predicate and the code adds none. (`modules/18-certification/src/repository.ts:193-210`)

```
BEGIN
SET LOCAL ROLE assessiq_app                               -- re-engages RLS (dev safety)
SELECT set_config('app.public_verify', 'true', true)     -- transaction-local; auto-reverts
SELECT ... FROM certificates WHERE credential_id = $1    -- public_verify_lookup allows this
COMMIT                                                    -- GUC reverts here
```

#### HMAC guard (app-layer)

Every render calls `verifyCertificateSignature()` with `crypto.timingSafeEqual`. There are three outcomes, and all return HTTP 200 when the credential exists:

- **green badge** — the HMAC is valid and `revoked_at IS NULL`
- **red "Revoked" badge** — `revoked_at IS NOT NULL`; the page shows the revocation reason
- **red "Invalid Signature" badge** — the HMAC does not match (the data changed after issuance)

The route returns 404 only when `credential_id` is unknown. A recruiter who sees "Revoked" knows that the credential existed but is no longer valid. The recruiter does not mistake it for a forgery. (`modules/18-certification/src/routes-public.ts:327-368`)

#### Rate limiting and view dedup

- Per-IP: 60 req/hour, fixed-window, in-memory, 10 000-bucket cap. (`routes-public.ts:54-56`)
- Per-(IP, credentialId) view dedup: 1 h window, 50 000-entry cap. (`routes-public.ts:96-97`)
- `verification_views` counter: fire-and-forget through a **separate** `withTenant()` transaction. The main request path uses `withPublicVerifyContext` and never sets `app.current_tenant`. (`routes-public.ts:355-361`)

#### Request sequence

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

`registerVerifyRoutes(app)` registers the routes at `apps/api/src/server.ts:239-241` with no `authChain` argument. The global `tenantContextMiddleware` skips automatically when `req.session?.tenantId` is `undefined` (`modules/02-tenancy/src/middleware.ts:84-86`).

This flow also ships `GET /verify/:credentialId/og.svg`, a 1200×630 SVG for LinkedIn link previews, with `Cache-Control: public, max-age=3600`. It uses the same RLS path and the same HMAC check. (`routes-public.ts:374-424`)

### Flow 6 — Candidate magic-link login

> **Status: LIVE 2026-05-13 (Phase 5).** Migration `0076_candidate_login_tokens.sql` is applied to production. The routes `POST /api/auth/candidate/request-link` and `POST /api/auth/candidate/verify-link` are registered in `apps/api/src/routes/auth/candidate.ts`. The implementation is in `modules/01-auth/src/candidate-login.ts`. See `modules/01-auth/SKILL.md` § Candidate magic-link login.
>
> **Why the verify endpoint is POST, not GET.** Email-preview crawlers (Gmail, Outlook, Slack, Teams) prefetch link URLs with GET to render previews and to scan for malware. A GET verify-link would consume the single-use token on prefetch, before the candidate clicks. So the email link points at a SPA route `/candidate/login/verify?token=…`, which is safe to prefetch (it returns HTML). The JavaScript of that page makes the actual verification as a POST, which crawlers do not execute. Crawlers also do not follow `Set-Cookie` headers, so even a successful crawler GET would not mint a session. But the crawler would burn the token and lock out the real candidate.

This flow lets a candidate sign in without a password to view their certificates at `/candidate/certificates`. It is deliberately separate from the assessment-taking magic link (Flow 2 / `/take/:token`). That link is invitation-scoped and single-use for each attempt. This login link is identity-scoped and produces a long-lived 30-day session. So candidates can return to their certificate portfolio at any time, without a new action from an admin.

The trigger is the candidate who goes to `/candidate/login` without help, either through a "View my certificates" link in a notification email or directly. No admin action is required for each login. The admin only needs to have registered the candidate earlier as a `users` row in the tenant.

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

#### Session cookie spec for candidate sessions

The session that this flow produces uses the same `aiq_sess` cookie as the admin and assessment-taking sessions. `requireAuth` checks the role discriminator inside the session (`role='candidate'`).

| Property | Value |
|---|---|
| Cookie name | `aiq_sess` |
| Value | 32-byte CSPRNG; only `sha256` hash stored in DB |
| Flags | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| Lifetime | **30 days fixed** — NOT sliding. `extends_at` is never updated on access. |
| `totpVerified` | `true` — the magic link itself is the authentication factor; no TOTP step |
| Role | `candidate` |
| `session_type` | `standard` (not `embed`) |

The 30-day fixed lifetime is intentional. It differs from the 8-hour sliding admin session. Candidates do not visit daily, so a long fixed window avoids a forced re-auth for infrequent returners. The system **disables** idle eviction (the 60-minute `lastSeenAt` check in sessionLoader) for candidate sessions. See `modules/01-auth/src/candidate-login.ts` for the `skipIdleEviction: true` flag on `sessions.create`.

#### Anti-enumeration

`POST /api/auth/candidate/request-link` returns `204 No Content` whether or not the submitted email address matched, the tenant slug was valid or the rate limit was exceeded. This is intentional. A caller must never be able to tell "found" from "not found", or "slug valid" from "slug invalid", from the HTTP responses.

**Timing oracle defence (Fix 3 — 2026-05-13):** The no-match path (a slug miss before any DB work) was measurably faster than the match path. The match path does the slug resolve, the RLS user SELECT, the token INSERT, the audit and the email enqueue. `requestCandidateLoginLinkSystem` now wraps all work in `Promise.all([actualWork, sleep(200)])`, so both paths take at least 200 ms. The 200 ms floor swamps the ~10–50 ms timing difference at network-noise levels.

Do not add any response field that distinguishes "email found" from "email not found". Suppose a future feature needs a "we could not find that address" UX. Then implement it with a server-side hint that is time-limited and authenticated (for example, a short-lived signed cookie), not with an inline HTTP body difference.

#### Rate limits

| Dimension | Limit | Window | Notes |
|---|---|---|---|
| Per (IP, email) | 5 requests | 60 minutes | Fixed-window Redis counter `aiq:rl:cand-login:<ip>:<sha256(lower(email))>`; checked before any DB work in `requestCandidateLoginLinkSystem` |
| Response on exceed | `204 No Content` | — | Anti-enumeration: returning 429 would leak whether an email is active. The request is silently dropped. |
| Token TTL | 15 minutes | — | `candidate_login_tokens.expires_at = now() + interval '15 minutes'` |
| Token cardinality | Single-use | — | Atomic `UPDATE … WHERE consumed_at IS NULL RETURNING id`; a second click returns no row → redirect to `/candidate/login?error=invalid_link` |

**Rate-limit key design:** The email component of the Redis key is `sha256(lower(email))`. The system never writes the raw email address to the Redis keyspace, logs or memory dumps. Only the IP component is plaintext (Caddy and Fastify already log IPs).

The existing session expiry sweeper (Phase 3 follow-up) sweeps unconsumed, expired tokens. The partial index `candidate_login_tokens_user_unconsumed_idx ON (user_id) WHERE consumed_at IS NULL` keeps the live-token lookup fast, even with a long history of expired rows.

#### Mobile rendering (M1 — 2026-05-20)

The candidate magic-link UI (`/candidate/login`, `/candidate/login/verify`) is mobile-tuned with CSS only. **No flow, API or semantics change.** Under `[data-viewport="mobile"]` (M0 mechanism — see [`docs/10-branding-guideline.md` § 15](./10-branding-guideline.md#15-mobile)), the two-pane layout collapses to a single column. The right aside is hidden with `display: none`, and the `<main>` padding shrinks from `48px 64px` to `24px 22px`. `CandidateLoginVerify` (a centered spinner) is viewport-agnostic and unchanged.

The anti-enumeration timing, the rate-limit copy, the unconditional 204 response and the magic-link token semantics are identical across viewports. See [`docs/10-branding-guideline.md` § 15.3](./10-branding-guideline.md#153-pattern-reflows-catalog--m1m5-shipped-2026-05-20) for the full reflow catalog entry.

### Result-email sign-in link (Z-15 a, 2026-10-20)

**What.** The "View your result" button in the result email opens `/candidate/login/verify#token=<64 hex>`. The token is a normal row in `candidate_login_tokens` (sha256 hash only, tenant RLS), minted by `mintResultLoginToken` (`modules/13-notifications/src/email/result-login-token.ts`) with a 7-day expiry instead of 15 minutes. It is single use: the same atomic `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` of `verifyCandidateLoginTokenSystem` consumes it. Rate limit, audit rows (`auth.candidate.login_link_consumed`), session-fixation hygiene and the 30-day session are the existing verify path, unchanged. The 15-minute login-link TTL is unchanged.

**Why.** Before this the student tapped the button, typed the email again, waited for a second email, then reached Results (two emails, three steps).

**Fragment, then POST.** The token sits in the URL fragment, so the browser never sends it to a server and it is not in access logs. `CandidateLoginVerify.tsx` reads `location.hash` (the `?token=` query form stays for the login-link email), POSTs to `/api/auth/candidate/verify-link`, clears the fragment with `history.replaceState`, and goes to `/candidate/results`. A mail scanner that only does a GET never runs the script, so it cannot burn the token. A used, expired or unknown token gives one neutral message on the sign-in page: "This link has expired or was already used. Enter your email to get a new one."

**Failure mode.** If minting fails, the email still goes out with the plain sign-in URL. The send never fails because of this.

**Rejected.** Token in the query string (reaches servers and logs). A GET verify endpoint (scanners burn the token). A longer TTL for all login links (weakens the normal flow). Pre-filling the email only (still a second email).

**Withdrawn results (S38, owner decision).** `retireResultLoginLinks(client, userId)` in `modules/13-notifications/src/email/result-login-token.ts` marks every unused result-email link of the student as consumed (links that live longer than 1 hour only, so a fresh 15-minute login link stays valid). It is the same call that a new release already makes when it mints a link, so no column was added. No code path withdraws a released result today (status `released` is never reverted), so nothing calls it for that case yet: any future withdraw or un-release action MUST call it in the same transaction. Test: `result-login-token.test.ts` (used, expired, retired, newer link).

**Not included.** The link is not tied to one result: it signs the student in (same as any login link) and then the normal Results page rules apply. No endpoint changed, so `docs/03-api-contract.md` is unchanged. The tenant slug is not in the fragment, so after an expired link the student types the organisation code if the sign-in page asks for it.

**Downstream.** `result_released` template unchanged (`portalLink` now carries the fragment link). Help ids: none added (the message sits inside the existing sign-in banner).

### Flow 5 — Future auth methods (designed in)

A tenant admin opens *Settings → Authentication* and turns these methods on or off:

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

Each method is a Fastify plugin under `01-auth/providers/`. The `tenant_settings.auth_methods` JSONB tells the login page which buttons to show. To add a new method, you add a provider plugin, add it to the toggle UI and add it to the tenant settings JSON schema.

## Tenant and user life cycle

*History: Phase B and Phase C, 2026-05-20.*

Commits: `ae89669` (Phase B — tenant lifecycle), `2af9849` + `a888a43` (Phase C — user lifecycle + super-admin drill-down).

### Tenant state machine

States: `provisioning`, `active`, `suspended`, `archived`.

**Allowed transitions** (the source arrays come from `performLifecycleTransition` in [`modules/02-tenancy/src/service.ts:366–444`](modules/02-tenancy/src/service.ts#L366)):

| Transition | Trigger | Session effect |
|---|---|---|
| `provisioning` → `active` | First admin invite accepted (separate onboarding flow) | — |
| `active` → `suspended` | `POST /api/admin/super/tenants/:tenantId/suspend` | `destroyAllForTenant` |
| `active` → `archived` | `POST /api/admin/super/tenants/:tenantId/archive` | `destroyAllForTenant` |
| `suspended` → `active` | `POST /api/admin/super/tenants/:tenantId/resume` | none |
| `suspended` → `archived` | `POST /api/admin/super/tenants/:tenantId/archive` | `destroyAllForTenant` |
| `archived` → `active` | `POST /api/admin/super/tenants/:tenantId/unarchive` | none |

**Disallowed transitions** (they throw `ConflictError { code: "INVALID_LIFECYCLE_TRANSITION" }`):

- `provisioning` → `suspended` / `archived`
- `archived` → `suspended`

Any transition where the source equals the target is **idempotent**. The endpoint returns `200` with `noOp: true`, writes no audit row and runs no session sweep.

**Session revocation.** `suspend` and `archive` both call `sessions.destroyAllForTenant(tenantId)` ([`modules/01-auth/src/sessions.ts:296–323`](modules/01-auth/src/sessions.ts#L296)) immediately after the DB status flip. The sweep collects all `user_id`s with active Postgres session rows for the tenant. Then it calls `destroyAllForUser` for each user. This clears both the Redis hash keys and the Postgres `sessions` rows, so every active cookie becomes invalid on the very next request. This is defence in depth: even a cookie-holder who did not see the suspend cannot reuse the session. `resume` and `unarchive` do **not** recreate sessions. Affected users must sign in again normally.

### User state machine

States: `pending`, `active`, `disabled` (the `users.status` column), plus the orthogonal `deleted_at IS NOT NULL` soft-delete flag. The two axes are independent: a user can be `disabled` and then soft-deleted, or `active` and soft-deleted.

**Allowed transitions** (the source is [`modules/03-users/src/invariants.ts:70–83`](modules/03-users/src/invariants.ts#L70) for status, and the service layer for soft-delete and restore):

| Transition | Trigger | Session effect |
|---|---|---|
| `pending` → `active` | `acceptInvitation` (magic-link; out of scope here — see Flow 1a / 2) | — |
| `pending` → `disabled` | admin revoke-before-accept via `PATCH status=disabled` | none (no sessions yet) |
| `active` → `disabled` | `POST /api/admin/users/:id/disable` (tenant-admin) or `POST /api/admin/super/users/:userId/disable` (super-admin) | `sweepUserSessions(userId)` |
| `disabled` → `active` | `POST /api/admin/users/:id/reenable` / `…/super/…/reenable` | — |
| `active` → soft-deleted (`deleted_at` set) | `DELETE /api/admin/users/:id` / `…/super/…/:userId` | `sweepUserSessions(userId)` + cascades pending invitations |
| `disabled` → soft-deleted | same endpoints | `sweepUserSessions(userId)` + cascades pending invitations |
| soft-deleted → (prior status) | `POST /api/admin/users/:id/restore` / `…/super/…/restore` | none; status column unchanged |

`restore` clears `deleted_at` only. The `status` column reverts to its value before the deletion (`active` or `disabled`). A restore does **not** recreate pending invitations.

**Last-admin invariant.** You cannot disable or soft-delete the last `active` + `role='admin'` + `deleted_at IS NULL` user in a tenant. `assertNotLastAdmin` ([`modules/03-users/src/invariants.ts:19–51`](modules/03-users/src/invariants.ts#L19)) enforces this on the tenant-admin path through a `FOR NO KEY UPDATE` CTE, which prevents TOCTOU races. The super-admin path inlines its own equivalent SQL ([`apps/api/src/routes/admin-super.ts:1154–1173`](apps/api/src/routes/admin-super.ts#L1154)). It bypasses the check when `confirm_last_admin: true` **and** `reason` is non-empty. On a refusal, details.code remains `"LAST_ADMIN"`. The super-admin path never calls the `assertNotLastAdmin` function itself.

**Self-action guards.** The tenant-admin path (`apps/api/src/routes/admin-users.ts`) throws `ConflictError { code: "CANNOT_DISABLE_SELF" }` and `{ code: "CANNOT_DELETE_SELF" }` when the actor targets the own user record of the actor. The super-admin path has no equivalent guard. `super_admin` sessions carry the platform tenant context and do not live inside any company tenant, so the guard does not apply.

### Session-loader enforcement contract

Every authenticated request runs `userIsActive` and then `tenantIsActive` inside `sessionLoaderMiddleware` ([`modules/01-auth/src/middleware/session-loader.ts:86–178`](modules/01-auth/src/middleware/session-loader.ts#L86)), after the Redis session lookup and the idle-eviction check.

Both functions throw `AuthnError("session rejected")` on failure. The system destroys the session token before the throw, so nobody can replay the cookie.

**Structured `details` payload:**

| `details.scope` | `details.reason` | Condition |
|---|---|---|
| `"user"` | `"inactive"` | `users.status !== 'active'` OR `users.deleted_at IS NOT NULL` ([`session-loader.ts:52`](modules/01-auth/src/middleware/session-loader.ts#L52)) |
| `"user"` | `"check_failed"` | DB error during user check — fail-closed ([`session-loader.ts:139`](modules/01-auth/src/middleware/session-loader.ts#L139)) |
| `"tenant"` | `"inactive"` | `tenants.status NOT IN ('active', 'provisioning')` ([`session-loader.ts:75`](modules/01-auth/src/middleware/session-loader.ts#L75)) |
| `"tenant"` | `"check_failed"` | DB error during tenant check — fail-closed ([`session-loader.ts:161`](modules/01-auth/src/middleware/session-loader.ts#L161)) |

The user check runs **first**. A disabled user receives a `scope: "user"` error, even if the tenant is also suspended. This keeps the error scope unambiguous.

**Error-message hygiene.** The `AuthnError` message is intentionally the generic string `"session rejected"` for both scopes. An attacker who holds a cookie cannot use the error string to tell "my account was disabled" from "my tenant was suspended". The API error envelope surfaces the `details.scope` field for **internal observability** (server logs, operator tooling). Phase D uses it as the contract to render state-aware copy on post-auth screens. State-aware copy is not a security boundary, because operators can still see the scope in logs.

`tenantIsActive` allows both `'active'` and `'provisioning'`. The latter permits the `createTenant` orchestration window (seed and invite steps) without a block on the session of the first admin during the flow.

### Audit log emissions

Source: [`modules/14-audit-log/src/types.ts`](modules/14-audit-log/src/types.ts) `ACTION_CATALOG`.

**Tenant lifecycle actions:**

- `tenant.suspended` — active → suspended
- `tenant.resumed` — suspended → active
- `tenant.archived` — active/suspended → archived
- `tenant.unarchived` — archived → active
- `tenant.purged` — `archived → purged` by the retention job (RW-48b). One row per purged tenant. See "Tenant purge" below.

**User lifecycle actions:**

- `user.disabled` — active → disabled
- `user.reenabled` — disabled → active
- `user.soft_deleted` / `user.deleted` — any status → soft-deleted. The catalog keeps both names for backward compatibility:
  - Tenant-admin path: `auditInTx` (audit_log) emits `user.deleted`; `logLifecycleEvent` (operational JSONL) emits `user.soft_deleted`.
  - Super-admin path: BOTH channels emit `user.soft_deleted`.
  - The catalog comment in [`modules/14-audit-log/src/types.ts:157`](modules/14-audit-log/src/types.ts#L157) notes that the two are functionally equivalent. The duplicate exists so that admin queries scoped to `user.deleted` do not miss historic rows.
- `user.restored` — soft-deleted → prior status
- `user.invitation_cancelled` — an admin explicitly cancelled a pending invitation before acceptance

The system writes audit rows inside the **same `withTenant` transaction** as the status mutation, through `auditInTx`. If the audit write fails, the status change rolls back. No-op transitions (idempotent same-state calls) do not emit an audit row.

**Override rows.** When the super-admin bypass path runs (`confirm_last_admin: true` + non-empty `reason`), the `after` JSONB column of the audit row includes `is_override: true` ([`admin-super.ts:1199`](apps/api/src/routes/admin-super.ts#L1199), [`admin-super.ts:1412`](apps/api/src/routes/admin-super.ts#L1412)). `logLifecycleEvent` emits at `WARN` level when `isOverride=true` ([`admin-super.ts:1066`](apps/api/src/routes/admin-super.ts#L1066)).

### Tenant purge (RW-48b, S10, 2026-10-15)

**What.** `purgeArchivedTenants({now, enabled, minDays})` in `modules/02-tenancy/src/purge.ts` removes the data of tenants that stayed archived for at least 180 days. The module also exports `MIN_PURGE_DAYS = 180` and the report types.

**Selection.**

- The status is `archived` and `updated_at` is older than `minDays`. The code clamps `minDays` to 180 or more.
- `tenants` has no `archived_at` column. `archiveTenant` stamps `updated_at`, and an archived tenant is otherwise frozen. So `updated_at` is the archive time. A later rename can only delay the purge, which is the safe direction.
- The platform tenant never qualifies. The code checks `config.PLATFORM_TENANT_ID` and the slug `platform`.

**Purge steps.** Each tenant runs in its own `withSystemRole` transaction. One tenant failure rolls back only that tenant.
1. Delete rows `WHERE tenant_id = $1` from every public base table that has a `tenant_id` column. Exceptions: `audit_log`, `tenants`, `users`.
2. The order comes from the catalog (`information_schema` and `pg_constraint`), children first.
3. The code clears tables with no `tenant_id` that point to `users` by foreign key, for the users of the tenant. It excludes `audit_log`.
4. The code keeps the `users` rows as pseudonymised tombstones. It uses the step 3 expressions of `modules/20-data-rights/src/erasure.ts`: `deleted_user_<sha12>`, `deleted+<sha12>@erased.assessiq.local`, metadata without `roll_number` and `branch`, and `erased_at`.
5. The code sets `tenants.status = 'purged'`.
6. The code writes one `tenant.purged` audit row with per-table counts, including `counts.users_pseudonymised`.

`audit_log` rows survive. Its foreign key `actor_user_id → users` stays as it is. This is why the user rows stay.

**Gate.** `enabled` defaults to false. A false value is a dry run: the function reports candidates and changes nothing. The worker (`apps/api/src/worker.ts`) registers the repeatable job `tenant-purge-cron` at 03:30 UTC with 1 attempt. It sets `enabled` from `process.env.TENANT_PURGE_ENABLED === "true"`. Only the worker reads this flag. It is not in the `00-core` config. See [06-deployment.md](06-deployment.md).

**State.** Migration `modules/02-tenancy/migrations/0170_tenant_purge.sql` widens `tenants_status_check` to allow `purged`. `TenantStatus` gains `"purged"`. `assertTenantActive` already rejects any status other than active or provisioning, so a purged tenant cannot log in.

**Considered and rejected.**
- A new `archived_at` column. It needs a trigger or a service edit to stay correct.
- A hand-written table list. It goes stale when a migration adds a table. The catalog query does not.
- Dropping the `audit_log → users` foreign key. It would weaken the append-only audit invariant.

**Not included.** Per-table counts in a dry run. Purge of external storage (S3, Redis). Un-purge. A cap on tenants per run.

**Downstream impact.** The system now emits the new audit action `tenant.purged`. For the data model, see [02-data-model.md](02-data-model.md) § "tenants.status".

### Lifecycle carry-forwards (not in this commit)

- **Mint-time `assertTenantActive` on magic-link / SSO / email-OTP session creation.** Session creation endpoints do not call `assertTenantActive` at mint time. The `createSession` call does not block a new login attempt of a suspended tenant. `sessionLoaderMiddleware` blocks it on the very next authenticated request, so no privilege escalation is possible. But the minted cookie exists for a brief window before the next request evicts it. This is a carry-forward hardening pass.
- **Provisioning TTL.** There is no TTL on `tenants.status = 'provisioning'`. A tenant whose first admin never accepts the invitation stays in `provisioning` indefinitely. The code has no background cleanup sweep.
- **Phase D state-aware copy — DONE (RW-48a, shipped earlier; verified S10, 2026-10-15).** The login pages show different copy for `details.scope = "user"` and `"tenant"`. The scope-to-copy mapping lives in `apps/web/src/lib/authScope.ts`. See "Session-revocation UX" below.

## Rate limits, trust and edge protection

This section explains how AssessIQ limits request volume, which client IP it trusts and how the edge proves that a request came through Cloudflare.

### Role-aware IP rate limiting

> **Status: LIVE 2026-05-15** — the redesign replaces the 2026-05-04 opt-in bypass. See `modules/01-auth/src/middleware/rate-limit.ts` + `apps/api/src/middleware/auth-chain.ts`.

#### Design

The middleware resolves the role for each request from `req.session.role`, `req.apiKey` or the anonymous fallback:

| Tier | Bucket max (default) | Env var | Scope |
|---|---|---|---|
| admin session (admin + super_admin) | 100 req/min/IP | `RATE_LIMIT_IP_ADMIN` | **All routes** |
| candidate session (valid, role=candidate) | 3000 req/min/IP (campus lab, see § Campus-scale below) | `RATE_LIMIT_IP_CANDIDATE_SESSION` | **All routes** |
| unknown-role session | 30 req/min/IP | `RATE_LIMIT_IP_USER` | **All routes** |
| anonymous (no session, no key) | 30 req/min/IP | `RATE_LIMIT_IP_ANON` | **All routes** |
| API key (`Authorization: Bearer aiq_live_*`) | 600 req/min/IP | `RATE_LIMIT_IP_APIKEY` | **All routes** |
| Per-user | 60 req/min | — (unchanged) | Authenticated sessions |
| Per-tenant | 600 req/min | — (unchanged) | Authenticated + API-key |

All four `RATE_LIMIT_IP_*` env vars are optional. The `00-core` Zod config provides safe defaults through `.default(N)`, so existing deploys work without `.env` changes.

#### Chain order (unchanged from 2026-05-04)

`sessionLoader` runs before `rateLimit`, so `resolveIpBucketMax(req)` can read `req.session.role` when it chooses the bucket max. Anonymous requests (no `aiq_sess` cookie) short-circuit sessionLoader in <1 ms, with no Redis hit.

#### Bypass — removed

`allowVerifiedAdminBypass: boolean` in `rateLimitMiddleware(opts)` and `authChain({ allowVerifiedAdminBypass })` is **gone** as of this redesign. There is no opt-in per-route bypass. The IP bucket scales automatically with the session role.

The old bypass predicate required `session.totpVerified === true`. That was **never true** while `MFA_REQUIRED=false` (the production default). So the bypass was effectively dead code in production. Every admin login flow (`/start` → `/cb` → `/whoami` × retries) hit the old 10/min/IP cap and returned 429 to itself.

#### Path N decision — TOTP/recovery endpoints not special-cased

`POST /api/auth/totp/verify`, `POST /api/auth/totp/recovery` and `POST /api/auth/totp/enroll/confirm` do **not** get a separate, tighter IP bucket. Admin sessions hit 100/min/IP on these routes, the same as on all other routes.

**Security posture:** an attacker on `/api/auth/totp/verify` must already hold a **pre-MFA session** (a valid `aiq_sess` with `totpVerified=false`). This requires control of the Google identity that minted it. The effective rate is `min(IP_bucket, user_bucket)` = 60/min (the user bucket, unchanged). The **5-fail-in-15min account lockout** (decision #4) is the primary TOTP brute-force defense and remains unchanged.

**Brute-force window regression:** In the old design (10/min/IP on auth routes), lockout triggered after ~35 days at the anon rate. In the new design (30/min anon, 100/min verified admin), lockout triggers after ~3.5 days at the admin rate. This is a deliberate regression, accepted by the user on 2026-05-15. The test "admin gets 100/min/IP on TOTP verify (Path N — blacklist dropped per user decision 2026-05-15, brute-force window ~3.5 days)" pins it in `modules/01-auth/src/__tests__/middleware.test.ts`.

#### Production override — admin IP cap 100 → 500 (2026-05-20)

**What changed:** `RATE_LIMIT_IP_ADMIN=500` is set in `/srv/assessiq/.env` on the production VPS. The code default in `modules/00-core/src/config.ts` stays at 100. Dev, test and CI continue at the conservative default. Only production takes the higher cap.

**Why:** the operator saw real 429s during normal admin navigation. A log analysis of the affected IP showed `/api/auth/whoami` re-fetched on every navigation (50 calls in 10 min from a single user). It also showed polling of `/api/admin/dashboard/queue` (~22 in 10 min) and the natural Google SSO, MFA and logout cycles during testing. Together, a single admin session can sustain >100 req/min in 60 s windows during legitimate use. The team tuned 100/min for the *security-only* tradeoff. Under real client-side traffic patterns, it is too tight.

**Considered and rejected:**

- *Stay at 100/min and fix the `whoami` spam.* This is still the right structural fix (it cuts ~40% of the admin request volume), but it is a separate session from this immediate UX unblock.
- *Raise the code default to 500.* Rejected: it weakens the ability of dev, test and CI to catch a client-side request storm early. The env override keeps the safety net outside production.
- *Raise per-user (60/min) or per-tenant (600/min) instead.* This does not help. The bucket that actually exhausts is the per-IP bucket (the most restrictive of the three for a single admin).

**Not included:** The ANON (30/min), USER/candidate (30/min) and APIKEY (600/min) tiers are unchanged, because none showed 429s on legitimate traffic. The code defaults in `00-core` are unchanged. `trustProxy:true` and the origin-verify gate are unchanged.

**Security trade-off (accepted):**

- Brute-force window for each IP: ~3.5d → ~0.7d for a single TOTP (5× the rate).
- **The primary TOTP defense is unchanged.** The per-user lockout after 5 failures in 15 min (counter `aiq:auth:totpfail:<userId>` + `aiq:auth:lockedout:<userId>` TTL 15m) keeps the TOTP of any one user at ~2.85 years to brute-force, *regardless of the IP limit*. The IP bucket is a *mass-scale* throttle (one IP that probes many users), not the per-TOTP defense.
- Origin-verify `enforce` is live (`3b2fe73`, 2026-05-19). It blocks IP spoofing through a direct connection to the origin, so the 500/min applies only to verified Cloudflare traffic. An attacker cannot rotate IPs easily to evade the limit.
- Net: this loosens the mass-scale single-IP throttle 5×. This is the right tradeoff, because the per-user lockout already carries the primary defense.

**Supersedes** the "100/min admin / ~3.5d brute-force window" sentence above **for production only**. Dev and test still see 100/min. To reverse it on production, remove the `.env` line and run `force-recreate assessiq-api`. Timestamped `.env.bak.<TS>` backups exist on the VPS.

**Downstream impact:** The team updated the `middleware.test.ts` PathN test (2026-05-20) to use `totpVerified: false` explicitly, and added the credential bucket test as PathN-Credential. Revisit future tuning if (a) the per-user lockout decision #4 ever changes, or (b) origin-verify ever drops from `enforce`. You would need to re-reason both invariants together.

#### Tiered model by auth state (2026-05-20 redesign)

**Status: LIVE 2026-05-20** — this redesign shifts the model from a single cap for each role to a two-layer model. A per-IP cap scales with the MFA state. An immovable per-route credential cap protects the TOTP and OTP endpoints regardless of tier.

##### What changed

The team added three new env vars to `modules/00-core/src/config.ts` and three new rate-limit buckets to `modules/01-auth/src/middleware/rate-limit.ts`:

| Bucket | Key | Default | Applies to | Condition |
|---|---|---|---|---|
| IP — verified admin | `aiq:rl:ip:<ip>` | `RATE_LIMIT_IP_VERIFIED_ADMIN=5000/min` | All routes | role∈{admin,super_admin} AND `totpVerified===true` (reviewer removed from the admin tier 2026-10-03) |
| Per-user — verified admin | `aiq:rl:user:<userId>` | `RATE_LIMIT_USER_VERIFIED_ADMIN=300/min` | Authenticated routes | Same condition |
| Credential | `aiq:rl:cred:<routePath>:<ip>` | `RATE_LIMIT_CREDENTIAL=20/min` | 5 credential routes only | ALWAYS (regardless of session tier) |

**A pre-MFA admin (`totpVerified !== true`) is byte-identical to before:** the IP cap stays at `RATE_LIMIT_IP_ADMIN` (100/min code default, 500/min production override), and the user cap stays at 60/min.

Credential routes with `credentialEndpoint: true` (the 9 token and credential-consuming endpoints, expanded from the original 5 after the 2026-05-20 adversarial review found 4 more surfaces):

- `POST /api/auth/totp/enroll/start` (`apps/api/src/routes/auth/totp.ts`) — generates a fresh TOTP secret; defense in depth against rapid secret cycling (adversarial finding 1)
- `POST /api/auth/totp/enroll/confirm` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/totp/verify` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/totp/recovery` (`apps/api/src/routes/auth/totp.ts`)
- `POST /api/auth/login/email/request` (`apps/api/src/routes/auth/google.ts`)
- `POST /api/auth/login/email/verify` (`apps/api/src/routes/auth/google.ts`)
- `GET /api/auth/login/identities` (`apps/api/src/routes/auth/google.ts`) — reads the continuation token; consistent with the other token-consuming endpoints (adversarial finding 5)
- `POST /api/auth/login/select` (`apps/api/src/routes/auth/google.ts`) — consumes the continuation token and chooses the identity (adversarial finding 2)
- `POST /api/auth/candidate/verify-link` (`apps/api/src/routes/auth/candidate.ts`) — magic-link consume (adversarial finding 4)

**super_admin tier inclusion (behaviour change for an already-rare role):** The code before 2026-05-20 at `rate-limit.ts:106` listed only `admin || reviewer` for the admin tier. `super_admin` fell through to the conservative candidate-tier IP cap (30/min). The redesign explicitly adds `super_admin` to the admin role set (`role === "admin" || role === "reviewer" || role === "super_admin"`), so a verified super_admin gets the same 5000/min tier as a verified tenant admin. No practical regression: a migration blocked super_admin sessions until 2026-05-17 (`obs 3106`). So this changes a tier that was first broken and then throttled at 30/min to the intended 5000/min for the platform-administration role.

**Credential bucket key construction (adversarial finding 3):** The code builds the per-route bucket key from `req.routeOptions?.url ?? "unknown"`. We REMOVED the `req.url` fallback. `req.url` includes query parameters, which would let an attacker vary the query (`?nonce=1`, `?nonce=2`…) to mint fresh per-query buckets and defeat the 20/min cap. With the fix, an unmatched route falls into one shared `"unknown"` bucket. This is strictly safer than a key that an attacker controls.

##### Why

The operator saw that verified admins (post-MFA) who did normal admin work hit the same 100/min cap as brute-force attackers. The redesign separates the concerns:

- **Verified admin** → a relaxed IP cap (5000/min, a DoS ceiling only). The per-user cap (300/min) and the credential cap (20/min) are the meaningful constraints.
- **Brute-force surface (credential endpoints)** → IMPROVED from 100/min to 20/min. The IP lift for verified admins does not weaken TOTP protection, because the credential bucket is unconditional.
- **Everyone else** → unchanged.

##### What was considered and rejected

- *Apply the credential cap to ALL routes for all tiers.* Rejected. The goal is targeted protection for credential endpoints, not global tightening. A credential cap on non-credential routes would throttle legitimate admin workflows.
- *Raise per-user from 60 to 300 for all admins (not only verified).* Rejected. Pre-MFA sessions have lower assurance, so the conservative 60/min is correct until the user proves TOTP.
- *Configurable per-route caps.* Rejected as scope creep. The credential cap is a security invariant, not a tuning knob. Per-route configuration invites drift.
- *Use the existing `RATE_LIMIT_IP_ADMIN` at a higher value.* Rejected. It merges pre-MFA and post-MFA admins into one bucket. The redesign preserves independent control.

##### What is NOT included

- A verified-admin bypass of the credential cap. The 20/min credential cap is unconditional by design. There is no `credentialEndpointBypass` option, and nobody will add one.
- A dynamic credential cap (auto-tighten on surge). Not included. The account lockout (decision #4) handles a surge for each user.
- A difference between candidate sessions and pre-MFA admin at the IP layer. Both stay at their existing tiers.

##### Downstream impact

- `modules/00-core/src/config.ts`: three new Zod env vars (`RATE_LIMIT_IP_VERIFIED_ADMIN`, `RATE_LIMIT_USER_VERIFIED_ADMIN`, `RATE_LIMIT_CREDENTIAL`).
- `modules/01-auth/src/middleware/rate-limit.ts`: `resolveIpBucketMax` is updated; `RateLimitOptions.credentialEndpoint` is added; `Limit.scope` is extended with `"credential"`; the per-user bucket is tier-aware; `resolveIpBucketMax` is exported (it was already exported since the 2026-05-15 redesign).
- `apps/api/src/middleware/auth-chain.ts`: `credentialEndpoint` option added to `AuthChainOpts`; `_rateLimitCredential` instance + `publicCredentialAuthChain` export added.
- `apps/api/src/routes/auth/totp.ts`: `credentialEndpoint: true` added to all three TOTP routes.
- `apps/api/src/routes/auth/google.ts`: email-OTP routes switch from `publicAuthChain` to `publicCredentialAuthChain`.
- `modules/01-auth/src/__tests__/rate-limit-tiered.test.ts`: NEW — Redis-free unit coverage for T1-T9 (IP tier, user tier, credential bucket composition).
- `modules/01-auth/src/__tests__/middleware.test.ts`: PathN test updated; PathN-Credential added.
- `modules/00-core/src/__tests__/config.test.ts`: three default tests + three override tests + three invalid tests added.
- `.env.example`: three new vars with comments.

##### 2026-05-22 — anon IP cap raised 30 → 120 (login-screen 429 fix)

`RATE_LIMIT_IP_ANON` default is raised 30 → **120/min** (`modules/00-core/src/config.ts`, commit `ad88f72`).

- The anonymous tier gates the ENTIRE pre-auth surface. Every load or return to a protected `/admin/*` route fires a `GET /api/auth/whoami` probe (`RequireSession`), and the login and MFA flow is anonymous until the cookie is set.
- At 30/min, a single admin who reloaded the live login page (or several users behind one NAT) exhausted the cap. The admin got `RATE_LIMITED (scope=ip)` **on the login screen**, before the admin could reach MFA and the 5000/min verified-admin tier.
- 120/min is a DoS knob only. Credential brute-force stays on the unconditional 20/min credential bucket above, which is unaffected.
- The production `.env` does not pin this value, so the code default applies.
- The frontend pairs this change with the Phase D `whoami` 429-backoff (commit `60d4d23`; it honours `retryAfterSeconds` and causes no re-fire storm).
- For the full RCA, see `docs/RCA_LOG.md` 2026-05-22 "429 on the admin login screen".
- NB: the "What changed vs 2026-05-04" comparison table below still reads "100/30/30/600 per tier" for the historical redesign. **Anon is now 120.**

#### Redis key

Old: `aiq:rl:auth:ip:<ip>` (applied to `/api/auth/*` only)
New: `aiq:rl:ip:<ip>` (applies to all routes)

Old keys expire naturally within 60 seconds, so no migration script is required.

#### What changed vs 2026-05-04 design

| Component | Before | After |
|---|---|---|
| IP bucket scope | `/api/auth/*` only | All routes |
| IP bucket max | 10/min (anon), dev=100/min | Role-aware: 100/30/30/600 per tier |
| Bypass mechanism | `allowVerifiedAdminBypass: boolean` opt-in per route | Removed — no bypass |
| Always-strict blacklist | `totp/*`, `google/cb`, `take/start` | Removed — not needed without bypass |
| Env var knobs | None (hardcoded) | `RATE_LIMIT_IP_{ADMIN,USER,ANON,APIKEY}` |
| Redis key | `aiq:rl:auth:ip:<ip>` | `aiq:rl:ip:<ip>` |

#### What was considered and rejected

- **Keep the bypass but widen the predicate to the `MFA_REQUIRED=false` path.** Rejected. The opt-in whitelist design requires every new route to join the list, and missed routes silently get the wrong limit. The role-aware design is correct by default.
- **Separate tighter buckets for TOTP endpoints.** Rejected. The account lockout (decision #4) is the right defense against TOTP brute force. A second bucket adds complexity without a meaningful security gain, given the session prerequisite.
- **Configurable per-endpoint limits.** Rejected as scope creep. The four-tier role-based design covers all known use cases.

#### What is NOT included

- Per-endpoint limit overrides.
- Dynamic limit adjustment (for example, auto-tighten on a failed-login surge).
- A difference between candidate sessions and reviewer sessions (both use the `RATE_LIMIT_IP_USER` default). The reviewer role is removed (2026-10-03). A legacy reviewer row falls to the user tier.

#### Downstream impact

- `modules/01-auth/src/middleware/rate-limit.ts`: full rewrite. `resolveIpBucketMax()` replaces `shouldBypassIpBucket()`, and the Redis key is renamed.
- `apps/api/src/middleware/auth-chain.ts`: single `rateLimitMiddleware()` instance. `allowVerifiedAdminBypass` is removed from `AuthChainOpts`.
- `apps/api/src/routes/auth/{whoami,google,logout}.ts`: `allowVerifiedAdminBypass: true` removed from `authChain()` calls.
- `modules/00-core/src/config.ts`: four new optional env vars with Zod `.default()`.
- `modules/01-auth/src/__tests__/middleware.test.ts`: the B1–B12 bypass tests are removed. T1–T5 role-tier tests, N1 (bypass removal proof) and N2 (non-auth route anon bucket) are added.
- [ ] Log every authentication outcome to `audit_log`
- [ ] Periodic session sweeper (purge expired from Redis + Postgres)
- [ ] Force re-auth on email change, role change, password reset
- [ ] HSTS header at edge with preload-eligible config
- [ ] CSP header tight enough to prevent inline-script execution in admin UI

### Campus-scale rate limits and DB pool (task R2)

*History: 2026-10.*

**Problem.** A campus placement drive has 100-500 students in one lab behind ONE public IP, and all of them take the test at once. These limits all returned 429 to the lab or starved it in the middle of the test: the per-IP bucket (30/min candidate, 120/min anon), the 20/min credential cap on `verify-link`, the hardcoded 600/min per-tenant cap and a 10-connection pg pool.

**What changed (`rate-limit.ts`, `auth-chain.ts`, `config.ts`, `pool.ts`, `server.ts`):**

| Control | Before | After | Env var |
|---|---|---|---|
| Per-IP, valid candidate session | 30/min | 3000/min (DoS ceiling; mirrors the verified-admin lift) | `RATE_LIMIT_IP_CANDIDATE_SESSION` |
| Per-user, candidate | 60/min | 120/min | `RATE_LIMIT_USER_CANDIDATE` |
| Per-tenant (session + apiKey) | 600/min hardcoded | 6000/min | `RATE_LIMIT_TENANT` |
| Entry routes `POST /take/start`, `POST /api/auth/candidate/verify-link` | 120/min anon IP (and 20/min credential on verify-link) | dedicated per-route per-IP bucket `aiq:rl:entry:<route>:<ip>` 2000/min (2 calls per student: preview + Begin, plus reloads) via `authChain({ candidateEntry: true })` | `RATE_LIMIT_IP_CANDIDATE_ENTRY` |
| pg pool max | 10 | 30 | `PG_POOL_MAX` |

**Why these numbers.** Autosave debounces 5 s per question (`useAutosave`, ~12 saves/min). Flush-on-blur and navigation, timer sync, and flag and event posts add more. The worst realistic case is ~30/min for each student. So 120/min for each user gives 4x headroom, including client retry bursts, and still stops a runaway script. Tenant 6000 = 500 students x 12 req/min. Session IP 3000 = 500 x 6. Entry 600 = 2x a 300-student lab. Pool: Postgres `max_connections` is the default 100 (compose sets none). The api uses 30 and the worker uses 30, so 60 are used and ~37 remain for migrations, psql and backups. Lower the worker through the env var if needed.

**Why safe.** Session validity comes from `sessionLoader` (a Redis lookup) before the limiter runs, so a forged cookie stays on the anon tier. The per-user bucket is still the real per-student limit. Magic-link tokens are 256-bit random and single-use, so 2000/min/IP leaves brute force infeasible. The entry bucket uses its own key, so an entry burst does not consume the general anonymous bucket of the lab. Admin credential endpoints (TOTP, email OTP, login select/identities) keep the unchanged 20/min `credentialEndpoint` bucket. The fail-closed behaviour on a missing client IP in production is unchanged. We moved `verify-link` from `credentialEndpoint` to `candidateEntry` deliberately.

**Considered and rejected.** Raising the global anon IP cap (it weakens every public route). Keying the limiter by attempt id (this needs a DB or Redis lookup before the limiter, and the session already identifies the student).

**Request-scoped tenant transaction removed.** `tenantContextMiddleware` was a global `preHandler` that checked out a pool client and ran `BEGIN` for each request. Evidence: nothing reads `req.db` or `req.tenant` (only `server.ts` referenced `req.db`), and all DB access uses `withTenant()`. `sessionLoader` is a per-route preHandler, and Fastify runs global preHandlers first. So the hook never saw `req.session` in production. It was dead code that would have pinned a second connection for the whole request if it ever fired. We removed the registration in `server.ts`. The exported helper stays in `02-tenancy` with a "do not register globally" note.

**Not included.** Per-route-group candidate caps, Redis-cluster sharding of the buckets and pgbouncer. Load script: `tests/load/scenarios/candidate-drive.js` (staging and local only).

### Candidate request-link limits and the tenant-op throttle (S2/N2 and S7/N5, S14, 2026-10-16)

*History: 2026-10-16.*

- **What changed.** `POST /api/auth/candidate/request-link` now uses the candidate-entry per-IP bucket (`RATE_LIMIT_IP_CANDIDATE_ENTRY`, 2000 per minute for each route). Before, it used the 120 per minute anonymous bucket. The service keeps its per-(IP, email) limit of 5 per hour. It adds a per-IP send cap of 200 per hour (Redis key `aiq:rl:cand-login:ip:<ip>`). Both limits fail closed. The response is always 204, so a caller cannot tell a limit from a missing account.
- **Why.** A college lab sits behind one public IP. Many students ask for a sign-in link at the same time. The 120 per minute bucket blocked the lab. The 200 per hour cap still limits an attacker who wants to send mail to many addresses from one IP.
- **Tests.** `01-auth` `rate-limit-campus` case (f): 50 requests from one IP return no 429. A `candidate-login` test covers the per-IP cap.
- **Already in place (Rule B check).** `POST /api/take/start` has a per-token limit of 30 per minute and the candidate-entry bucket. `verify-link` uses the candidate-entry bucket. Candidate sessions have 3000 per minute for each IP.
- **Per-organisation throttle.** The helper `tenantRateLimit({ name, max, windowSeconds })` (`apps/api/src/middleware/tenant-rate-limit.ts`) limits one heavy admin action for each organisation in a fixed window. Key: `aiq:rl:tenant-op:<name>:<tenantId>`. An excess call returns 429 `RATE_LIMITED` with `details.scope = "tenant-op"` and the header `Retry-After`. It guards the audit export and archive routes and the bulk invitation resend. Routes and limits: [03-api-contract.md](03-api-contract.md) § "S14 additions (2026-10-16)".
- **Considered and rejected.** A higher anonymous bucket (it weakens every public route). A per-email cap only (an attacker uses many addresses).
- **Not included.** A change to the admin credential limits. A per-user cap for admin export.
- **Downstream impact.** The per-IP cap is a send cap. A lab of more than 200 students who all ask for a new link in one hour needs a second wave or the invitation link route.

### Client IP trust and production boot rule

*History: 2026-10-02, batch 4.*

- **What.** `extractClientIp` (01-auth) takes `CF-Connecting-IP` only through `validCfIp`: it must be a syntactically valid IP literal (`net.isIP`). The function ignores junk, comma lists and oversized strings. It honours the header only when the request is origin-verified (`ORIGIN_TRUST_MODE` enforce or log with a matching `x-origin-verify`). The remaining raw `req.ip` and cf-header reads (06 take and consent, 18 `/verify`) now go through `extractClientIp`. `isRateLimited(key, max)` is a read-only peek that failure-only throttles use.
- **Boot rule.** `modules/00-core/src/config.ts` refuses to start when `NODE_ENV=production` and `ORIGIN_TRUST_MODE !== 'enforce'` (message: requires enforce with `ORIGIN_VERIFY_SECRET`). Production has run enforce since 2026-05-19. The team checked the api and the worker live after the deploy.
- **Why.** The client IP keys rate limits, session binding and audit. An origin-bypasser in off or log mode could inject any header value, mint unlimited buckets or spoof an IP. A mandatory enforce mode removes this foot-gun (codex revise).
- **Considered and rejected.** Trusting `X-Forwarded-For` (an attacker can spoof it); validating only in the rate limiter (other callers stay exposed).
- **Not included.** No Cloudflare IP-range allowlist. Origin verification remains the trust anchor.
- **Impact.** Local dev and CI keep `off`/`log` (non-production). Any new production deployment must set `ORIGIN_TRUST_MODE=enforce` and `ORIGIN_VERIFY_SECRET`. Otherwise the API and the worker do not boot.

### Auth-bypass route inventory

This is the canonical trust-boundary table. It lists every route that runs without a `requireAuth` session gate, with the alternative trust model that makes the route safe. Security reviews start here.

(`apps/api/src/server.ts` — see the registration order for context)

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

> Routes that use `publicChain: authChain({ requireSession: false })` (for example `/take/*`) still pass through the session-loader hook. The hook loads a valid session if one is present, but a missing session is not an error. These routes are auth-**optional**, not auth-bypassed.

> Routes in `/api/auth/*` are auth-**establishing**: they CREATE or complete sessions. The table lists them because they accept unauthenticated callers, not because they skip authorization logic.

### Origin-verify header (anti-IP-spoof)

#### Threat

The production topology is `Cloudflare (DNS-proxy) → shared Caddy → assessiq-api (Fastify)`. The origin IP `:443` is directly reachable. An attacker can bypass Cloudflare and set arbitrary `cf-connecting-ip` headers, which spoofs any client IP. This defeats all per-IP rate limits (§ Rate limit tiers) and any IP-bound session tokens (magic-link, email-OTP continuation).

#### Mechanism

Cloudflare injects a shared secret as the `x-origin-verify` request header through a **Cloudflare Transform Rule** (the operator applies it out of band; see TODO below). The API extracts the client IP through `extractClientIp(req)` (implemented in `modules/01-auth/src/client-ip.ts`), which validates this header before it trusts `cf-connecting-ip`.

Config vars (`modules/00-core/src/config.ts`, `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `ORIGIN_VERIFY_SECRET` | _(unset)_ | Shared secret that Cloudflare injects as `x-origin-verify`. Unset = dev, test and CI boot safely. **When set, it must be ≥16 chars** (Zod `.min(16)`). An empty or short secret would make the constant-time compare trivially satisfiable. |
| `ORIGIN_TRUST_MODE` | `off` | Controls enforcement level (see modes below). |

**Boot guard (config `superRefine`):** `ORIGIN_TRUST_MODE=enforce` with a missing or short `ORIGIN_VERIFY_SECRET` **refuses to load config**. The process exits at startup. Without this guard, the process would boot into a state where `isOriginVerified()` returns `false` for every request. That state would make the rate-limit fail-closed path throw on *every* request, which is a silent site-wide outage. A failed config load means the new container never becomes healthy and the old one keeps serving. The failure is loud and recoverable. `off` and `log` with no secret boot fine.

#### Three modes

| Mode | Behaviour | Use when |
|---|---|---|
| `off` | Returns `cf-connecting-ip ?? req.ip` — **byte-identical to the old inline expression.** Zero behaviour change. | Default; safe to deploy before the Transform Rule is live. |
| `log` | Same return value as `off`. Emits one structured `warn` (`event: 'origin-unverified'`) when `x-origin-verify` is absent or mismatched. **Never changes the returned IP.** | The Transform Rule is deployed; confirm that logs show verified requests before you enforce. |
| `enforce` | Verified (`x-origin-verify` matches): trust `cf-connecting-ip`. **Unverified** behaviour differs by consumer. The **rate-limit middleware** (`extractRateLimitClientIp`) returns `null`, which flows into the *existing* production fail-closed `throw RateLimitError`. The request is **rejected**, and the middleware buckets it neither by a spoofed cf-ip nor by the constant shared-Caddy socket IP. The **generic `extractClientIp`** (12 audit, log and login-binding sites) returns `req.socket.remoteAddress ?? req.ip` and never honours `cf-connecting-ip` or `x-forwarded-for`. | The Transform Rule is confirmed in logs, and the secret is set. |

Secret comparison: the code hashes both sides to fixed-length 32-byte **SHA-256 digests** and then compares them with `crypto.timingSafeEqual`. There is no length-mismatch branch, so the comparison time is independent of the attacker input and of the secret length. There is zero length-oracle surface (the code never uses `===`).

The function never throws. A try/catch wraps the entire body and returns `req.ip ?? '0.0.0.0'` on any unexpected error, so a crypto exception cannot crash every request.

#### Rollout order — **all 4 steps DONE (2026-05-19/20)**

1. ✅ **Deployed `off`** (`3b2fe73`, 2026-05-19) — no behaviour change.
2. ✅ **Added the Cloudflare Transform Rule `assessiq-origin-verify`** (Hostname == assessiq.automateedge.cloud → set request header `x-origin-verify: <64-hex secret>`). The matching secret is in `/srv/assessiq/.env` (NOT `.env.local`, which is inert).
3. ✅ **Flipped to `log`** — the soak confirmed that real CF traffic carries the verified header. The only "unverified" log was the benign loopback `/api/health` heartbeat (not rate-limited, no enforce impact). 0 false positives on real traffic.
4. ✅ **Flipped to `enforce`** — a spoofed-IP probe on a rate-limited route now returns **429** (it returned 200 before). Legitimate CF traffic returns 200. Health returns 200. A crontab scan confirmed no internal HTTP callers to rate-limited routes.

**Rollback (operational, in case an internal job ever gets a 429):** edit `ORIGIN_TRUST_MODE=enforce`→`log` in `/srv/assessiq/.env` and redeploy api and worker. `.env.bak.<TS>` backups exist on the VPS.

See **Network-layer origin lockdown (AOP)** below. It is the second, stronger layer, added 2026-05-20, that closes the residual at the TLS handshake itself.

#### Adjudicated adversarial residuals (Sonnet review + Opus adjudication)

The 01-auth gate (`feedback-adversarial-reviewer-routing`) ran a Sonnet adversarial pass (verdict REVISE, 7 findings), and Opus adjudicated it. The team fixed these findings with tests: F1 boot guard (CRITICAL), F5 SHA-256 compare, F6 secret min-16, F7 extractor rename. The remaining **accepted residuals** are:

- ~~**F4 — unverified login IP-binding (tracked, NOT a regression).**~~ **CLOSED 2026-05-20.** The network-layer AOP lockdown (see below) rejects direct-to-origin TLS handshakes entirely. So an "unverified request" can no longer reach the application at all. The preconditions of the degenerate-binding scenario are gone. Verified (real-Cloudflare) sessions remain strictly stronger than the baseline before 2026-05-19.
- **F3 — `_log.ts checkIpRateLimit` shares one bucket for unverified traffic.** *By design.* Verified traffic uses its real cf-ip (independent buckets, unaffected). Unverified traffic shares one throttled bucket. This is the intended conservative posture for traffic that did not provably pass through Cloudflare.
- **F2 — `mint-session.ts` sentinel `'0.0.0.0'` vs old `'127.0.0.1'`.** This is the one site where `off` mode is not byte-identical. It is dev-only (`NODE_ENV`-gated), and the sentinel is unreachable in practice (`req.ip` is always populated under Fastify). An inline comment marks the site. It is audit-cosmetic only.

#### Network-layer origin lockdown (Cloudflare Authenticated Origin Pulls) — **LIVE 2026-05-20**

The shared-secret app layer above is one half of the defense. The **complete** fix is at the TLS layer: make the origin refuse any TLS handshake that does not present the client certificate of Cloudflare. With AOP enforcing, a direct-to-origin attacker cannot even open an HTTPS connection. The origin rejects the attacker before any HTTP header (spoofed or not) reaches the application.

**Architecture.** `Cloudflare (AOP-enabled) → ti-platform Caddy (require_and_verify) → assessiq-api`. Cloudflare presents its zone-level Origin Pull client cert on every outbound connection to the origin. The per-site `client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/ssl/cf-origin-pull-ca.pem }` of Caddy rejects everything else at the TLS handshake.

**Neighbor-safe by design.** Of the 5 Caddy site blocks on the shared box (`intelwatch.in`, `ti.intelwatch.in`, `automateedge.cloud`, `accessbridge.space`, `assessiq.automateedge.cloud`), **only** the AssessIQ block carries `client_auth`. The neighbors keep standard TLS. Verified after the flip: all 5 neighbor hostnames still serve HTTP 200.

**CA cert identity.** `/etc/caddy/ssl/cf-origin-pull-ca.pem` is the canonical Cloudflare zone-level Origin Pull CA: `CN = origin-pull.cloudflare.net, O = "CloudFlare, Inc.", OU = Origin Pull`, SHA-256 `9A:1A:C2:B4:BE:15:F9:F2:7E:EE:20:A7:34:CB:A4:E9:89:8F:61:00:1B:3B:D7:C8:4B:69:B5:6A:3E:25:A2:B9`. It is valid through Nov 2029.

**Rollout: canary flip with auto-revert.**

- The team staged Phase 1 (`mode request`, which asks for a cert but does not reject, so it is a no-op) on 2026-05-20 at 05:32 UTC.
- The team flipped Phase 2 (`mode require_and_verify`) with a single sed truncate-write (per the `cat >` bind-mount-inode rule from RCA 2026-04-30, *never* `mv`). Then the team ran `caddy validate` and `caddy reload`, and then a 4-probe acceptance gate:

| Probe | Expected | Result |
|---|---|---|
| `https://assessiq.automateedge.cloud/api/health` via Cloudflare | 200 | **200** ✓ |
| Direct-to-origin spoof (`curl --resolve` to origin IP + spoofed CF-Connecting-IP) | TLS rejected (curl HTTP `000`) | **000** ✓ vuln closed |
| `https://accessbridge.space` (neighbor) | 200 | **200** ✓ |
| `https://automateedge.cloud` (neighbor apex) | 200 | **200** ✓ |

The canary script (see `docs/06-deployment.md § Authenticated Origin Pulls (AOP)`) reverts automatically from the UTC-stamped backup if the CF probe fails. This keeps the exposure under ~30 s if the team ever needs to undo the flip.

**Rollback.** `cat /opt/ti-platform/caddy/Caddyfile.bak.<latest> > /opt/ti-platform/caddy/Caddyfile && docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. Use truncate-write only (never `mv` or `cp` over the live Caddyfile).

#### What is NOT included

- **`trustProxy: false`** — the Fastify `trustProxy: true` flag (`server.ts:44`) is intentionally untouched. With AOP enforcing, Fastify sees only TLS connections from CF (through Caddy), so XFF that comes through that path is trustworthy by construction. Still, a separate audit of the `trustProxy` semantics is a low-priority hygiene follow-up.
- **Automatic secret rotation** for `x-origin-verify` — this is the responsibility of the operator (Transform Rule + `.env`). It is now defense in depth (the network-layer AOP is the primary defense), so the rotation cadence is no longer the only thing that holds back an attacker.
- **`trusted_ca_cert_file` → `trust_pool` migration** — a Caddy v2.11 deprecation warning, cosmetic. The team tracks it as low-priority Caddyfile hygiene.
- **Caddyfile formatting** — `caddy fmt --overwrite` would clean the line-38 inconsistencies. The team did not apply it this round, to keep the diff minimal and the inline RCA comments intact.

#### Downstream impact

- `modules/00-core/src/config.ts`: two new env vars (`ORIGIN_VERIFY_SECRET`, `ORIGIN_TRUST_MODE`).
- `modules/01-auth/src/client-ip.ts`: new module; exports `extractClientIp(req): string`.
- `modules/01-auth/src/middleware/index.ts`: re-exports `extractClientIp` from `client-ip.ts` (it replaces the rate-limit-internal one in the public barrel).
- `modules/01-auth/src/index.ts`: `extractClientIp` now resolves to `client-ip.ts` via the middleware barrel.
- `apps/api/src/server.ts:77,146`: inline expressions replaced.
- `apps/api/src/routes/_log.ts:87`: inline expression replaced (this also fixes the `_log` in-memory rate limiter, which had the same spoofable-CF-header issue).
- `apps/api/src/routes/auth/candidate.ts:66,133`, `embed.ts:80,196`, `google.ts:105,167,217,279,319`, `dev/mint-session.ts:194`: all 13 call sites replaced.
- `.env.example`: two new vars with rollout comments.

> **TODO (operator, out of band):** Apply the Cloudflare Transform Rule to inject `x-origin-verify: <secret>` on every request to the zone. This is a Cloudflare dashboard action. No code in this repo applies it. Until you apply it, `ORIGIN_TRUST_MODE=off` is the correct setting.

### Question review authorization (EXP-18 part 2, 2026-10-18)

- **What.** Three new admin routes (`GET /api/admin/packs/:id/review`, `POST /api/admin/questions/:id/review`, `POST /api/admin/packs/:id/review/verify-all`) decide which questions candidates may receive. They use the `adminOnly` chain. The role gate is also in the handler (`assertReviewRole`) and in the service (`service/review.ts`).
- **Rules.** Role `admin` or `super_admin`. The question set must belong to the session tenant (`question_packs.tenant_id`, checked in the service on top of RLS). A platform question set (tenant slug `platform`) needs `super_admin`. An organisation question set needs `admin`; a `super_admin` session on an organisation tenant gets `403`. A candidate role gets `403` before any lookup.
- **Why twice.** Middleware alone fails open if a route is registered on the wrong chain. RLS alone hides a row but does not say why. The service check keeps the rule when the function is called from a job or a test.
- **No new MFA rule.** These actions do not need fresh MFA: they change a review flag and are fully audited (`question.review_changed`). Withdraw by an organisation admin affects only that organisation.
- **Considered and rejected.** A new `reviewer` role (decommissioned, RV60). Letting a `super_admin` review any organisation's questions (cross-tenant power stays in the platform routes).
- **Not included.** Two-person review.

## Self-serve organisation sign-up (Z-71, Z-81, 2026-10-20)

*Type: explanation.* Code: `modules/01-auth/src/signup.ts`, `signup-otp.ts`, `signup-legal.ts`, `signup-blocklist.ts`; `modules/02-tenancy/src/self-serve.ts`; routes `apps/api/src/routes/public-signup.ts`. Design and review result: `docs/design/2026-10-18-self-serve-signup-design.md` (the section "S31 review result and corrections" is binding). API: `docs/03-api-contract.md` § "Public self-serve sign-up". Tables: `docs/02-data-model.md` § "Self-serve sign-up tables".

**What it does.** A visitor passes a Cloudflare Turnstile check and gets a 6-digit code by email. A correct code creates ONE organisation on the Free plan, its first admin, the DPA and terms acceptance record, and starts that admin's session.

### Flow

1. `GET /api/public/signup/config` tells the page if sign-up is open, the Turnstile site key and the DPA version.
2. `POST /api/public/signup/request` runs these checks in order and stops at the first failure: preconditions (404), body validation (400), Turnstile (403), IP limit (429 `signup_ip`), address limit (429 `signup_email`), super-admin address and block list (neutral 200, nothing sent), daily cap of completed sign-ups (neutral 200, nothing sent), then ONE of two mails: the sign-up code (new address) or "you already have an account, sign in" (address that has a user in any tenant, or a claim). The answer is always `200 { ok: true }` and takes at least 800 ms, so it never shows which mail was sent.
3. `POST /api/public/signup/verify` takes the code with one Lua script (compare and delete in one call), then runs `createSelfServeTenant`, then mints a NEW session for the new admin. Every failure (wrong, expired or burnt code, claim conflict, daily cap, malformed body) is the same `400 SIGNUP_INVALID` after the same 800 ms floor.

### Preconditions (checked on every request, fail closed)

`PLAN_TIERS_ENFORCED=true`, `SIGNUP_ENABLED=true`, `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` set, Redis answers `PING`. If one is missing, `request` and `verify` answer `404 NOT_FOUND` and `config` answers `open: false`.

### Why the routes are public and still safe

- They need no session and no tenant context, because the tenant does not exist yet. No tenant data is read or written until `createSelfServeTenant` creates the tenant, and that function runs under `withSystemRole("self-serve sign-up")` in one transaction.
- Every input is validated (zod in `_schemas.ts`, `.strict()`): organisation name 3-80 characters (letters, digits, space, `. - & '`), admin name 2-80, address up to 254 characters, `dpaAccepted` literally `true`, `dpaVersion` equal to `DPA_VERSION`.
- Control of the address is proved BEFORE the tenant exists (emailed code).
- Abuse is bounded by Turnstile (single use, bound to the action `signup-request` and to the site hostname), the IP and address limits, the daily cap and `signup_claims` (a database primary key: one organisation for each folded address).
- The first user has role `admin` only. No code path in sign-up sets `super_admin`. A super-admin address (or an alias that folds to it) is refused at request time and again inside the transaction.
- An address that already has a user in any tenant gets no organisation (checked inside the transaction, so a race cannot take over a tenant). It gets the "you already have an account" mail and nothing else.

### Key spaces (Redis)

| Key | Purpose | Notes |
| --- | --- | --- |
| `aiq:signup:otp:signup:<hmac(email)>` | the sign-up code record (hash) | Separate from the admin sign-in code `aiq:email-otp:<sha256(email)>`. The value is `HMAC-SHA256(server key, "signup" + email + code)`. The hash also holds the organisation name, admin name, DPA and terms versions, IP and user agent of the request. TTL 10 minutes, 5 wrong tries burn it. |
| `aiq:signup:ts:<sha256(token)>` | Turnstile single use | `SET NX EX 300` after a good siteverify. |
| `aiq:rl:signup:ip:<ip>` | scope `signup_ip` | 5 a day. The IP comes from `extractRateLimitClientIp`; if it is null the request is refused. |
| `aiq:rl:signup:email:<hmac(folded email)>` | scope `signup_email` | 3 a day. Counts requests (both mails). Plus-tags and Gmail dots share the bucket. |
| `aiq:rl:signup:day:<UTC date>` | scope `signup_global` | 50 completed sign-ups a day. Read at request and at verify, incremented after a sign-up completes. |
| `aiq:signup:rej:<UTC date>:<hmac>` | audit once a day | Makes `signup.rejected` one row for each address each day. |

The server key is `HMAC(SESSION_SECRET, "aiq:signup:hmac-key:v1")`. A purpose label is part of every HMAC, so an IP hash cannot equal an address hash.

### Session

`verifySignup` calls `sessions.create` for a new session id (the route first destroys any session the browser already holds). Role `admin`, `totpVerified = !MFA_REQUIRED` (same rule as `google-sso.ts` for a tenant admin), cookie flags as the sign-in routes (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, 8 hours). Redirect is `/admin`, or `/admin/mfa` when `MFA_REQUIRED=true` (same as Google sign-in).

### Audit

`tenant.provisioned` and `signup.completed` are written in the create transaction (system actor, no plain address, `ip` and `user_agent` NULL). `signup.rejected` is written only for later rejects (block list, super-admin address, daily cap, claim conflict), once for each address HMAC each day, under the platform tenant. A request that fails Turnstile or a rate limit writes NO audit row (an anonymous caller must not add permanent rows to an append-only table).

### Residual risks (accepted, stated)

- Many real mail boxes at other hosts are not folded. Turnstile, the IP limit and the daily cap bound them.
- A farm that solves Turnstile can fill the daily cap and delay real sign-ups. The cap limits damage; it does not block. A caller can also use up the 3 requests a day of a victim's address (a one-day delay).
- The daily cap is read, then incremented after the sign-up. A burst at the cap can overshoot by a few.
- The code is consumed before the tenant is created. If the create step fails (for example the database is down), the code is lost and the visitor requests a new one (3 a day). The failure is logged and the answer is the neutral `SIGNUP_INVALID`. If the tenant committed but the session could not be created, the answer is `200` with redirect `/admin/login` and no cookie.
- The taxonomy seed (`seedTenantTaxonomy`) opens its own transaction, so it runs right after commit with the tenant already `active`. If it fails, the tenant exists without domains. The log line is `signup.after_commit_failed`; the seed is idempotent and can run again by hand.
- The Redis record holds the organisation name, admin name and the request IP and user agent for up to 10 minutes.
- Sign-up mails use `redactLogBody`, so `email_log.body_text` and `body_html` are NULL. The address stays in `email_log.to_address`, and the send job in Redis holds the body until BullMQ removes the job. The 30-day purge of platform-tenant `email_log` rows is NOT built (no retention hook exists for the platform tenant). Open follow-up.
- The admin sign-in code verify (`email-otp.ts`) is still not atomic. Separate row FU-OTP-ATOMIC.
- The per-address bucket (3 a day) can be used up by a stranger, which locks the real owner out for a day (accepted).
- A spoofed request for the same address replaces the pending code and record (accepted; the real owner requests again).
- The daily cap is read at request and incremented at completion, so it can overshoot by the number of outstanding codes (accepted).
- Verify writes no audit row for a full day (it runs before the code check). The request path audits `daily_cap` once for each address each day.
- `tenant_legal_acceptances` rows are removed by the tenant purge (system role). The archive row of design finding 9 is not built; the retention period is an open question for the lawyer.

### Considered and rejected

- Reusing the admin sign-in code key space with a flag: a purpose prefix and an own Lua script are simpler to prove.
- A Redis-only "one organisation for each address" check: Redis can lose data and two parallel calls can pass. A database primary key is the only safe guard.
- Forcing a work email address: dropped by the owner.
- An audit row for every request: rejected (storage DoS on an append-only table).
- Binding the code to the folded key: the code is bound to the exact address that received it, so a code sent to `a+1@x` cannot create an admin `a+2@x`. The folded key is used only for `signup_claims` and the address limit.

### Not included

The sign-up page (web or marketing), the help ids for it, certificate text "Issued by ..., a self-registered AssessIQ customer" (only the flag `tenants.self_registered` is set), the new DPA re-acceptance gate, flipping `PLAN_TIERS_ENFORCED` (Z-18) and `SIGNUP_ENABLED` (owner date), and the 30-day `email_log` purge.

## Decisions and history

This section holds the decisions that shaped the flows above. Each row names the date, the decision and the section that explains it.

| Date | Decision | Where explained |
| --- | --- | --- |
| 2026-05-17 | Pre-TOTP super_admin may reach the TOTP routes only (lockout fix) | First-login MFA bootstrap |
| 2026-05-19 | Login resolves by Google-verified email; no tenant field (P1) | Tenant-less login and cross-tenant identity resolution |
| 2026-05-19 | Email one-time code for admin only (P2) | Email one-time code for admin |
| 2026-05-19 and 2026-05-20 | Origin-verify header and Authenticated Origin Pulls | Origin-verify header |
| 2026-05-20 | Tenant and user state machines | Tenant and user life cycle |
| 2026-05-24 | Editing an admin email transfers account ownership | Super-admin "Edit admin" |
| 2026-05-30 | `totpVerified` means all required factors are met (RCA 2026-05-30) | `totpVerified` at mint |
| 2026-10-02 | Client IP trust and production boot rule | Client IP trust and production boot rule |
| 2026-10-03 | Reviewer role removed (RV60) | Reviewer role removed |
| 2026-10-03 | Embed JIT user rules (FR4) | Embed JIT user rules |
| 2026-10-03 | Shared AES-256-GCM envelope (N24) | Shared AES-256-GCM envelope and fixed-window rate-limit script (N24) |
| 2026-10-15 | Tenant purge (RW-48b) and self-service MFA (RW-45) | Tenant purge, Self-service MFA |
| 2026-10-20 | Self-serve organisation sign-up (Z-71, Z-81) | Self-serve organisation sign-up |

### Reviewer role removed (RV60)

*History: 2026-10-03.*

**What changed.** The tenant `reviewer` role no longer has any access path. Commits `4cd6c8d`, `4374344`, `7ca7cfb`, `a50d573` (review item RV60, owner decision 2026-10-02).
- Invites, `createUser`/`updateUser` and the super-admin edit-admin reject `role: 'reviewer'` with `400 INVALID_ROLE`. The invite route enum is `admin | candidate`.
- Email-OTP eligibility (`filterEligible`) is `admin` only. `super_admin` stays blocked.
- TOTP routes accept roles `admin` and `super_admin`.
- Rate-limit admin tier = `admin` + `super_admin`. A legacy reviewer row falls to the user tier and gets `403` on every admin route. It does not crash.
- The options `anyRoleAuth` (notifications) and `adminOrReviewer` (analytics results CSV) are removed. Those routes accept only admin.

**Why.** Owner decision RO7: keep the product simple. Before this change, a reviewer could not open any admin page, because every admin route asked for `role='admin'`. Production had 0 reviewers.

**Considered and rejected.** Removing the value from the DB CHECK constraints and the TypeScript unions (Rule A: legacy rows must stay readable). A data migration that converts reviewers to admins (no such rows exist). A new read-only role (nobody requested it).

**Not included.** No data migration. The value `reviewer` stays in the DB CHECK, the TS unions and the `reviewer_count` API field. (Update 2026-10-16: see "State after 0179" below.) The team did not revoke pending reviewer invitations (none exist). The old last-admin guard on demotion is gone with the demotion path. It must return with any future demotion path.

**Impact.** The change affects 03-users, 13-notifications, 15-analytics, 10-admin-dashboard and 01-auth (see each SKILL.md). Help: 7 keys rewritten (migration 0154). Adversarial review (Sonnet takeover): accept, 5 LOW. The open LOW items are in roadmap row N26.

**State after 0179-0181 (2026-10-16, row Y-1).**
- Migrations `0179_drop_reviewer_from_checks.sql` (03-users, `users_role_check`), `0180_sessions_role_check_no_reviewer.sql` (01-auth, `sessions_role_check`) and `0181_in_app_notifications_role_check_no_reviewer.sql` (13-notifications, `in_app_notifications_role_check`) remove `reviewer` from `users_role_check`, `sessions_role_check` and `in_app_notifications_role_check`.
- Production had 0 rows with `role='reviewer'` in those three tables on 2026-10-16. Each migration counts the rows first and refuses to run if any exist.
- The TypeScript unions were already cleaned in commit `23c77e2`.
- `help_content.audience` keeps the value `reviewer` on purpose (owner decision RW-2).
- The text above is history. It describes the state on 2026-10-03.

## Device and readiness gate at test start (Z-87, Z-91, S36 2026-10-20)

*Type: explanation.* This section describes who may start a REAL exam and from which device. The change record is `docs/archive/2026-10-20-wave1-batches-abcd-change-record.md`.

- **Two start routes, one gate.** `POST /take/start` (invitation link) and `POST /api/me/assessments/:id/start` (signed-in candidate, including a retake from the result page) both pass `gate` to `startAttempt`. `startAttempt` enforces the gate for a NEW attempt of a REAL exam. A resume of an unfinished attempt needs no readiness check.
- **Device rule.** A phone or tablet is refused with 403 `DEVICE_NOT_ALLOWED` and the message "Please open this link on a laptop or desktop computer to take this test". The decision uses the `Sec-CH-UA-Mobile` header, the user agent, and the client-reported touch and screen signals (`device.ts`). The invitation stays valid and unused.
- **Readiness rule.** A real exam needs a passing readiness check: screen at least 1024 by 600, a recent Chrome, Edge, Firefox or Safari, and a network speed when reported (`readiness.ts`). A missing or failing check gives 422 `READINESS_FAILED`. The server evaluates the raw signals and stores the result on `attempts.readiness`.
- **Mode source.** `delivery_mode` ('real' or 'mock') is set by the admin on the invitation and copied to the attempt under the invitation row lock. A candidate request cannot set it. A mock test is never blocked and the public `/try` demo is never blocked.
- **Accepted gaps.** Embed starts skip the gate (the host app asserts the candidate; row Z-98). Client-reported signals can be faked; the header and the user agent are the independent part. Camera checks are Wave 2.
- **Public sign-up** (no session before the tenant exists) is described in the section "Self-serve sign-up" of this file.

## Real-exam camera: consent step and file access (Batch A part 2, 2026-10-20)

*Type: explanation.* Code: `routes.take.ts`, `service.ts` (`startAttempt`), `routes.camera.*.ts`. Routes and shapes: `docs/03-api-contract.md` section "Real-exam camera routes".

- **When the rule applies.** Only a NEW attempt of a REAL exam, started through `POST /take/start` or `POST /api/me/assessments/:id/start`, with `CAMERA_ENFORCED=true`, outside embed. Mock tests, embed attempts, resumes and a school with the camera off are never asked. With `CAMERA_ENFORCED=false` nothing changes.
- **Consent step.** The page shows the camera notice, then calls `POST /take/camera-consent` with the notice version it showed. The server stores the decision with a hashed IP and the device type. The start gate then needs the latest decision to be `agreed` with the current version. The consent is linked to the attempt in the same transaction that creates it. Uploads later check that link.
- **Organisation set-up.** If the organisation has not confirmed the notice, the start answers 422 `CAMERA_SETUP_REQUIRED`: "The test organiser has not finished the camera set-up. Contact your test organiser."
- **Who can see files.** Only the platform super admin and tenant admins named in `camera_reviewers`. A plain tenant admin gets 403. The tenant admin names and removes reviewers. Every view writes `camera.file.viewed` (file id and viewer, no image data) before the bytes leave the server. Files are never served from a public URL. Reviewer, review and appeal actions are audited.
- **School flag.** Only the super admin can mark an organisation as a school (`POST /api/admin/platform/tenants/:tenantId/school`, fresh MFA). A school admin then controls camera and photos for its own tests.
- **Why a gate in the service.** One check covers both start routes, including retakes. A route-only check would leave one path open.
- **Not included.** AI on images, face matching, camera on embed attempts (accepted gap), screens for candidate and staff (UI work), automatic grading effects of a flag. A flag is evidence for a human reviewer only.
