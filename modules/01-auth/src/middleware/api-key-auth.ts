import { AuthnError, RateLimitError, config } from "@assessiq/core";
import { apiKeys } from "../api-keys.js";
import { consumeRateLimit, extractRateLimitClientIp, isRateLimited } from "./rate-limit.js";
import type { AuthHook } from "./types.js";

// Reads `Authorization: Bearer aiq_live_<...>`, looks up the API key via
// `apiKeys.authenticate` (system-role lookup, audited via the api_key id),
// populates req.apiKey. Throws AuthnError on miss / revoked / expired.
//
// The session-cookie path and the API-key path are mutually exclusive in
// practice — but if both are present, the session takes precedence (this
// middleware is registered AFTER sessionLoader).

const PREFIX = "Bearer aiq_live_";
// aiq_live_ + 43 base62 chars (api-keys.ts). A cheap shape check keeps junk off the DB.
const KEY_SHAPE = /^Bearer aiq_live_[0-9A-Za-z]{43}$/;
// GATE-8 A2-4: failed lookups per IP per minute before the DB lookup is refused.
const FAIL_MAX = 20;

export const apiKeyAuthMiddleware: AuthHook = async (req, _reply) => {
  if (req.session !== undefined) return; // session takes precedence

  const auth = req.headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (typeof value !== "string") return;
  if (!value.startsWith(PREFIX.slice(0, 7))) return; // not Bearer at all
  if (!value.startsWith(PREFIX)) {
    // Bearer prefix present but not aiq_live_ — reject to avoid silent
    // accept of malformed tokens.
    throw new AuthnError("invalid api key prefix");
  }

  if (!KEY_SHAPE.test(value)) throw new AuthnError("invalid api key");

  // Per-IP failure brake BEFORE the system-role lookup (the system pool is tiny). Fail closed
  // in production when the client IP is unknown, like rateLimitMiddleware.
  const ip = extractRateLimitClientIp(req);
  if (ip === null && config.NODE_ENV === "production") {
    throw new RateLimitError("missing client IP for rate limit");
  }
  const failKey = ip === null ? null : `aiq:rl:apikey-fail:${ip}`;
  if (failKey !== null && (await isRateLimited(failKey, FAIL_MAX))) {
    throw new RateLimitError("too many invalid api keys");
  }

  const plaintext = value.slice("Bearer ".length);
  let record;
  try {
    record = await apiKeys.authenticate(plaintext);
  } catch (err) {
    if (failKey !== null && err instanceof AuthnError) await consumeRateLimit(failKey, FAIL_MAX, 60);
    throw err;
  }
  req.apiKey = {
    id: record.id,
    tenantId: record.tenantId,
    scopes: record.scopes,
  };
};
