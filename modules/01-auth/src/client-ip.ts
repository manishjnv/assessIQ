// client-ip.ts — centralized client-IP extraction with origin-verify protection.
//
// Threat mitigated: production topology is Cloudflare → Caddy → Fastify.
// The origin IP :443 is directly reachable. Without validation, an attacker
// hitting the origin directly can spoof cf-connecting-ip, defeating per-IP rate
// limits and IP-bound session tokens. The ORIGIN_VERIFY_SECRET shared-secret
// mechanism proves the request traversed Cloudflare before we trust the CF header.
//
// Modes (controlled by ORIGIN_TRUST_MODE in config):
//   off     — legacy: return cf-connecting-ip ?? req.ip (zero behavior change).
//   log     — same return value; emit a structured warn on unverified requests.
//   enforce — only return cf-connecting-ip when x-origin-verify constant-time-
//             equals ORIGIN_VERIFY_SECRET; otherwise fall back to raw socket IP.
//
// NEVER THROWS. All errors are caught; worst case returns req.ip or '0.0.0.0'.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { config, streamLogger } from "@assessiq/core";

const log = streamLogger("auth");

// Structurally-typed request shape — accepts the raw Fastify request, the
// module's structural AuthRequest, AND plain test mocks. `headers` is a union
// of node's IncomingHttpHeaders (= FastifyRequest['headers'] default; type-only
// import, zero runtime fastify coupling) and a plain Record (AuthRequest /
// unit-test mocks) so all three call surfaces are assignable.
//
// `socket` is deliberately NOT part of this structural contract: Fastify's
// net.Socket types remoteAddress as `string | undefined`, which is not
// assignable to any fixed-shape `socket` field and makes every raw-Fastify
// call site fail TS2345. We read socket.remoteAddress via a localized,
// fully-guarded cast inside extractClientIp instead (always under the
// never-throw try, so an absent/odd socket can never crash a request).
interface ClientIpRequest {
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * Normalise a header value that may be string | string[] | undefined.
 * Returns the first string value, or undefined.
 */
function headerStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed to fixed-length 32-byte SHA-256 digests before the
 * timing-safe compare, so the comparison time is independent of BOTH the
 * attacker-supplied input length AND the secret length — there is no
 * length-mismatch branch and therefore no length-oracle surface at all
 * (adversarial finding 5; supersedes the earlier dummy-buffer approach whose
 * dummy was sized to the attacker-controlled input, not the secret).
 *
 * Never uses `===` for secret comparison. createHash/digest do not throw on
 * string input, and the function is only ever called inside isOriginVerified's
 * try/catch regardless.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * Pure predicate: did this request provably traverse Cloudflare?
 *
 * SINGLE SOURCE OF TRUTH for the x-origin-verify shared-secret check —
 * consumed by extractClientIp() below AND by the rate-limit middleware
 * (modules/01-auth/src/middleware/rate-limit.ts) so the trust decision is
 * implemented exactly once (no duplicated crypto / drift between the two).
 *
 *  - mode "off":            always true (legacy: every request treated as
 *                           trusted; preserves the zero-behaviour-change
 *                           default so deploy at off is a pure no-op).
 *  - mode "log" / "enforce": true iff ORIGIN_VERIFY_SECRET is configured AND
 *                           the x-origin-verify header constant-time-equals it.
 *
 * NEVER THROWS. On unexpected error it is fail-closed (false) in log/enforce;
 * the off branch short-circuits before the try body can throw.
 */
export function isOriginVerified(req: ClientIpRequest): boolean {
  try {
    const mode = config.ORIGIN_TRUST_MODE;
    if (mode === "off") return true;
    const secret = headerStr(req.headers["x-origin-verify"]);
    const configSecret = config.ORIGIN_VERIFY_SECRET;
    return (
      configSecret != null &&
      secret != null &&
      timingSafeEqualStr(secret, configSecret)
    );
  } catch {
    return config.ORIGIN_TRUST_MODE === "off";
  }
}

/**
 * Extract the canonical client IP from a request.
 *
 * - mode "off":     return cf-connecting-ip ?? req.ip  (byte-identical to
 *                   the old inline expression at every call site).
 * - mode "log":     same return value; emit a structured warn when the
 *                   x-origin-verify header is absent or mismatched.
 * - mode "enforce": return cf-connecting-ip only when x-origin-verify
 *                   constant-time-equals ORIGIN_VERIFY_SECRET; otherwise
 *                   return raw socket IP and ignore cf / xff.
 *
 * NEVER THROWS. Any exception returns req.ip ?? '0.0.0.0'.
 */
export function extractClientIp(req: ClientIpRequest): string {
  try {
    const mode = config.ORIGIN_TRUST_MODE;
    const cf = headerStr(req.headers["cf-connecting-ip"]);

    if (mode === "off") {
      // Byte-identical to the old inline expression:
      //   (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip
      return cf ?? req.ip ?? "0.0.0.0";
    }

    // mode === "log" or "enforce"
    // `secret` retained only for the log-mode `hasSecretHeader` flag below;
    // the trust decision itself is delegated to the shared predicate so the
    // crypto check exists in exactly one place.
    const secret = headerStr(req.headers["x-origin-verify"]);
    const verified = isOriginVerified(req);

    if (mode === "log") {
      if (!verified) {
        // Emit exactly ONE structured warning. Secret value is never included.
        log.warn(
          { event: "origin-unverified", hasSecretHeader: secret != null },
          "request missing or failed x-origin-verify header",
        );
      }
      // log mode: NEVER changes the returned IP — same as off.
      return cf ?? req.ip ?? "0.0.0.0";
    }

    // mode === "enforce"
    if (verified) {
      return cf ?? req.ip ?? "0.0.0.0";
    }

    // Unverified in enforce mode: use raw socket IP, never cf / xff.
    // socket is read via a localized cast (not in the structural param type —
    // see ClientIpRequest comment). Guarded by the enclosing try/never-throw.
    const socketIp = (req as { socket?: { remoteAddress?: string } }).socket
      ?.remoteAddress;
    return socketIp ?? req.ip ?? "0.0.0.0";
  } catch {
    // NEVER THROW — an exception here would crash every request.
    return req.ip ?? "0.0.0.0";
  }
}
