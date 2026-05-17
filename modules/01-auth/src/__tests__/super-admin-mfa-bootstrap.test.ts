/**
 * Regression tests for the super-admin first-login MFA bootstrap lockout.
 *
 * Incident (2026-05-17): a freshly-provisioned super_admin could complete
 * Google SSO but could NEVER reach /admin/mfa to enrol/verify TOTP, because:
 *
 *   #1 require-auth.ts forced requireTotp=true for super_admin UNCONDITIONALLY,
 *      overriding the explicit `requireTotpVerified:false` that /api/auth/whoami
 *      and the TOTP-bootstrap routes set by design. Pre-TOTP super_admin → 401
 *      at whoami → SPA bounces to /admin/login. Chicken-and-egg lockout.
 *
 *   #2 the four TOTP bootstrap routes were gated roles:['admin','reviewer'];
 *      the backend role check is an exact includes() — super_admin is NOT a
 *      member, so even reaching the page would 403 on enrol/verify.
 *
 * These tests pin the gate-level contract of the coordinated fix:
 *
 *   - An EXPLICIT `requireTotpVerified:false` (only the read-only state-probe
 *     routes set it) is honored even for super_admin → pre-TOTP super_admin
 *     can reach whoami / TOTP-bootstrap so MFA can ever be completed.
 *   - With NO explicit flag (every cross-tenant ACTION route) super_admin
 *     STILL requires totpVerified=true — the always-MFA invariant is intact.
 *   - An explicit fresh-MFA demand (freshMfaWithinMinutes) is NEVER bypassed
 *     by the opt-out — defense-in-depth even against a future misconfig.
 *   - super_admin must be an explicit member of `roles[]` to pass the role
 *     gate (backend requireAuth has no role hierarchy — proves #2 is needed).
 *
 * Pure in-process middleware tests — no containers.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/require-auth.js";

const PLATFORM_TENANT_ID = "00000000-0000-7000-0000-000000000001";

function makeReq(
  sessionOverrides: Partial<{
    role: string;
    totpVerified: boolean;
    lastTotpAt: string | null;
  }>,
): Record<string, unknown> {
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

describe("super-admin MFA bootstrap — require-auth gate contract", () => {
  // ---- Defect #1: explicit opt-out must be honored for super_admin ---------

  it("A. pre-TOTP super_admin + explicit requireTotpVerified:false + super_admin in roles → PASSES (whoami / TOTP-bootstrap reachable)", async () => {
    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({
      roles: ["admin", "reviewer", "super_admin"],
      requireTotpVerified: false,
    });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  it("B. pre-TOTP super_admin + NO explicit flag (action-route default) → STILL throws 'totp verification required' (always-MFA invariant intact)", async () => {
    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({ roles: ["super_admin"] });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "totp verification required",
    });
  });

  it("C. super_admin + requireTotpVerified:false BUT freshMfaWithinMinutes set + no lastTotpAt → STILL throws 'fresh totp required' (opt-out never bypasses an explicit fresh-MFA demand)", async () => {
    const req = makeReq({
      role: "super_admin",
      totpVerified: false,
      lastTotpAt: null,
    });
    const hook = requireAuth({
      roles: ["super_admin"],
      requireTotpVerified: false,
      freshMfaWithinMinutes: 15,
    });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthnError",
      message: "fresh totp required",
    });
  });

  // ---- Defect #2: backend role gate has no hierarchy ----------------------

  it("D. pre-TOTP super_admin + requireTotpVerified:false + roles:['admin','reviewer'] → PASSES (superseded 2026-05-17 by the role hierarchy)", async () => {
    // SUPERSEDED, intentionally: this case originally asserted AuthzError —
    // back when the backend role gate was exact includes() with no hierarchy,
    // so super_admin had to be an EXPLICIT member of every roles[] (Defect #2
    // of the MFA-lockout RCA; why 'super_admin' was added to the 4 TOTP
    // routes). The later same-day fix made super_admin the apex role that
    // satisfies ANY gate (see super-admin-role-hierarchy.test.ts), which
    // makes the explicit-member requirement moot and the explicit additions
    // in totp.ts redundant-but-harmless. The correct contract now: a pre-TOTP
    // super_admin on a route with requireTotpVerified:false passes regardless
    // of which non-super roles the route lists. This is exactly what fixes the
    // "role super_admin not authorized" dashboard error.
    const req = makeReq({ role: "super_admin", totpVerified: false });
    const hook = requireAuth({
      roles: ["admin", "reviewer"],
      requireTotpVerified: false,
    });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  // ---- Regression: normal pre-MFA bootstrap unchanged ---------------------

  it("E. pre-MFA admin (non-super) + requireTotpVerified:false → PASSES (existing first-login bootstrap behaviour unchanged)", async () => {
    const req = makeReq({ role: "admin", totpVerified: false });
    const hook = requireAuth({
      roles: ["admin", "reviewer"],
      requireTotpVerified: false,
    });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  it("F. verified super_admin + explicit requireTotpVerified:false → PASSES (no weakening; verified always allowed on probe routes)", async () => {
    const req = makeReq({
      role: "super_admin",
      totpVerified: true,
      lastTotpAt: new Date().toISOString(),
    });
    const hook = requireAuth({
      roles: ["admin", "reviewer", "super_admin"],
      requireTotpVerified: false,
    });
    await expect(hook(req as never, {} as never)).resolves.toBeUndefined();
  });

  it("G. candidate hitting a TOTP route (roles[] excludes candidate) + requireTotpVerified:false → AuthzError (role gate runs BEFORE the TOTP opt-out; opt-out is not a role bypass)", async () => {
    const req = makeReq({ role: "candidate", totpVerified: false });
    const hook = requireAuth({
      roles: ["admin", "reviewer", "super_admin"],
      requireTotpVerified: false,
    });
    await expect(hook(req as never, {} as never)).rejects.toMatchObject({
      name: "AuthzError",
    });
  });
});
