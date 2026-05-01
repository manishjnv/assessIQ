import type { PoolClient } from 'pg';
import { ConflictError, ValidationError } from '@assessiq/core';
import type { UserStatus } from './types.js';

/**
 * Asserts that the target user is NOT the last active admin in the tenant.
 *
 * Runs the SQL from addendum § 4 verbatim — using FOR NO KEY UPDATE to
 * prevent concurrent demotions of other admins while this transaction is open.
 * The caller must pass a PoolClient already inside a withTenant transaction;
 * RLS scopes the count to the current tenant automatically (no WHERE tenant_id).
 *
 * Throws ConflictError with details.code = 'LAST_ADMIN' if count is 0.
 *
 * @param client - PoolClient inside an active withTenant transaction.
 * @param targetUserId - The user being mutated (excluded from the count).
 * @param mutationKind - Discriminant for the error details (audit/display).
 */
export async function assertNotLastAdmin(
  client: PoolClient,
  targetUserId: string,
  mutationKind: 'softDelete' | 'roleChange' | 'statusChange',
): Promise<void> {
  // NOTE: no WHERE tenant_id — RLS scopes the count to the current tenant.
  // Postgres rejects `SELECT count(*) ... FOR NO KEY UPDATE` (aggregates +
  // row locks not allowed in the same query). We split into two steps via a
  // CTE: lock the candidate admin rows first, then count over the locked set.
  // Both steps run in the same statement so the lock is held across the count
  // for the rest of the surrounding withTenant transaction. This preserves
  // the TOCTOU protection from addendum § 4 while satisfying Postgres's
  // grammar restriction.
  const result = await client.query<{ count: string }>(
    `WITH locked_admins AS (
       SELECT id FROM users
        WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
          AND id <> $1
        FOR NO KEY UPDATE
     )
     SELECT count(*)::text AS count FROM locked_admins`,
    [targetUserId],
  );
  const row = result.rows[0];
  const count = row !== undefined ? parseInt(row.count, 10) : 0;

  if (count === 0) {
    throw new ConflictError(
      'Cannot remove or disable the last active admin in this tenant. Promote another user to admin first.',
      { details: { code: 'LAST_ADMIN', mutationKind, userId: targetUserId } },
    );
  }
}

/**
 * Validates a user status transition against the allowed state machine from addendum § 7.
 *
 * Allowed transitions:
 *   pending  → active    (via acceptInvitation only — enforced at call site)
 *   pending  → disabled  (admin revoke-before-accept)
 *   active   → disabled  (admin toggle)
 *   disabled → active    (admin re-enable)
 *
 * Forbidden:
 *   disabled → pending   (not reachable — admin must re-invite from scratch)
 *   active   → pending   (not reachable — invitation is one-shot)
 *
 * Throws ValidationError with details.code = 'INVALID_STATUS_TRANSITION' for
 * any disallowed transition.
 */
export function assertValidStatusTransition(from: UserStatus, to: UserStatus): void {
  const allowed: ReadonlySet<string> = new Set([
    'pending→active',
    'pending→disabled',
    'active→disabled',
    'disabled→active',
  ]);

  if (!allowed.has(`${from}→${to}`)) {
    throw new ValidationError(
      `Status transition from '${from}' to '${to}' is not allowed.`,
      { details: { code: 'INVALID_STATUS_TRANSITION', from, to } },
    );
  }
}
