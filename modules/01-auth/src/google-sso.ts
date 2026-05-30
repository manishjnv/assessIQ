// modules/01-auth/src/google-sso.ts
//
// Google OIDC start + callback. RS256 id_token verify via JWKS; state + nonce
// CSRF protection; cross-tenant identity resolution after verification.
//
// P1 changes (login-identity-simplification):
//   - startGoogleSso: tenantId removed from opts + state. State is now
//     <random>[|<returnTo>] only.
//   - handleGoogleCallback: after CSRF/code-exchange/JWKS/nonce (steps 1-4,
//     UNCHANGED), resolves all eligible identities via resolveLoginIdentities
//     (login-continuation.ts). 0 → reject; 1 → mintForIdentity (single);
//     ≥2 → issue continuation token, return {kind:'select',...}.
//   - mintForIdentity: extracted from the pre-P1 callback. Behaviour is
//     byte-identical for any single identity (pure extract — no logic change).
//   - OidcCallbackOutput: now a discriminated union (kind:'session' | kind:'select').
//
// Email matching with 03-users requires normalizeEmail() at both sides;
// 03-users users are stored lowercase via the same helper at write time.
//
// Spec sources:
//   - modules/01-auth/SKILL.md § 9, § 10.
//   - docs/04-auth-flows.md Flow 1.
//   - docs/SESSION_STATE.md § 03-users carry-forward (normalizeEmail rule).

