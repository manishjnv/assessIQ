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

interface RateLimitOptions {
  // For Phase 0 we tune the limits via constants per the addendum. The opts
  // object exists so a future per-route override can pass tighter limits.
  authPathPrefix?: string; // default "/api/auth/"
}

export function rateLimitMiddleware(opts: RateLimitOptions = {}): AuthHook {
  const authPrefix = opts.authPathPrefix ?? "/api/auth/";

  return async (req, reply) => {
    const url = req.url ?? "";
    const isAuthRoute = url.startsWith(authPrefix);

    // Compose the active limits.
    const limits: Limit[] = [];

    if (isAuthRoute) {
      const ip = extractClientIp(req);
      // No CF-Connecting-IP and not in dev → reject at edge.
      if (ip === null) {
        // Fail-closed: cannot identify the caller, cannot enforce a limit.
        // The CF header is set by Cloudflare unconditionally on every
        // proxied request; absence means a direct origin hit, which is
        // already a deploy anomaly.
        throw new RateLimitError("missing client IP for /api/auth/* rate limit");
      }
      limits.push({
        key: `aiq:rl:auth:ip:${ip}`,
        max: 10,
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

    if (limits.length === 0) return; // unauth public route, no enforcement

    // Evaluate all buckets in parallel — atomic per-bucket via Lua.
    const results = await Promise.all(limits.map(async (l) => ({ limit: l, result: await evalBucket(l) })));

    // Set headers using the most-constrained bucket (lowest remaining).
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
export { extractClientIp };
