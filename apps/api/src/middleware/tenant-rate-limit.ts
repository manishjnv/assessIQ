import type { preHandlerHookHandler } from "fastify";
import { consumeRateLimit } from "@assessiq/auth";
import { AuthzError, RateLimitError } from "@assessiq/core";

/**
 * Per-tenant throttle for heavy admin operations (exports). Runs AFTER the auth
 * chain, so the session already exists. ponytail: fixed window, one bucket per
 * `name` + tenant; add a sliding window only if bursts at the boundary matter.
 */
export function tenantRateLimit(opts: { name: string; max: number; windowSeconds: number }): preHandlerHookHandler {
  return async (req, reply) => {
    const tenantId = (req as unknown as { session?: { tenantId?: string } }).session?.tenantId;
    // Fail closed: this guard belongs after a session-bearing auth chain. Mounted elsewhere
    // (API-key principals, public routes) it must not silently skip the limit.
    if (!tenantId) throw new AuthzError("tenant rate limit needs a session");
    const { allowed, retryAfterSeconds } = await consumeRateLimit(
      `aiq:rl:tenant-op:${opts.name}:${tenantId}`,
      opts.max,
      opts.windowSeconds,
    );
    if (allowed) return;
    reply.header("Retry-After", Math.max(1, retryAfterSeconds));
    throw new RateLimitError(`Too many ${opts.name} requests for this organisation; try again later`, {
      details: { retryAfterSeconds, scope: "tenant-op" },
    });
  };
}
