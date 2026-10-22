/**
 * GATE-8 A2-4: apiKeyAuthMiddleware rejects malformed keys before any DB call and
 * brakes repeated failed lookups per IP before the system-role lookup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthnError, RateLimitError } from "@assessiq/core";

const { authenticate, isRateLimited, consumeRateLimit } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  isRateLimited: vi.fn(),
  consumeRateLimit: vi.fn(),
}));
vi.mock("../api-keys.js", () => ({ apiKeys: { authenticate } }));
vi.mock("../middleware/rate-limit.js", () => ({
  isRateLimited,
  consumeRateLimit,
  extractRateLimitClientIp: () => "1.2.3.4",
}));

import { apiKeyAuthMiddleware } from "../middleware/api-key-auth.js";

const GOOD = `Bearer aiq_live_${"a".repeat(43)}`;
const run = (authorization?: string) =>
  apiKeyAuthMiddleware({ headers: { authorization } } as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  isRateLimited.mockResolvedValue(false);
  consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 60 });
});

describe("apiKeyAuthMiddleware", () => {
  it("rejects a malformed key without touching the DB or Redis", async () => {
    await expect(run("Bearer aiq_live_junk")).rejects.toBeInstanceOf(AuthnError);
    await expect(run(`Bearer aiq_live_${"a".repeat(44)}`)).rejects.toBeInstanceOf(AuthnError);
    expect(authenticate).not.toHaveBeenCalled();
    expect(isRateLimited).not.toHaveBeenCalled();
  });

  it("refuses the lookup once the IP is over the failure cap", async () => {
    isRateLimited.mockResolvedValue(true);
    await expect(run(GOOD)).rejects.toBeInstanceOf(RateLimitError);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("counts a failed lookup and rethrows", async () => {
    authenticate.mockRejectedValue(new AuthnError("invalid, revoked, or expired api key"));
    await expect(run(GOOD)).rejects.toBeInstanceOf(AuthnError);
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
  });

  it("a valid key sets req.apiKey and counts nothing", async () => {
    authenticate.mockResolvedValue({ id: "k1", tenantId: "t1", scopes: ["x"] });
    const req = { headers: { authorization: GOOD } } as { headers: object; apiKey?: unknown };
    await apiKeyAuthMiddleware(req as never, {} as never);
    expect(req.apiKey).toEqual({ id: "k1", tenantId: "t1", scopes: ["x"] });
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });
});
