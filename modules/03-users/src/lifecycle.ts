// AssessIQ — modules/03-users/src/lifecycle.ts
//
// Phase A lifecycle helpers for user-level status enforcement.
// These are read-only assertion functions; they have no side effects.

import { NotFoundError, ConflictError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";

interface UserLifecycleRow {
  status: string;
  deleted_at: string | null;
}

/**
 * Assert that a user exists, is active, and has not been soft-deleted.
 *
 * Runs inside a `withTenant(tenantId, ...)` transaction so RLS scopes the
 * lookup to the correct tenant — same pattern as `userIsActive` in
 * `modules/01-auth/src/middleware/session-loader.ts`.
 *
 * Throws:
 *   - NotFoundError  { code: 'USER_NOT_FOUND' }                           — user row absent
 *   - ConflictError  { code: 'USER_NOT_ACTIVE', status, deleted_at }      — status != 'active' OR soft-deleted
 * Returns: void on success.
 */
export async function assertUserActive(
  userId: string,
  tenantId: string,
): Promise<void> {
  await withTenant(tenantId, async (client: PoolClient) => {
    const result = await client.query<UserLifecycleRow>(
      `SELECT status, deleted_at FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      throw new NotFoundError(`user not found`, {
        details: { code: "USER_NOT_FOUND", userId },
      });
    }

    if (row.status !== "active" || row.deleted_at !== null) {
      // Generic message — internal status only in details (safe for admin
      // contexts; never surfaced to the user per Phase D messaging rules).
      throw new ConflictError(`user is not in a writable state`, {
        details: {
          code: "USER_NOT_ACTIVE",
          status: row.status,
          deleted_at: row.deleted_at,
          userId,
        },
      });
    }
  });
}
