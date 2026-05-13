import { config, RateLimitError } from "@assessiq/core";
import { getRedis } from "../redis.js";
import type { AuthHook, AuthRequest, AuthReply } from "./types.js";

// Three independent fixed-window counters via an atomic Redis Lua script.
// Per addendum § 7:
//   aiq:rl:auth:ip:<ip>     — 10 / 60s, applies to /api/auth/* only
//   aiq:rl:user:<userId>    — 60 / 60s, applies to authenticated routes
//   aiq:rl:tenant:<tenantId> — 600 / 60s, applies to authenticated routes
//
// IP source: req.headers['cf-connecting-ip'] (Caddy normalizes from Cloudflare).
// NEVER raw X-Forwarded-For (spoofable upstream of CF) and NEVER req.ip
// (would lump the entire internet into one bucket via the Caddy bridge gateway).
//
// Algorithm: fixed-window via INCR + EXPIRE(NX). Sliding-window is overkill
// for Phase 0; the bound is a per-window cap, with `Retry-After` reflecting
// the TTL remaining on the bucket.
//
// HTTP shape on rejection: 429 with body
//   { "error": { "code": "rate_limit", "message": "...",
//                 "details": { "retryAfterSeconds": <n>, "scope": "ip|user|tenant" } } }
// + Retry-After header.

interface Limit {
  key: string;
  max: number;
  windowSeconds: number;
  scope: "ip" | "user" | "tenant";
}

interface BucketResult {
  remaining: number;
  ttlSeconds: number;
}

// Lua script: INCR key; if new count == 1, EXPIRE key window (so the TTL is
// bounded on first access only — re-INCR within window doesn't reset TTL,
// which would let an attacker game the limit by spreading hits across the
// boundary). Returns [remaining, ttl].
const LUA = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local n = redis.call("INCR", key)
if n == 1 then
  redis.call("EXPIRE", key, window)
