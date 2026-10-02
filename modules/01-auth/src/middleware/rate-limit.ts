import { config, RateLimitError } from "@assessiq/core";
import { getRedis } from "../redis.js";
import { isOriginVerified, validCfIp } from "../client-ip.js";
import type { AuthHook, AuthRequest, AuthReply } from "./types.js";

// Auth-tier-aware rate-limiting applied to ALL routes (not only /api/auth/*).
// Up to four independent fixed-window counters evaluated in parallel per request.
//
// IP bucket key: aiq:rl:ip:<ip>
//   Max is resolved per-request by resolveIpBucketMax() based on auth tier.
//   Window is fixed at 60s.
//
//   verified admin (role∈{admin,reviewer,super_admin} && totpVerified===true)
//                   → config.RATE_LIMIT_IP_VERIFIED_ADMIN (default 5000/min)
//                     DoS ceiling only; credential + per-user are the real limits.
//   pre-MFA admin   → config.RATE_LIMIT_IP_ADMIN  (default 100/min) — UNCHANGED
//   candidate session (role==='candidate') → config.RATE_LIMIT_IP_CANDIDATE_SESSION (3000/min)
//   unknown-role session → config.RATE_LIMIT_IP_USER (default 30/min)
//   anon            → config.RATE_LIMIT_IP_ANON   (default  30/min)
//   API key         → config.RATE_LIMIT_IP_APIKEY (default 2000/min)
//
// Credential bucket key: aiq:rl:cred:<routePath>:<ip>
//   Optional — only pushed when rateLimitMiddleware({ credentialEndpoint: true }).
//   Max: config.RATE_LIMIT_CREDENTIAL (default 20/min).
//   ALWAYS applies regardless of auth tier. Verified admins hit it too.
//   Prevents the IP cap lift from weakening TOTP brute-force protection.
//
// Candidate-entry bucket key: aiq:rl:entry:<routePath>:<ip>
//   Only when rateLimitMiddleware({ candidateEntry: true }); REPLACES the general
//   IP bucket for that route. Max: config.RATE_LIMIT_IP_CANDIDATE_ENTRY (2000/min).
//   Why: a campus drive = 100-500 students in one lab behind ONE public IP all
//   opening their magic link at once (POST /take/start, POST
//   /api/auth/candidate/verify-link). The anon 120/min IP cap (or the 20/min
//   credential cap) would 429 the lab. The token is 256-bit random, so 600
//   guesses/min/IP is still infeasible to brute-force. A separate key keeps the
//   entry burst from burning the lab's general anon bucket (whoami probes etc.).
//
// Campus drive (candidate sessions): all students share one IP, so the per-IP
// bucket cannot be the binding limit for a valid candidate session; the per-user
// bucket (config.RATE_LIMIT_USER_CANDIDATE, 120/min) is the real per-student cap
// and the per-tenant bucket (config.RATE_LIMIT_TENANT, 6000/min) bounds a tenant.
// Session validity is established by sessionLoader (Redis lookup of the session
// cookie token) BEFORE this runs: a forged cookie leaves req.session undefined
// and falls to the anon tier.
//
// User bucket key:   aiq:rl:user:<userId>,     max varies by tier:
//   verified admin (totpVerified===true): config.RATE_LIMIT_USER_VERIFIED_ADMIN (300/min)
//   candidate session: config.RATE_LIMIT_USER_CANDIDATE (120/min)
//   pre-MFA admin / other: 60/min (hardcoded — original conservative cap)
// Tenant bucket key: aiq:rl:tenant:<tenantId>, config.RATE_LIMIT_TENANT (6000/min),
//   authenticated + API-key
//
// Key namespace: aiq:rl:ip:<ip> (not aiq:rl:auth:ip:) — old keys expire naturally.
//
// IP source: req.headers['cf-connecting-ip'] (Caddy normalized from Cloudflare).
// NEVER raw X-Forwarded-For (spoofable upstream of CF) and NEVER req.ip
// (would be the Caddy bridge gateway IP, lumping the entire internet into one
// bucket). Fail-closed in production: missing CF header → 429.

