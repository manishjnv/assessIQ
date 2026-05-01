import { config, AuthnError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { sessions, isIdleExpired } from "../sessions.js";
import type { AuthHook } from "./types.js";

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

    if (opts.skipUserStatusCheck !== true) {
      try {
        const active = await userIsActive(session.tenantId, session.userId);
        if (!active) {
          await sessions.destroy(token);
          throw new AuthnError("user disabled or deleted");
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
        throw new AuthnError("user status check failed");
      }
    }

    req.session = {
      id: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      role: session.role,
      totpVerified: session.totpVerified,
      expiresAt: session.expiresAt,
      lastTotpAt: session.lastTotpAt,
    };
  };
}