end
local ttl = redis.call("TTL", key)
local remaining = max - n
return {remaining, ttl}
`;

async function evalBucket(limit: Limit): Promise<BucketResult> {
  const redis = getRedis();
  const result = (await redis.eval(LUA, 1, limit.key, limit.max, limit.windowSeconds)) as [number, number];
  return { remaining: result[0], ttlSeconds: result[1] < 0 ? limit.windowSeconds : result[1] };
}

// Extracts the client IP. Production uses CF-Connecting-IP (Caddy normalized).
// In non-production, falls back to x-forwarded-for first hop for dev convenience —
// fail-closed in production: missing CF header means "no client IP", not "use XFF".
function extractClientIp(req: AuthRequest): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;

  if (config.NODE_ENV !== "production") {
    const xff = req.headers["x-forwarded-for"];
    const xffStr = Array.isArray(xff) ? xff[0] : xff;
    if (typeof xffStr === "string" && xffStr.length > 0) {
      // First hop only — XFF is comma-separated.
      const first = xffStr.split(",")[0]?.trim();
      if (first !== undefined && first.length > 0) return first;
    }
  }

  return null;
}

function setHeaders(reply: AuthReply, max: number, remaining: number, ttlSeconds: number, exhausted: boolean): void {
  reply.header("X-RateLimit-Limit", max);
  reply.header("X-RateLimit-Remaining", Math.max(0, remaining));
  if (exhausted) {
    reply.header("Retry-After", Math.max(1, ttlSeconds));
  }
}

// Roles that qualify for the per-IP bypass. Explicit allowlist — NOT a denylist
// (we do NOT say "not candidate"; we say "is admin OR reviewer").
const BYPASS_ROLES = new Set<string>(["admin", "reviewer"]);

// Sanitized role values that are safe to place in a response header.
// Must stay in sync with BYPASS_ROLES. Never emit arbitrary strings from
// req.session.role into headers — even though the role is DB-sourced, defense
// in depth requires an explicit enum-normalization step.
const BYPASS_ROLE_HEADER_VALUE: Record<string, string> = {
  admin: "admin",
  reviewer: "reviewer",
};

interface RateLimitOptions {
  // For Phase 0 we tune the limits via constants per the addendum. The opts
  // object exists so a future per-route override can pass tighter limits.
  authPathPrefix?: string; // default "/api/auth/"

  // When true, an admin or reviewer session bypasses the per-IP bucket on this
  // middleware instance. The TOTP-verified requirement mirrors requireAuth's
  // MFA gating (see middleware/require-auth.ts:30-39):
  //   - MFA_REQUIRED=true  → role IN {admin,reviewer} AND totpVerified===true
  //   - MFA_REQUIRED=false → role IN {admin,reviewer}  (TOTP gate is dormant)
  // The per-user (60/min) and per-tenant (600/min) buckets still apply even
  // when the IP bucket is skipped, so a compromised admin session is still
  // capped at 60 req/min from the affected user_id.
  //
  // This flag is set CODE-SIDE in rateLimitMiddleware(opts) — it is NEVER read
  // from req.headers, req.query, req.body, or req.params. A request cannot
  // opt itself into the bypass by crafting a header or query string.
  //
  // Initial opt-in whitelist (see apps/api/src/routes/auth/*):
  //   - /api/auth/google/start
  //   - /api/auth/logout
  //   - /api/auth/whoami
  //
  // Always-strict blacklist (these are NEVER opted in, regardless of session):
  //   - /api/auth/totp/verify       (TOTP brute-force class)
  //   - /api/auth/totp/recovery     (recovery-code brute-force class)
  //   - /api/auth/totp/enroll/*     (enrollment confirm is also brute-forceable)
  //   - /api/auth/google/cb         (OAuth callback — no session yet by definition)
  //   - /api/take/start             (magic-link redemption — no session yet)
  allowVerifiedAdminBypass?: boolean;
}

// Conditions that must ALL be true for the per-IP bypass to fire.
// (a) The route was explicitly opted in (code-set flag, never request input).
// (b) The request carries a valid session with role in the allowlist.
// (c) MFA gate (mirrors requireAuth):
//       MFA_REQUIRED=true  → session.totpVerified === true (strict)
//       MFA_REQUIRED=false → no TOTP check (gate is dormant globally)
//     The two-state predicate avoids the dead-bypass trap that locked out
//     Google-SSO admins pre-2026-05-13: when MFA_REQUIRED=false, no session
//     ever sets totpVerified=true, so a strict ===true check meant the
//     bypass NEVER fired and every admin login was capped at 10/min/IP.
//
// The bypass is evaluated PER REQUEST — no module-level caching of bypass
// decisions. Two subsequent requests from the same IP are evaluated
// independently; there is no "this IP bypassed once, all subsequent bypass"
// memoization.
function shouldBypassIpBucket(req: AuthRequest, allowBypass: boolean): false | "admin" | "reviewer" {
  if (!allowBypass) return false;
  if (req.session === undefined) return false;
  const role = req.session.role;
  if (!BYPASS_ROLES.has(role)) return false;
  // Mirror requireAuth's MFA gate: when MFA is opt-in (the early-stage
  // default), the TOTP check is dormant. Strict === true rejects false,
  // undefined, null, 1, "true", etc. when the gate IS active.
  if (config.MFA_REQUIRED && req.session.totpVerified !== true) return false;
  // Return the validated role so the caller can emit the sanitized header.
  return role as "admin" | "reviewer";
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}): AuthHook {
  const authPrefix = opts.authPathPrefix ?? "/api/auth/";
  const allowBypass = opts.allowVerifiedAdminBypass === true;

  return async (req, reply) => {
    const url = req.url ?? "";
    const isAuthRoute = url.startsWith(authPrefix);

    // Evaluate the bypass BEFORE building the limits array so we can decide
    // whether to include the IP bucket. Bypass decision is per-request (no cache).
    const bypassRole = isAuthRoute ? shouldBypassIpBucket(req, allowBypass) : false;

    // Compose the active limits.
    const limits: Limit[] = [];

    if (isAuthRoute && bypassRole === false) {
      const ip = extractClientIp(req);
      // No CF-Connecting-IP and not in dev → reject at edge.
      if (ip === null) {
        // Fail-closed: cannot identify the caller, cannot enforce a limit.
        // The CF header is set by Cloudflare unconditionally on every
        // proxied request; absence means a direct origin hit, which is
        // already a deploy anomaly.
        throw new RateLimitError("missing client IP for /api/auth/* rate limit");
      }
      // Dev-only lift: prod and test both use 10/min (prod for real
      // protection; test so existing assertions on the 11th-hit threshold
      // keep working). Only NODE_ENV=development gets 100/min so admin
      // login flows don't self-throttle while iterating locally.
      limits.push({
        key: `aiq:rl:auth:ip:${ip}`,
        max: config.NODE_ENV === "development" ? 100 : 10,
        windowSeconds: 60,
        scope: "ip",
      });
    }

    if (req.session !== undefined) {
      limits.push({
        key: `aiq:rl:user:${req.session.userId}`,
        max: 60,
        windowSeconds: 60,
        scope: "user",
      });
      limits.push({
        key: `aiq:rl:tenant:${req.session.tenantId}`,
        max: 600,
        windowSeconds: 60,
        scope: "tenant",
      });
    } else if (req.apiKey !== undefined) {
      limits.push({
        key: `aiq:rl:tenant:${req.apiKey.tenantId}`,
        max: 600,
        windowSeconds: 60,
        scope: "tenant",
      });
    }

    if (limits.length === 0) {
      // Unauth public route with no session — no enforcement.
      // Log bypass=false at debug level for traceability (cheap, no Redis).
      if (bypassRole !== false) {
        // This branch is unreachable: bypassRole is truthy only when
        // isAuthRoute && bypassRole !== false, but then we've already added
        // user+tenant limits above (session is defined). If somehow reached,
        // treat conservatively as "no limits to check" without bypassing.
        req.log?.debug({ rate_limit_bypass: false, reason: "no-limits-after-bypass", endpoint: url }, "rate limit: no limits");
      }
      return;
    }

    // Evaluate all buckets in parallel — atomic per-bucket via Lua.
    const results = await Promise.all(limits.map(async (l) => ({ limit: l, result: await evalBucket(l) })));

    // When bypass fired, emit the bypass headers so observability can audit.
    // Role value is sanitized through BYPASS_ROLE_HEADER_VALUE (enum mapping,
    // never a raw string from user-controlled input — role is DB-sourced but
    // defense-in-depth demands the extra normalization step).
    if (bypassRole !== false) {
      const safeRoleValue = BYPASS_ROLE_HEADER_VALUE[bypassRole] ?? "admin";
      reply.header("X-RateLimit-Bypass", safeRoleValue);

      // Emit user + tenant headers when bypass is active so callers can see
      // their remaining quota even when the IP bucket was skipped.
      for (const r of results) {
        if (r.limit.scope === "user") {
          reply.header("X-RateLimit-Limit-User", r.limit.max);
          reply.header("X-RateLimit-Remaining-User", Math.max(0, r.result.remaining));
        } else if (r.limit.scope === "tenant") {
          reply.header("X-RateLimit-Limit-Tenant", r.limit.max);
          reply.header("X-RateLimit-Remaining-Tenant", Math.max(0, r.result.remaining));
        }
      }

      req.log?.debug(
        {
          rate_limit_bypass: true,
          role: safeRoleValue,
          userId: req.session?.userId,
          tenantId: req.session?.tenantId,
          endpoint: url,
        },
        "rate limit: IP bucket bypassed for verified admin/reviewer",
      );
    } else {
      // No bypass — set standard headers from most-constrained bucket.
      let mostConstrained = results[0]!;
      for (const r of results) {
        if (r.result.remaining < mostConstrained.result.remaining) mostConstrained = r;
      }
      setHeaders(reply, mostConstrained.limit.max, mostConstrained.result.remaining, mostConstrained.result.ttlSeconds, false);
    }

    // Reject if ANY bucket is exhausted (remaining < 0).
    // This applies regardless of bypass state — user+tenant buckets are
    // always enforced even when the IP bucket was skipped.
    for (const r of results) {
      if (r.result.remaining < 0) {
        setHeaders(reply, r.limit.max, r.result.remaining, r.result.ttlSeconds, true);
        throw new RateLimitError(`rate limit exceeded for scope=${r.limit.scope}`, {
          details: {
            retryAfterSeconds: r.result.ttlSeconds,
            scope: r.limit.scope,
          },
        });
      }
    }
  };
}

// Test export — mirrors the addendum-pinned IP source policy.
export { extractClientIp };
