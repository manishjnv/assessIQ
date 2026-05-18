# Design — Login identity simplification + email-OTP (A1)

**Status:** APPROVED (brainstorming, 2026-05-19). Load-bearing (`modules/01-auth`).
Phased build P1 → P2; each phase own commit/deploy + **mandatory Sonnet+Opus
adversarial gate before push** (01-auth hard rule).

## Problem
Login requires the user to type their tenant slug. The same email is a
*separate identity per tenant* (`users` is `UNIQUE(tenant_id, email)`), so one
person (e.g. `manishjnvk@gmail.com` = `super_admin`@platform + `admin`@wipro-soc
+ `admin`@e2e-walkthrough) must know and type the right slug. Friction + leaks
the tenant model to users.

## Locked decisions (from brainstorming)
- **Architecture A1:** verify email first, then a bounded cross-tenant identity
  lookup, then 0/1/many handling with a post-auth picker. No session/JWT/RLS/
  data-model change; `UNIQUE(tenant_id,email)` kept; A3 (global accounts)
  explicitly deferred.
- **Auth matrix:** `super_admin` = Google SSO + mandatory authenticator MFA
  ONLY (no email-OTP; existing isolated 4-gate platform path unchanged).
  `admin`/`reviewer` = Google SSO **OR** email-OTP. `candidate` = existing
  magic-link, **untouched**.
- `super_admin` identities appear in the picker but selecting one routes
  through the existing isolated always-MFA gates verbatim.
- Email-OTP is a **6-digit numeric code** (not a clickable link), single-use,
  10-min expiry, entered on a verify screen.

## Components
### `resolveIdentities(verifiedEmail) → Identity[]`
One job: given a **cryptographically-verified, owned** email, return all
`users` rows with `lower(email)=lower(verifiedEmail)` AND `status='active'`
AND not soft-deleted, across all tenants, as
`{ userId, tenantId, tenantSlug, tenantName, role }`.
Hard constraints (load-bearing):
- Callable **only after** email ownership is proven (Google id_token verified,
  or email code consumed). Never reachable by an unauthenticated request.
- Runs under the system/BYPASSRLS role inside a bounded transaction — the
  same pattern as the existing `/api/admin/super/*` cross-tenant reads.
- Output is used solely to mint a session for a *picked* identity.

### Login page (`apps/web/src/pages/admin/login.tsx`)
No tenant field. Two actions: "Continue with Google" and "Email me a sign-in
code". Single column, plain.

## Flows
### Google SSO (P1)
`/api/auth/google/start` no longer needs/embeds a tenant. Callback verifies
id_token → `resolveIdentities(email)` → branch. `super_admin` rows included.

### Email-OTP — admin/reviewer only (P2)
Email entered → **constant-time, identical response** ("If that email can
sign in, we've sent a code") regardless of existence (anti-enumeration),
reusing candidate-login rate-limit + Redis-fail-closed + 200ms-floor infra.
A code is sent **only if** `resolveIdentities(email)` has ≥1 `admin`/`reviewer`
identity. 6-digit, single-use, 10-min, entered on a verify screen. On verify →
email treated as verified → branch, with `candidate`-only and `super_admin`
identities filtered OUT of this path (a super-admin-only email gets the generic
"use Google sign-in" message; never a code).

### Branch on resolved identities (both paths)
- **0 eligible** → terminal "This email isn't registered for access — contact
  your administrator." No enumeration.
- **1** → mint session immediately → dashboard.
- **≥2** → identity picker ("Role @ Organisation" rows; the authenticated
  owner seeing their own memberships is acceptable). On pick → mint session
  for that exact `(tenantId, userId, role)` via the **existing mint path
  unchanged**.
- Picked **`super_admin`** → existing isolated platform-scoped 4-gate,
  always-MFA flow **verbatim** (email-OTP can never reach it).

## Security invariants (gate the build)
1. Cross-tenant resolve: post-verification + system-role + bounded +
   unauthenticated-unreachable.
2. Email-OTP request: constant-time, identical response, rate-limited,
   Redis-fail-closed (reuse candidate-login machinery).
3. Email-OTP code: single-use, 10-min expiry, brute-force-limited,
   replay-safe, bound to the email.
4. Session mint / RLS / tenant-context middleware / super_admin path:
   **unchanged** — tenant is still per-identity, sourced from a verified pick
   instead of a typed slug.
5. Email-OTP strength = parity with "Google-SSO-alone" for admin/reviewer
   (same post-auth MFA gate as Google for that role; MFA_REQUIRED=false today
   ⇒ single-factor parity, not weaker).
6. Candidate flow physically unchanged (separate page/route/mechanism).

## Phasing
- **P1:** `resolveIdentities` + Google-SSO-no-tenant + picker + 0/1/many +
  login page (drop tenant field, Google only). Biggest daily-friction win.
- **P2:** email-OTP for admin/reviewer (reuses P1 resolver + candidate-login
  security infra) + the code request/verify screens.
Each phase: own commit → deploy → **Sonnet+Opus adversarial gate before push**.

## Testing
Resolver units: 0/1/many; case-insensitive; status/soft-delete filters;
super-only & candidate-only filtered out of the OTP path. Anti-enumeration
timing test. Picker→mint integration. Adversarial vectors per push:
cross-tenant leakage, email enumeration, super_admin isolation, session
fixation, code brute-force/expiry/replay, picker tampering (pick an identity
the verified email does not own).

## Explicitly NOT included
Global/merged accounts (A3); SSO providers beyond Google; SMS/WhatsApp OTP;
any change to candidate auth; "remember this org"; org-switch without re-auth.
