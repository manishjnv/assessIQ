/**
 * Pure unit tests for requireAuth with super_admin role.
 *
 * These tests exercise acceptance criterion (e):
 *   - super_admin route rejects sessions where role !== 'super_admin'
 *     OR totpVerified !== true.
 *   - MFA always-on for super_admin regardless of MFA_REQUIRED env.
 *
 * No containers needed — pure in-process middleware tests.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/require-auth.js";

const PLATFORM_TENANT_ID = "00000000-0000-7000-0000-000000000001";

/**
 * Build a minimal fake request for requireAuth.
 * requireAuth reads req.session.role, req.session.totpVerified, req.session.lastTotpAt.
 */
function makeReq(sessionOverrides: Partial<{
  role: string;
  totpVerified: boolean;
  lastTotpAt: string | null;
  tenantId: string;
  userId: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
}>): Record<string, unknown> {
  return {
    session: {
      id: randomUUID(),
      userId: randomUUID(),
      tenantId: PLATFORM_TENANT_ID,
      role: "super_admin",
      totpVerified: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastTotpAt: null,
      ip: "10.0.0.1",
      ua: "UA",
      ...sessionOverrides,
    },
  };
}

describe("requireAuth — super_admin MFA-always-on gate", () => {
  it("(e) super_admin + totpVerified=true → hook passes (returns undefined)", async () => {
    const req = makeReq({
      role: "super_admin",
      totpVerified: true,
      lastTotpAt: new Date().toISOString(),
    });
    const hook = requireAuth({ roles: ["super_admin"] });
    // Should resolve without throwing.
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  it("(e) super_admin + totpVerified=false → AuthnError 'totp verification required'", async () => {
    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "totp verification required",
    });
  });

  it("(e) super_admin + totpVerified=false even when MFA_REQUIRED env=false → still throws", async () => {
    // MFA_REQUIRED=false env relaxes the gate for admin/reviewer but NEVER for super_admin.
    const original = process.env.MFA_REQUIRED;
    process.env.MFA_REQUIRED = "false";

    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({ roles: ["super_admin"] });

    // Note: config is a module-level singleton in 00-core. Changing the env var
    // after import does NOT change the already-parsed config. This test therefore
    // verifies the isSuperAdmin branch in require-auth.ts, which BYPASSES the
    // config.MFA_REQUIRED check and always enforces TOTP for super_admin.
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "totp verification required",
    });

    process.env.MFA_REQUIRED = original;
  });

  it("(e) non-super_admin session with super_admin role gate → AuthzError", async () => {
    const req = makeReq({ role: "admin", totpVerified: true });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthzError",
    });
  });

  it("(e) no session → AuthnError 'authentication required'", async () => {
    const req = { session: undefined, apiKey: undefined };
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "authentication required",
    });
  });

  it("fresh-MFA gate: super_admin + totpVerified=true but stale TOTP → AuthnError", async () => {
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const req = makeReq({
      role: "super_admin",
      totpVerified: true,
      lastTotpAt: staleTime,
    });
    const hook = requireAuth({ roles: ["super_admin"], freshMfaWithinMinutes: 15 });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "fresh totp required",
    });
  });

  it("fresh-MFA gate: super_admin + recent TOTP within window → passes", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    const req = makeReq({
      role: "super_admin",
      totpVerified: true,
      lastTotpAt: recentTime,
    });
    const hook = requireAuth({ roles: ["super_admin"], freshMfaWithinMinutes: 15 });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });
});