interface Limit {
  key: string;
  max: number;
  windowSeconds: number;
  scope: "ip" | "user" | "tenant" | "credential";
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

/**
 * Consume one unit from an arbitrary fixed-window bucket (same atomic Lua as the
 * middleware). For route-specific throttles the middleware can't key on — e.g.
 * per-magic-link-token on POST /take/start (codex 2026-10: a valid link replayed
 * from many IPs must not generate unbounded session/DB work). Returns allowed=false
 * once the bucket is exhausted. `key` MUST NOT contain a raw secret — hash it.
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const r = await evalBucket({ key, max, windowSeconds, scope: "credential" });
  return { allowed: r.remaining >= 0, retryAfterSeconds: r.ttlSeconds };
}

/**
 * Read-only check of a bucket consumeRateLimit() fills: true once `max` hits
 * have been consumed in the current window. Lets a route throttle FAILURES only
 * (check before work, consume on failure). ponytail: check-then-consume is not
 * atomic, so concurrent failures may overshoot `max` slightly; fine for a
 * brute-force brake.
 */
export async function isRateLimited(key: string, max: number): Promise<boolean> {
  const n = Number(await getRedis().get(key));
  return Number.isFinite(n) && n >= max;
}

// Extracts the client IP. Production uses CF-Connecting-IP (Caddy normalized).
// In non-production, falls back to x-forwarded-for first hop for dev convenience —
// fail-closed in production: missing CF header means "no client IP", not "use XFF".
function extractRateLimitClientIp(req: AuthRequest): string | null {
  // Origin-verify gate (ORIGIN_TRUST_MODE=enforce only): a request that did
  // not provably traverse Cloudflare (missing/wrong x-origin-verify) has NO
  // trustworthy client IP. Return null so it flows into the EXISTING prod
  // fail-closed throw below — deliberately NOT bucketed by a spoofable
  // cf-connecting-ip, and NOT by req.socket (always the shared Caddy peer, so
  // a socket-IP bucket would merge every attacker into one allowance — strictly
  // worse than rejecting). off/log modes keep legacy behaviour unchanged
  // (isOriginVerified()===true under off; log-mode observability is emitted by
  // client-ip.ts, not here, to avoid a double warn and any bucketing change).
  if (config.ORIGIN_TRUST_MODE === "enforce" && !isOriginVerified(req)) {
    return null;
  }
  const cf = validCfIp(req.headers["cf-connecting-ip"]);
  if (cf !== undefined) return cf;

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

// Resolves the IP bucket max for the request based on the authenticated role
// (or API key / anon status). Session is already loaded by sessionLoader before
// this middleware runs (auth-chain.ts order: sessionLoader → rateLimit).
//
// Tier logic (evaluated in order):
//   verified admin  — role∈{admin,reviewer,super_admin} AND totpVerified===true
//                     → RATE_LIMIT_IP_VERIFIED_ADMIN (default 5000/min)
//                     This is a DoS ceiling only; the credential cap (20/min) and
//                     the per-user cap (300/min) are the meaningful constraints.
//   pre-MFA admin   — role∈{admin,reviewer,super_admin} AND totpVerified!==true
//                     → RATE_LIMIT_IP_ADMIN (default 100/min) — UNCHANGED from today.
//   candidate       — RATE_LIMIT_IP_USER (default 30/min)
//   API key         — RATE_LIMIT_IP_APIKEY (default 2000/min)
//   anon            — RATE_LIMIT_IP_ANON (default 30/min)
//
// Note: super_admin is included in the admin-role set so platform admins get
// the same tier as tenant admins after MFA verification.
//
// Fallback for unknown role strings is RATE_LIMIT_IP_USER (candidate tier) —
// conservative rather than permissive.
function resolveIpBucketMax(req: AuthRequest): number {
  if (req.session !== undefined) {
    const role = req.session.role;
    if (role === "admin" || role === "reviewer" || role === "super_admin") {
      // STRICT === equality: guards against undefined/null leaking through
      // the totpVerified field (e.g. old sessions without the field set).
      if (req.session.totpVerified === true) return config.RATE_LIMIT_IP_VERIFIED_ADMIN;
      // Pre-MFA admin: byte-identical to the behaviour before this redesign.
      return config.RATE_LIMIT_IP_ADMIN;
    }
    // Valid candidate session: lift the per-IP cap (campus lab behind one IP).
    // Mirrors the verified-admin lift above; per-user is the real limit.
    if (role === "candidate") return config.RATE_LIMIT_IP_CANDIDATE_SESSION;
    return config.RATE_LIMIT_IP_USER; // defensive fallback for unknown role string
  }
  if (req.apiKey !== undefined) return config.RATE_LIMIT_IP_APIKEY;
  return config.RATE_LIMIT_IP_ANON;
}

export interface RateLimitOptions {
  /**
   * When true, an additional per-route per-IP bucket
   * `aiq:rl:cred:<routePath>:<ip>` is enforced at config.RATE_LIMIT_CREDENTIAL
   * (default 20/min). This bucket ALWAYS applies regardless of session auth
   * tier — even verified admins hit it. Use on credential-handling endpoints
   * (TOTP verify, recovery, login email request/verify) so the verified-admin
   * IP lift does NOT weaken brute-force protection.
   */
  credentialEndpoint?: boolean;
  /**
   * Unauthenticated candidate magic-link entry route (POST /take/start,
   * POST /api/auth/candidate/verify-link). Swaps the general per-IP bucket for a
   * dedicated per-route per-IP bucket `aiq:rl:entry:<routePath>:<ip>` at
   * config.RATE_LIMIT_IP_CANDIDATE_ENTRY (default 2000/min) so a lab of 300
   * students behind one IP can all open their links. Safe because the token is
   * 256-bit random (brute force infeasible at 2000/min). Do NOT combine with
   * credentialEndpoint (that 20/min cap is exactly what this option avoids); do
   * NOT use for admin/OTP/TOTP credential routes.
   */
  candidateEntry?: boolean;
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}): AuthHook {
  return async (req, reply) => {
    const ip = extractRateLimitClientIp(req);

    // Fail-closed in production: cannot identify the caller, cannot enforce a
    // limit. CF-Connecting-IP is set by Cloudflare unconditionally on every
    // proxied request; absence means a direct origin hit (a deploy anomaly).
    if (ip === null && config.NODE_ENV === "production") {
      throw new RateLimitError("missing client IP for rate limit");
    }

    // Compose the active limits.
    const limits: Limit[] = [];

    // Fastify-matched route pattern (stable; see the no-req.url-fallback note below).
    const routePath = (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? "unknown";

    if (ip !== null) {
      if (opts.candidateEntry === true) {
        limits.push({
          key: `aiq:rl:entry:${routePath}:${ip}`,
          max: config.RATE_LIMIT_IP_CANDIDATE_ENTRY,
          windowSeconds: 60,
          scope: "ip",
        });
      } else {
        limits.push({
          key: `aiq:rl:ip:${ip}`,
          max: resolveIpBucketMax(req),
          windowSeconds: 60,
          scope: "ip",
        });
      }
    }

    // Credential-endpoint extra bucket: per-route per-IP cap at RATE_LIMIT_CREDENTIAL
    // (default 20/min). Inserted AFTER the IP bucket but BEFORE user/tenant/apiKey
    // so it appears alongside the general IP bucket in Promise.all. This bucket
    // ALWAYS applies regardless of session auth tier — even a verified-admin session
    // with the high IP cap (5000/min) still hits the 20/min credential cap.
    if (opts.credentialEndpoint === true && ip !== null) {
      // routePath (above) is the Fastify-matched route pattern (e.g. /api/auth/totp/verify) —
      // stable across all requests to the matched route.
      //
      // NO fallback to req.url (adversarial finding 3, 2026-05-20): req.url
      // includes query params, so an attacker varying the query (?a=1, ?a=2…)
      // would mint fresh per-query buckets and defeat the 20/min cap. If the
      // matched pattern is absent (shouldn't happen on a registered route, but
      // could on a wildcard/catch-all), all such requests share one "unknown"
      // bucket — strictly safer than an attacker-controlled key shape.
      limits.push({
        key: `aiq:rl:cred:${routePath}:${ip}`,
        max: config.RATE_LIMIT_CREDENTIAL,
        windowSeconds: 60,
        scope: "credential",
      });
    }

    if (req.session !== undefined) {
      // Per-user bucket: verified admins get a higher cap because they've passed MFA
      // and the per-user limit is the meaningful constraint at that tier (not IP).
      // Candidate sessions get RATE_LIMIT_USER_CANDIDATE (the real per-student cap
      // now that the IP bucket is lifted). Pre-MFA admin / unknown roles stay at 60.
      const role = req.session.role;
      const isAdminRole = role === "admin" || role === "reviewer" || role === "super_admin";
      const userMax = isAdminRole && req.session.totpVerified === true
        ? config.RATE_LIMIT_USER_VERIFIED_ADMIN
        : role === "candidate"
          ? config.RATE_LIMIT_USER_CANDIDATE
          : 60;
      limits.push({
        key: `aiq:rl:user:${req.session.userId}`,
        max: userMax,
        windowSeconds: 60,
        scope: "user",
      });
      limits.push({
        key: `aiq:rl:tenant:${req.session.tenantId}`,
        max: config.RATE_LIMIT_TENANT,
        windowSeconds: 60,
        scope: "tenant",
      });
    } else if (req.apiKey !== undefined) {
      limits.push({
        key: `aiq:rl:tenant:${req.apiKey.tenantId}`,
        max: config.RATE_LIMIT_TENANT,
        windowSeconds: 60,
        scope: "tenant",
      });
    }

    if (limits.length === 0) {
      // No IP available (non-production dev with no XFF) and no session/apiKey.
      // Nothing to enforce; return immediately.
      return;
    }

    // Evaluate all buckets in parallel — atomic per-bucket via Lua.
    // Promise.all stays parallel (not serial) per the implementation contract.
    const results = await Promise.all(limits.map(async (l) => ({ limit: l, result: await evalBucket(l) })));

    // Set standard headers from the most-constrained bucket.
    let mostConstrained = results[0]!;
    for (const r of results) {
      if (r.result.remaining < mostConstrained.result.remaining) mostConstrained = r;
    }
    setHeaders(reply, mostConstrained.limit.max, mostConstrained.result.remaining, mostConstrained.result.ttlSeconds, false);

    // Reject if ANY bucket is exhausted (remaining < 0).
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
export { extractRateLimitClientIp };
// Test export — resolveIpBucketMax for tier verification tests.
export { resolveIpBucketMax };
