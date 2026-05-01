// modules/01-auth/src/google-sso.ts
//
// Google OIDC start + callback. RS256 id_token verify via JWKS; state + nonce
// CSRF protection; oauth_identities → users by (tenant_id, email) resolution.
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

export interface OidcCallbackOutput {
  sessionToken: string;
  user: { id: string; email: string; tenantId: string; role: "admin" | "reviewer" | "candidate" };
  redirectTo: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_STATE_NAME = "aiq_oauth_state";
const COOKIE_NONCE_NAME = "aiq_oauth_nonce";
const COOKIE_TTL_SEC = 600; // 10 minutes — Google's auth UI cap
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
// ---------------------------------------------------------------------------

export async function startGoogleSso(opts: {
  tenantId: string;
  returnTo?: string;
}): Promise<OidcStartOutput> {
  const clientId = config.GOOGLE_CLIENT_ID;
  const redirectUri = config.GOOGLE_OAUTH_REDIRECT;

  if (!clientId || !redirectUri) {
    throw new AuthnError("Google SSO is not configured");
  }

  // State: random 32 bytes base64url. Stored as the cookie value and sent as
  // the Google state= param. On callback, constantTimeEqual verifies them.
  // The tenantId is embedded after a pipe so the callback can scope DB queries.
  const stateRandom = randomBytes(32).toString("base64url");
  const rt = safeReturnTo(opts.returnTo);

  // Full state encodes: <random>|<tenantId>[|<returnTo if non-default>]
  // This keeps the CSRF token opaque while carrying the context the callback
  // needs without a server-side state store (no Redis round-trip on start).
  const stateParts: string[] = [stateRandom, opts.tenantId];
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

interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface OauthIdentityRow {
  id: string;
  user_id: string;
  tenant_id: string;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: "admin" | "reviewer" | "candidate";
  status: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// handleGoogleCallback
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

  // --- 1. State CSRF check ---
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

  // Parse the embedded context from state: <random>|<tenantId>[|<returnTo>]
  const parts = state.split("|");
  // parts[0] = random, parts[1] = tenantId, parts[2] = optional returnTo
  const tenantId = parts[1];
  const embeddedReturnTo = parts[2];

  if (!tenantId) {
    throw new AuthnError("OAuth state is malformed — missing tenant context");
  }

  // --- 2. Exchange code for tokens ---
  const tokens = await exchangeCode(code);

  // --- 3. Verify id_token via JWKS ---
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

  // --- 4. Nonce check ---
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

  const subject = claims.sub;
  const idpEmail = normalizeEmail(claims.email ?? "");

  // --- 5. Resolve AssessIQ user (oauth_identities → users) ---
  //
  // The oauth_identities table has UNIQUE(provider, subject) as a global key,
  // meaning a Google account maps to exactly one AssessIQ user. We scope
  // the lookup within the tenant's RLS context via withTenant — both
  // tables are RLS-protected and will filter to the tenant automatically.
  //
  // Pass 1: oauth_identities by (provider='google', subject).
  // Pass 2: users by (tenant_id [via RLS], email) — JIT link.
  // Pass 3: no user → AuthnError (no self-registration in Phase 1).

  let user: UserRow | null = null;

  // Pass 1 — try oauth_identities lookup within tenant scope.
  await withTenant(tenantId, async (client) => {
    const identityRes = await client.query<OauthIdentityRow>(
      `SELECT oi.id, oi.user_id, oi.tenant_id
       FROM oauth_identities oi
       WHERE oi.provider = 'google' AND oi.subject = $1`,
      [subject],
    );

    if (identityRes.rows.length > 0) {
      const identity = identityRes.rows[0]!;
      const userRes = await client.query<UserRow>(
        `SELECT id, tenant_id, email, role, status, deleted_at
         FROM users
         WHERE id = $1`,
        [identity.user_id],
      );
      if (userRes.rows.length > 0) {
        user = userRes.rows[0]!;
      }
    }
  });

  // Pass 2 — email JIT-link within tenant scope.
  if (user === null) {
    await withTenant(tenantId, async (client) => {
      const userRes = await client.query<UserRow>(
        `SELECT id, tenant_id, email, role, status, deleted_at
         FROM users
         WHERE email = $1`,
        [idpEmail],
      );

      if (userRes.rows.length > 0) {
        const found = userRes.rows[0]!;
        user = found;

        // JIT-link: insert the oauth_identities row so future logins use
        // Pass 1 (faster, avoids email normalization edge cases).
        // ON CONFLICT DO NOTHING guards against a race where two concurrent
        // callbacks both hit Pass 2 simultaneously.
        await client.query(
          `INSERT INTO oauth_identities
             (tenant_id, user_id, provider, subject, email_verified, raw_profile)
           VALUES ($1, $2, 'google', $3, $4, $5)
           ON CONFLICT (provider, subject) DO NOTHING`,
          [
            found.tenant_id,
            found.id,
            subject,
            claims.email_verified ?? false,
            JSON.stringify({
              sub: subject,
              email: claims.email,
              name: claims.name,
              picture: claims.picture,
            }),
          ],
        );
      }
    });
  }

  // Pass 3 — no user → reject (no self-registration in Phase 1).
  if (user === null) {
    throw new AuthnError("user not in tenant");
  }

  // --- 6. Guard: active + not soft-deleted ---
  // Cast because TypeScript doesn't narrow `user` after the async closures.
  const resolvedUser = user as UserRow;

  if (resolvedUser.status !== "active") {
    throw new AuthnError("user account is disabled");
  }
  if (resolvedUser.deleted_at !== null) {
    throw new AuthnError("user account has been deleted");
  }

  // --- 7. Mint session ---
  // totpVerified semantics:
  //   - candidate:                always true (magic-link-issued; no admin gate)
  //   - admin/reviewer + MFA_REQUIRED=true:  false (pre-MFA; user must enrol/verify TOTP)
  //   - admin/reviewer + MFA_REQUIRED=false: false on the row (the user genuinely
  //     hasn't done TOTP), but requireAuth bypasses the gate when MFA_REQUIRED=false
  //     so the false-state still grants full access. Keeping the row "honest" means
  //     flipping MFA_REQUIRED to true later doesn't grandfather existing sessions
  //     past the gate — they'll re-prompt for TOTP enrolment, which is the right
  //     re-hardening behaviour.
  const { token: sessionToken } = await sessions.create({
    userId: resolvedUser.id,
    tenantId: resolvedUser.tenant_id,
    role: resolvedUser.role,
    totpVerified: false,
    ip,
    ua,
  });

  // --- 8. Determine redirect target ---
  // Candidates skip MFA. Admins/reviewers:
  //   - MFA_REQUIRED=true  → /admin/mfa (pre-MFA enrolment / step-up)
  //   - MFA_REQUIRED=false → safeReturnTo(embedded) || /admin/users (skip MFA hop)
  // safeReturnTo handles whitelisting; embeddedReturnTo is from the state token.
  const adminLanding = config.MFA_REQUIRED
    ? "/admin/mfa"
    : "/admin/users";
  const redirectTo =
    resolvedUser.role === "candidate"
      ? "/"
      : embeddedReturnTo !== undefined
        ? safeReturnTo(embeddedReturnTo)
        : adminLanding;

  return {
    sessionToken,
    user: {
      id: resolvedUser.id,
      email: resolvedUser.email,
      tenantId: resolvedUser.tenant_id,
      role: resolvedUser.role,
    },
    redirectTo,
  };
}

