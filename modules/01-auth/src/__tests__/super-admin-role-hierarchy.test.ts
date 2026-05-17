/**
 * Regression: backend role gate must honor the super_admin hierarchy.
 *
 * Incident (2026-05-17): a logged-in super_admin saw "role super_admin not
 * authorized" on the tenant dashboard. require-auth.ts:26 used an exact
 * `opts.roles.includes(sess.role)` check with NO hierarchy, so a super_admin
 * 403'd on every endpoint gated ['admin'] / ['reviewer'] (the entire tenant
 * admin surface). The frontend `RequireSession` already treats
 * super_admin > admin > reviewer > candidate; the documented slice-1 intent
 * (PROJECT_BRAIN / memory 1673) was the same. The backend never implemented it.
 *
 * Contract pinned here:
 *   - super_admin satisfies ANY role gate (it is the apex role).
 *   - The hierarchy is one-directional: only super_admin is the apex. A
 *     reviewer does NOT satisfy ['admin']; admin/reviewer/candidate do NOT
 *     satisfy ['super_admin'] — the explicit platform-only gate still excludes
 *     every non-super role (cross-tenant power stays super_admin-only).
 *   - super_admin's always-MFA invariant is enforced SEPARATELY (the TOTP
 *     gate, after the role check) — unchanged by this; verified-session used
 *     here so the role behaviour is isolated.
 *
 * Cross-tenant note: a super_admin session carries tenantId = platform tenant;
 * RLS confines every tenant-scoped query to that (empty) tenant. The dangerous
 * cross-tenant endpoints (/api/admin/super/*) take an explicit target tenantId
 * and are gated ['super_admin'] + freshMfaWithinMinutes — NOT affected here.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/require-auth.js";

function makeReq(role: string): Record<string, unknown> {
  return {
    session: {
      id: randomUUID(),
      userId: randomUUID(),
      tenantId: "00000000-0000-7000-0000-000000000001",
      role,
      totpVerified: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastTotpAt: new Date().toISOString(),
      ip: "10.0.0.1",
      ua: "UA",
    },
  };
}

describe("require-auth — super_admin role hierarchy", () => {
  // ---- super_admin is the apex: satisfies every gate -----------------------
  it("super_admin passes roles:['admin']", async () => {
    await expect(
      requireAuth({ roles: ["admin"] })(makeReq("super_admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });

  it("super_admin passes roles:['reviewer']", async () => {
    await expect(
      requireAuth({ roles: ["reviewer"] })(makeReq("super_admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });

  it("super_admin passes roles:['admin','reviewer']", async () => {
    await expect(
      requireAuth({ roles: ["admin", "reviewer"] })(makeReq("super_admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });

  it("super_admin passes roles:['candidate'] (full hierarchy, mirrors RequireSession)", async () => {
    await expect(
      requireAuth({ roles: ["candidate"] })(makeReq("super_admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });

  it("super_admin passes roles:['super_admin'] (unchanged)", async () => {
    await expect(
      requireAuth({ roles: ["super_admin"] })(makeReq("super_admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });

  // ---- hierarchy is one-directional: only super_admin is apex -------------
  it("admin does NOT satisfy roles:['super_admin'] (cross-tenant power stays super-only)", async () => {
    await expect(
      requireAuth({ roles: ["super_admin"] })(makeReq("admin") as never, {} as never),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });

  it("reviewer does NOT satisfy roles:['admin'] (no upward promotion for non-super)", async () => {
    await expect(
      requireAuth({ roles: ["admin"] })(makeReq("reviewer") as never, {} as never),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });

  it("candidate does NOT satisfy roles:['admin']", async () => {
    await expect(
      requireAuth({ roles: ["admin"] })(makeReq("candidate") as never, {} as never),
    ).rejects.toMatchObject({ name: "AuthzError" });
  });

  // ---- regression: normal exact matches still pass -----------------------
  it("admin passes roles:['admin'] (unchanged)", async () => {
    await expect(
      requireAuth({ roles: ["admin"] })(makeReq("admin") as never, {} as never),
    ).resolves.toBeUndefined();
  });
});
