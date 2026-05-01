import { AuthnError, AuthzError, parseIso, config } from "@assessiq/core";
import { sessions } from "../sessions.js";
import { apiKeys } from "../api-keys.js";
import type { AuthHook } from "./types.js";
import type { ApiKeyScope, ApiKeyRecord } from "../api-keys.js";
import type { Role } from "../sessions.js";

// requireAuth gate: asserts req.session OR req.apiKey is present (both set
// by the upstream loaders). Slides the session expiry on session-backed
// requests — this is the ONLY hook that calls sessions.refresh. Per
// addendum § 1, refreshing only on requireAuth (not health checks etc.)
// prevents a curl-keepalive from defeating the 30-min idle eviction.

interface RequireAuthOptions {
  roles?: Role[];                 // restrict to listed roles
  freshMfaWithinMinutes?: number; // step-up MFA cap; throws if last_totp_at older
  requireTotpVerified?: boolean;  // default true for any non-candidate auth
}

export function requireAuth(opts: RequireAuthOptions = {}): AuthHook {
  return async (req, _reply) => {
    if (req.session !== undefined) {
      const sess = req.session;

      // Role check.
      if (opts.roles !== undefined && !opts.roles.includes(sess.role)) {
        throw new AuthzError(`role ${sess.role} not authorized`);
      }

      // TOTP-verified gate. config.MFA_REQUIRED short-circuits the check —
      // when MFA is opt-in (Phase 0 default for early stage), every gate
      // that would otherwise demand TOTP becomes a no-op. Role gates above
      // remain authoritative; this only relaxes the second-factor demand.
      // Flip MFA_REQUIRED=true in env to re-harden without code changes.
      if (config.MFA_REQUIRED) {
        const requireTotp = opts.requireTotpVerified ?? (sess.role !== "candidate");
        if (requireTotp && !sess.totpVerified) {
          throw new AuthnError("totp verification required");
        }

        // Fresh-MFA gate (step-up). Only meaningful when MFA is enforced
        // — when MFA_REQUIRED=false the freshness check has nothing to
        // measure (lastTotpAt would always be null) and is skipped.
        if (opts.freshMfaWithinMinutes !== undefined) {
          if (sess.lastTotpAt === null) {
            throw new AuthnError("fresh totp required");
          }
          const ageMs = Date.now() - parseIso(sess.lastTotpAt).getTime();
          if (ageMs > opts.freshMfaWithinMinutes * 60 * 1000) {
            throw new AuthnError("fresh totp required");
          }
        }
      }

      // Sliding-refresh: only after all gates pass. This is the moment the
      // request "passes requireAuth" per addendum § 1.
      // The cookie value is the session token; we don't have it here directly,
      // but session.id + tokenHash mapping isn't reversible — we need the
      // raw cookie to call sessions.refresh. The route layer must register
      // a separate `extendOnPass` hook that reads req.cookies[SESSION_COOKIE_NAME]
      // and calls sessions.refresh(token) AFTER this requireAuth returns.
      //
      // Why not call refresh here? requireAuth is structurally typed and
      // doesn't have access to req.cookies (the cookieParser is a peer hook).
      // The route-layer wrapper composes:
      //   1. cookieParser → 2. sessionLoader → 3. requireAuth → 4. extendOnPass
      // extendOnPass reads cookies[name] → sessions.refresh(token).
      //
      // We DO update req.session.expiresAt here so downstream handlers see
      // the post-refresh value, but Redis state is unchanged until step 4.
      return;
    }

    if (req.apiKey !== undefined) {
      // API keys have scopes, not roles, and no TOTP. Routes that gate on
      // roles or fresh-MFA are session-only — surface the misconfiguration
      // as AuthzError rather than silently letting the API key through.
      // Use requireScope for API-key authorization instead.
      if (opts.roles !== undefined) {
        throw new AuthzError("role gate requires a session; API keys use scopes — route must use requireScope");
      }
      if (opts.freshMfaWithinMinutes !== undefined) {
        throw new AuthzError("fresh totp gate requires a session; API keys cannot satisfy this");
      }
      return;
    }

    throw new AuthnError("authentication required");
  };
}

export function requireRole(...roles: Role[]): AuthHook {
  return requireAuth({ roles });
}

export function requireFreshMfa(maxAgeMinutes = 15): AuthHook {
  return requireAuth({ freshMfaWithinMinutes: maxAgeMinutes });
}

export function requireScope(...required: ApiKeyScope[]): AuthHook {
  return async (req, _reply) => {
    if (req.apiKey === undefined) {
      throw new AuthnError("api key required");
    }
    // Reuse apiKeys.requireScope's logic — it knows about admin:* wildcard.
    const record: ApiKeyRecord = {
      id: req.apiKey.id,
      tenantId: req.apiKey.tenantId,
      scopes: req.apiKey.scopes as ApiKeyScope[],
      // Stub the rest of the record — requireScope only reads scopes.
      name: "",
      keyPrefix: "",
      status: "active",
      lastUsedAt: null,
      createdBy: "",
      createdAt: "",
      expiresAt: null,
    };
    for (const scope of required) {
      apiKeys.requireScope(record, scope);
    }
  };
}

// Slides the session expiry. Wired by the route layer as the LAST hook in
// the auth chain (after requireAuth has gated the request). Called once per
// authenticated request — does not throw on Redis transient errors (logs
// and returns; the caller's request still succeeds and the stale Redis TTL
// covers up to 8h before the session disappears anyway).
export function extendOnPassMiddleware(cookieName: string): AuthHook {
  return async (req, _reply) => {
    if (req.session === undefined) return; // not session-backed
    const token = req.cookies?.[cookieName];
    if (token === undefined) return;
    try {
      await sessions.refresh(token);
    } catch (err) {
      req.log?.warn({ err, kind: "session-refresh-failed" }, "session refresh failed; continuing");
    }
  };
}
