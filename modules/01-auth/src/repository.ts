// modules/01-auth/src/repository.ts
//
// RW-36(a): SQL moved out of apps/api routes. Every function takes the
// PoolClient of an enclosing withTenant() transaction, so RLS context and
// transaction scope are decided by the caller exactly as before.

import type { PoolClient } from "pg";

/**
 * Drop a user's Google oauth_identities link (used when a super-admin changes
 * the user's email, i.e. the login identity).
 */
export async function deleteGoogleIdentitiesForUser(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM oauth_identities WHERE user_id = $1 AND provider = 'google'`,
    [userId],
  );
}

/**
 * Mark one embed secret revoked. Returns the affected row count (0 = not found
 * or already revoked).
 */
export async function revokeEmbedSecretRow(
  client: PoolClient,
  id: string,
  tenantId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE embed_secrets
           SET status = 'revoked'
           WHERE id = $1 AND tenant_id = $2 AND status != 'revoked'`,
    [id, tenantId],
  );
  return result.rowCount ?? 0;
}
