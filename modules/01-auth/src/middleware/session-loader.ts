import { config, AuthnError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { sessions, isIdleExpired } from "../sessions.js";
import type { AuthHook } from "./types.js";
// TenantStatusRow is a local interface — session-loader must not import from
// 02-tenancy/src/lifecycle.ts (that would create a circular dep path via
// @assessiq/tenancy). The tenant status query here mirrors assertTenantActive
// but runs under app-role RLS (withinTenant) rather than system role, since
// we already have a tenant context from the session cookie.

// Reads the aiq_sess cookie, looks up the session via Redis, applies the
// idle-eviction cutoff, and (defense-in-depth per 03-users carry-forward)
// rejects if the user record is disabled or soft-deleted. Populates
// req.session on success, leaves it undefined on miss.
//
// This middleware does NOT enforce auth — that's requireAuth's job. It only
// loads the session if one is present so downstream routes can decide.
//
// Spec sources:
//   - modules/01-auth/SKILL.md § Decisions captured §§ 1, 9
//   - docs/04-auth-flows.md § Session cookie spec (lines 84-89)
//   - docs/SESSION_STATE.md § 03-users carry-forward
//     ("sessionLoader rejects on users.status != 'active' and on
//      users.deleted_at IS NOT NULL")

interface UserStatusRow {
  status: string;
  deleted_at: string | null;
}

interface TenantStatusRow {
  status: string;
}

async function userIsActive(tenantId: string, userId: string): Promise<boolean> {
  // Defense-in-depth: even if Redis sweep-on-disable missed a session,
  // the Postgres status check fails-closed.
  //
  // Note: in Phase 0 the `users` table belongs to 03-users (Window 5).
  // Until that ships, this query throws "relation users does not exist"
  // at runtime. sessionLoader is library code — never executed until the
  // route layer (Phase 1+) wires it. The check is implemented now so
  // the integration is type-safe and ready when 03-users lands.
  return withTenant(tenantId, async (client: PoolClient) => {
    const result = await client.query<UserStatusRow>(
      `SELECT status, deleted_at FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    return row.status === "active" && row.deleted_at === null;
  });
}

// Defense-in-depth: verify the tenant is still active on every authenticated
// request. Complements the userIsActive check — a suspended/archived tenant
// should block ALL its users, even if individual user rows are still 'active'.
//
// Uses withTenant (assessiq_app role, RLS-scoped) because we already have a
// valid tenantId from the session cookie. This is safe: if the tenants row is
// invisible due to a misconfigured RLS policy, the function returns false and
// the session is rejected (fail-closed — same philosophy as userIsActive).
//
// Allowed: 'active' and 'provisioning' (createTenant orchestration window).
// All other statuses (suspended, archived) → false → session destroyed.
async function tenantIsActive(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (client: PoolClient) => {
    const result = await client.query<TenantStatusRow>(
      `SELECT status FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    return row.status === "active" || row.status === "provisioning";
  });
}

interface SessionLoaderOptions {
  // Skip the user-status check. Used in unit tests that don't ship the
  // users table fixture. Production NEVER sets this true; the loader
  // factory gates on NODE_ENV when the option is requested.
  skipUserStatusCheck?: boolean;
}

export function sessionLoaderMiddleware(opts: SessionLoaderOptions = {}): AuthHook {
  if (opts.skipUserStatusCheck === true && config.NODE_ENV === "production") {
    throw new Error("sessionLoaderMiddleware: skipUserStatusCheck is not allowed in production");
  }

  return async (req, _reply) => {
    const cookieName = config.SESSION_COOKIE_NAME;
    const token = req.cookies?.[cookieName];
    if (token === undefined || token.length === 0) return;

    const session = await sessions.get(token);
    if (session === null) return;

    if (isIdleExpired(session)) {
      await sessions.destroy(token);
      return;
    }

    // Lifecycle checks below are POINT-IN-TIME at session-load. If the operator
    // suspends a tenant or disables a user mid-request — between this guard
    // and the route handler — the handler will still complete its work for
    // that one request. Lifecycle transitions are infrequent and revoke
    // sessions atomically with the status flip, so the next request is
    // guaranteed to fail. Acceptable per Phase A architectural principles;
    // Phase B/C lifecycle endpoints document this as the contract.
    //
    // Error-message hygiene: the throws below carry a generic message and
    // route the scope (user vs tenant) through `details.scope`. The frontend
    // (Phase D) picks the right copy via `details.scope` — `code` and the
    // raw message are never displayed to the user. This prevents a
    // cookie-holding attacker from distinguishing "my account was disabled"
    // from "my company was suspended" via the error string itself.
    if (opts.skipUserStatusCheck !== true) {
      // User check runs FIRST — a disabled user should receive a user-scope
      // error, not a tenant-scope error (per Phase A architectural principle #4).
      try {
        const active = await userIsActive(session.tenantId, session.userId);
        if (!active) {
          await sessions.destroy(token);
          throw new AuthnError("session rejected", {
            details: { scope: "user", reason: "inactive" },
          });
        }
      } catch (err) {
        if (err instanceof AuthnError) throw err;
        // Phase 0 fall-through: until 03-users ships the users table, the
        // SELECT throws "relation users does not exist". The session
        // loader cannot make a security decision without that data, so
        // we fail-closed here too — log and reject.
        req.log?.warn(
          { err, kind: "session-loader-user-check-failed", userId: session.userId, tenantId: session.tenantId },
          "session loader user-status check failed; rejecting session",
        );
        throw new AuthnError("session rejected", {
          details: { scope: "user", reason: "check_failed" },
        });
      }

      // Tenant check runs SECOND (defense-in-depth): even if the user is
      // individually active, a suspended or archived tenant blocks all sessions.
      // skipUserStatusCheck gates both checks together (dev/test scaffolding).
      try {
        const tenantActive = await tenantIsActive(session.tenantId);
        if (!tenantActive) {
          await sessions.destroy(token);
          throw new AuthnError("session rejected", {
            details: { scope: "tenant", reason: "inactive" },
          });
        }
      } catch (err) {
        if (err instanceof AuthnError) throw err;
        req.log?.warn(
          { err, kind: "session-loader-tenant-check-failed", tenantId: session.tenantId },
          "session loader tenant-status check failed; rejecting session",
        );
        throw new AuthnError("session rejected", {
          details: { scope: "tenant", reason: "check_failed" },
        });
      }
    }

    req.session = {
      id: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      role: session.role,
      totpVerified: session.totpVerified,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      lastTotpAt: session.lastTotpAt,
    };
  };
}