import * as jose from "jose";
import { randomBytes } from "node:crypto";
import { config, AuthnError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { sessions } from "./sessions.js";
import { constantTimeEqual } from "./crypto-util.js";
import {
  resolveLoginIdentities,
  storeLoginContinuation,
  type ResolvedIdentity,
} from "./login-continuation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CookieOpts {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

export interface OidcStartOutput {
  redirectUrl: string;
  stateCookie: { name: string; value: string; opts: CookieOpts };
  nonceCookie: { name: string; value: string; opts: CookieOpts };
}

// Discriminated union — P1 adds the 'select' variant.
// The cb route inspects `out.kind` to choose its response path.
export type OidcCallbackOutput =
  | {
      kind: "session";
      sessionToken: string;
      user: {
        id: string;
        email: string;
        tenantId: string;
        role: "admin" | "super_admin" | "reviewer" | "candidate";
      };
      redirectTo: string;
    }
  | {
      kind: "select";
      continuationToken: string;
      redirectTo: "/admin/select-identity";
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_STATE_NAME = "aiq_oauth_state";
const COOKIE_NONCE_NAME = "aiq_oauth_nonce";
export const COOKIE_CONTINUATION_NAME = "aiq_login_cont";
const COOKIE_TTL_SEC = 600; // 10 minutes — Google's auth UI cap
const CONTINUATION_COOKIE_TTL_SEC = 300; // 5 minutes
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER = "https://accounts.google.com";

// ---------------------------------------------------------------------------
// JWKS — module-level singleton; jose auto-rotates in-memory.
// Lazily initialized so unit tests can stub jose before first call.
// ---------------------------------------------------------------------------

let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
  if (_jwks === undefined) {
    _jwks = jose.createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return _jwks;
}

// Escape hatch for tests to reset the JWKS singleton after mocking jose.
export function _resetJwksForTesting(): void {
  _jwks = undefined;
}

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

/**
 * Lowercases + trims an email. No dot-stripping, no plus-stripping — those
 * are valid distinct addresses for some tenants. Both 01-auth (read) and
 * 03-users (write) must call this so the two sides always match.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Cookie factory helper
// ---------------------------------------------------------------------------

function cookieOpts(path = "/"): CookieOpts {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path,
    maxAge: COOKIE_TTL_SEC,
  };
}

export function continuationCookieOpts(path = "/"): CookieOpts {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path,
    maxAge: CONTINUATION_COOKIE_TTL_SEC,
  };
}

// ---------------------------------------------------------------------------
// returnTo whitelist — only /admin/* and /take/* paths are safe destinations.
// ---------------------------------------------------------------------------

function safeReturnTo(returnTo: string | undefined): string {
  if (
    returnTo !== undefined &&
    (returnTo.startsWith("/admin/") || returnTo.startsWith("/take/"))
  ) {
    return returnTo;
  }
  return "/admin";
}

// ---------------------------------------------------------------------------
// startGoogleSso
//
// P1 change: tenantId removed from opts. State is now <random>[|<returnTo>]
// only — the callback resolves identities by email across ALL tenants.
// ---------------------------------------------------------------------------

export async function startGoogleSso(opts: {
  returnTo?: string;
}): Promise<OidcStartOutput> {
  const clientId = config.GOOGLE_CLIENT_ID;
  const redirectUri = config.GOOGLE_OAUTH_REDIRECT;

  if (!clientId || !redirectUri) {
    throw new AuthnError("Google SSO is not configured");
  }

  // State: random 32 bytes base64url. Stored as the cookie value and sent as
  // the Google state= param. On callback, constantTimeEqual verifies them.
  // P1: state no longer embeds tenantId; it is now <random>[|<returnTo>].
  const stateRandom = randomBytes(32).toString("base64url");
  const rt = safeReturnTo(opts.returnTo);

  // Full state encodes: <random>[|<returnTo if non-default>]
  const stateParts: string[] = [stateRandom];
  if (rt !== "/admin") {
    stateParts.push(rt);
  }
  const fullState = stateParts.join("|");

  // Nonce: random 32 bytes base64url. Set as the nonce claim in the auth
  // request; verified via constantTimeEqual against the cookie on callback.
  const nonceValue = randomBytes(32).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: fullState,
    nonce: nonceValue,
    access_type: "online",
  });

  const redirectUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  return {
    redirectUrl,
    stateCookie: {
      name: COOKIE_STATE_NAME,
      value: fullState,
      opts: cookieOpts("/"),
    },
    nonceCookie: {
      name: COOKIE_NONCE_NAME,
      value: nonceValue,
      opts: cookieOpts("/"),
    },
  };
}

// ---------------------------------------------------------------------------
// Token exchange with Google
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const clientId = config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_CLIENT_SECRET;
  const redirectUri = config.GOOGLE_OAUTH_REDIRECT;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new AuthnError("Google SSO is not configured");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new AuthnError(`Google token exchange failed: ${res.status} ${text}`);
  }

  return (await res.json()) as GoogleTokenResponse;
}

// ---------------------------------------------------------------------------
// id_token payload shape we care about
// ---------------------------------------------------------------------------

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DB row type used within mintForIdentity
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: "admin" | "super_admin" | "reviewer" | "candidate";
  status: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// mintForIdentity
//
// Encapsulates the per-identity mint+redirect logic. This is a PURE EXTRACT
// from the pre-P1 handleGoogleCallback — logic is byte-identical for any
// single identity. The only unavoidable difference is:
//   (a) claims is now optional (undefined when called from selectLoginIdentity
//       which has no Google claims object). When undefined, raw_profile
//       email/name/picture are omitted; the INSERT ON CONFLICT DO NOTHING
//       in the common case already created the link from the initial login.
//   (b) The function receives a ResolvedIdentity instead of reading DB rows
//       inline; it re-reads the user row fresh for defence-in-depth.
//
// Callers: handleGoogleCallback (1-identity case) + selectLoginIdentity.
// ---------------------------------------------------------------------------

export async function mintForIdentity(
  identity: ResolvedIdentity,
  ctx: {
    // P2: subject is now optional. Email-OTP origin has no Google identity, so
    // subject is undefined for that path. When subject is undefined, the
    // oauth_identities INSERT (customer branch) is skipped — no bogus Google link
    // is written. Google callback + P1 /select always pass a subject ⇒ byte-unchanged.
    subject?: string;
    claims?: GoogleIdTokenClaims;
    ip: string;
    ua: string;
    embeddedReturnTo: string | undefined;
  },
): Promise<OidcCallbackOutput & { kind: "session" }> {
  const { subject, claims, ip, ua, embeddedReturnTo } = ctx;
  const platformTenantId = config.PLATFORM_TENANT_ID;

  if (identity.isPlatform || identity.role === "super_admin") {
    // -------------------------------------------------------------------------
    // PLATFORM BRANCH — super-admin mint
    //
    // Defence-in-depth re-asserts:
    //   1. Re-check SUPER_ADMIN_EMAILS allowlist when claims are present.
    //   2. Re-read the platform users row fresh (status/role/deleted).
    // -------------------------------------------------------------------------

    // Gate-2 re-assert (when claims available — normal callback path).
    if (claims?.email !== undefined) {
      const platformEmail = normalizeEmail(claims.email);
      const allowlist = (config.SUPER_ADMIN_EMAILS ?? "")
        .split(",")
        .map((e) => normalizeEmail(e.trim()))
        .filter((e) => e.length > 0);
      if (!allowlist.includes(platformEmail)) {
        throw new AuthnError("authentication failed");
      }
    }
    // When claims absent (select path), resolveLoginIdentities already filtered
    // by allowlist at consumeLoginContinuation time AND at re-resolve in
    // selectLoginIdentity. Defence-in-depth is satisfied by the fresh DB read below.

    // Gate-3 re-read: fresh platform users row.
    let platformUser: UserRow | null = null;
    await withTenant(platformTenantId, async (client) => {
      const userRes = await client.query<UserRow>(
        `SELECT id, tenant_id, email, role, status, deleted_at
         FROM users
         WHERE id = $1`,
        [identity.userId],
      );
      if (userRes.rows.length > 0) {
        platformUser = userRes.rows[0]!;
      }
    });

    if (
      platformUser === null ||
      (platformUser as UserRow).role !== "super_admin" ||
      (platformUser as UserRow).status !== "active" ||
      (platformUser as UserRow).deleted_at !== null
    ) {
      throw new AuthnError("authentication failed");
    }

    // Gate-4: mint totpVerified=false; ALWAYS redirect /admin/mfa.
    // NO oauth_identities INSERT on this path.
    const { token: sessionToken } = await sessions.create({
      userId: (platformUser as UserRow).id,
      tenantId: platformTenantId,
      role: "super_admin",
      totpVerified: false,
      ip,
      ua,
    });

    return {
      kind: "session",
      sessionToken,
      user: {
        id: (platformUser as UserRow).id,
        email: (platformUser as UserRow).email,
        tenantId: platformTenantId,
        role: "super_admin" as const,
      },
      redirectTo: "/admin/mfa",
    };
  }

  // -------------------------------------------------------------------------
  // CUSTOMER TENANT BRANCH — normal mint
  // -------------------------------------------------------------------------

  let resolvedUser: UserRow | null = null;

  await withTenant(identity.tenantId, async (client) => {
    // Re-read user row fresh (status/deleted guard re-checked at mint time).
    const userRes = await client.query<UserRow>(
      `SELECT id, tenant_id, email, role, status, deleted_at
       FROM users
       WHERE id = $1
         AND status = 'active'
         AND deleted_at IS NULL`,
      [identity.userId],
    );

    if (userRes.rows.length === 0) {
      return; // will throw below
    }

    const found = userRes.rows[0]!;
    resolvedUser = found;

    // oauth_identities JIT-link (ON CONFLICT (provider,subject) DO NOTHING).
    // raw_profile email/name/picture are optional — omit when claims absent.
    //
    // P2: subject is optional. Email-OTP origin (subject === undefined) has no
    // Google identity — skip this INSERT entirely so no bogus oauth link is written.
    // The session is still minted for the resolved customer user above.
    // Google callback + P1 /select always pass a subject ⇒ behaviour byte-unchanged.
    //
    // NOTE: The super_admin branch (isPlatform || role === 'super_admin') above is
    // UNREACHABLE from the email-OTP path because filterEligible() in email-otp.ts
    // excludes platform rows and super_admin roles before mintForIdentity is called.
    // This comment serves as a defence-in-depth confirmation.
    if (subject !== undefined) {
      await client.query(
        `INSERT INTO oauth_identities
           (tenant_id, user_id, provider, subject, email_verified, raw_profile)
         VALUES ($1, $2, 'google', $3, $4, $5)
         ON CONFLICT (provider, subject) DO NOTHING`,
        [
          found.tenant_id,
          found.id,
          subject,
          claims?.email_verified ?? false,
          JSON.stringify({
            sub: subject,
            ...(claims?.email !== undefined ? { email: claims.email } : {}),
            ...(claims?.name !== undefined ? { name: claims.name } : {}),
            ...(claims?.picture !== undefined ? { picture: claims.picture } : {}),
          }),
        ],
      );
    }
  });

  if (resolvedUser === null) {
    throw new AuthnError("authentication failed");
  }

  const user = resolvedUser as UserRow;

  // Mint session.
  //
  // totpVerified reflects whether this session has satisfied EVERY second-factor
  // requirement for its role in THIS deployment — not "has the user typed a TOTP
  // code". Computed live from config.MFA_REQUIRED at mint time:
  //   - candidate                       → true (candidates never do TOTP; matches
  //                                        magic-link.ts which hardcodes true).
  //   - admin/reviewer, MFA_REQUIRED=false → true. There is no TOTP step in this
  //     deployment (redirect below goes straight to /admin, never /admin/mfa), so
  //     the factor requirement IS satisfied. WITHOUT this, the session stays
  //     totpVerified=false for its entire 8h life and is permanently pinned to the
  //     60/min `aiq:rl:user:<id>` rate bucket — a normal dashboard page exceeds
  //     60 authenticated calls/min and every request 429s with scope=user,
  //     including /api/auth/google/start (the cookie is still sent), so the admin
  //     can't even re-login out of it. Recurring RATE_LIMITED lockout, RCA
  //     2026-05-30 (3 prior fixes all raised IP-scope caps, never this one).
  //   - admin/reviewer, MFA_REQUIRED=true  → false. Must still complete TOTP at
  //     /admin/mfa (redirect below), which flips totpVerified via sessions.verify.
  //
  // SAFETY: requireAuth is already MFA_REQUIRED-aware — for non-super_admin roles
  // it skips the TOTP-verified AND fresh-MFA gates entirely when MFA_REQUIRED=false
  // (require-auth.ts:59). So flipping this true does NOT relax any auth gate; it
  // only restores the correct rate-limit trust tier. super_admin is minted in its
  // own branch above and ALWAYS stays totpVerified=false (TOTP required regardless
  // of MFA_REQUIRED) — this line is never reached for super_admin.
  const { token: sessionToken } = await sessions.create({
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    totpVerified: user.role === "candidate" || !config.MFA_REQUIRED,
    ip,
    ua,
  });

  // Determine redirect target — identical logic to pre-P1 callback.
  const adminLanding = config.MFA_REQUIRED ? "/admin/mfa" : "/admin";
  const redirectTo =
    user.role === "candidate"
      ? "/"
      : embeddedReturnTo !== undefined
        ? safeReturnTo(embeddedReturnTo)
        : adminLanding;

  return {
    kind: "session",
    sessionToken,
    user: {
      id: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      role: user.role,
    },
    redirectTo,
  };
}

// ---------------------------------------------------------------------------
// handleGoogleCallback
//
// P1 change: state no longer contains tenantId; identity resolution is
// cross-tenant via resolveLoginIdentities (called AFTER full verification).
// Steps 1-4 (CSRF, code exchange, JWKS, nonce) are BYTE-UNCHANGED.
// ---------------------------------------------------------------------------

export async function handleGoogleCallback(input: {
  code: string;
  state: string;
  stateCookieValue: string | undefined;
  nonceCookieValue: string | undefined;
  ip: string;
  ua: string;
}): Promise<OidcCallbackOutput> {
  const { code, state, stateCookieValue, nonceCookieValue, ip, ua } = input;

  // --- 1. State CSRF check --- (BYTE-UNCHANGED)
  // constantTimeEqual requires equal-length buffers. Mismatched lengths are
  // safe to reject early — no timing signal leaks from a length comparison.
  if (
    stateCookieValue === undefined ||
    state.length !== stateCookieValue.length ||
    !constantTimeEqual(
      Buffer.from(state),
      Buffer.from(stateCookieValue),
    )
  ) {
    throw new AuthnError("OAuth state mismatch — possible CSRF attack");
  }

  // Parse the embedded context from state: <random>[|<returnTo>]
  // P1: tenantId segment removed. parts[0] = random, parts[1] = optional returnTo.
  const parts = state.split("|");
  // parts[0] = random (already verified by CSRF check above)
  const embeddedReturnTo = parts[1]; // optional returnTo (was parts[2] pre-P1)

  // --- 2. Exchange code for tokens --- (BYTE-UNCHANGED)
  const tokens = await exchangeCode(code);

  // --- 3. Verify id_token via JWKS --- (BYTE-UNCHANGED)
  const clientId = config.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new AuthnError("Google SSO is not configured");
  }

  let claims: GoogleIdTokenClaims;
  try {
    const { payload } = await jose.jwtVerify(
      tokens.id_token,
      getJwks(),
      {
        issuer: GOOGLE_ISSUER,
        audience: clientId,
        algorithms: ["RS256"],
      },
    );
    claims = payload as unknown as GoogleIdTokenClaims;
  } catch (err) {
    throw new AuthnError("Google id_token verification failed", { cause: err });
  }

  // --- 4. Nonce check --- (BYTE-UNCHANGED)
  // The nonce claim from the verified id_token must match the cookie value.
  if (
    nonceCookieValue === undefined ||
    claims.nonce === undefined ||
    claims.nonce.length !== nonceCookieValue.length ||
    !constantTimeEqual(
      Buffer.from(claims.nonce),
      Buffer.from(nonceCookieValue),
    )
  ) {
    throw new AuthnError("OAuth nonce mismatch — replay or injection detected");
  }

  // --- 4b. Require a Google-verified email ---
  // Email is now the SOLE cross-tenant identity key (pre-P1 the tenant slug
  // added a scoping factor). A login MUST require Google to have verified the
  // address, else an unverified-email Google account that collides with a
  // provisioned user could authenticate. Fail-closed, generic (no enumeration).
  // Robust check: jose parses the id_token as JSON so email_verified is a
  // boolean per OIDC, but tolerate a stringized "true" defensively — a
  // wrongly-strict guard on the sole login path would be a total outage.
  // Reject only explicit false / missing.
  const emailVerified =
    claims.email_verified === true ||
    (claims.email_verified as unknown) === "true";
  if (!emailVerified) {
    throw new AuthnError("authentication failed");
  }

  const subject = claims.sub;
  const idpEmail = normalizeEmail(claims.email ?? "");

  // ---------------------------------------------------------------------------
  // --- 5. Resolve identities --- (P1: cross-tenant, post-verification only)
  //
  // PRECONDITION: called only here, after steps 1-4 have fully verified the
  // Google id_token. The email is Google-verified at this point.
  // ---------------------------------------------------------------------------

  const identities = await resolveLoginIdentities(idpEmail);

  if (identities.length === 0) {
    throw new AuthnError("authentication failed");
  }

  if (identities.length === 1) {
    // Single identity — mint immediately (identical behaviour to pre-P1 callback).
    return mintForIdentity(identities[0]!, {
      subject,
      claims,
      ip,
      ua,
      embeddedReturnTo,
    });
  }

  // ≥2 identities — issue a continuation token; do NOT mint a session.
  const continuationToken = await storeLoginContinuation({
    idpEmail,
    subject,
    ip,
    ua,
    embeddedReturnTo,
    candidates: identities.map((i) => i.userId),
  });

  return {
    kind: "select",
    continuationToken,
    redirectTo: "/admin/select-identity",
  };
}

