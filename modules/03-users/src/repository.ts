/**
 * Repository layer for the users and user_invitations tables.
 *
 * IMPORTANT — RLS-only scoping (CLAUDE.md hard rule #4 + addendum § 11):
 * Every query here runs through a PoolClient whose connection has already
 * received `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant',
 * $tenantId, true)` from withTenant(). Row-Level Security enforces tenant
 * isolation at the Postgres layer. Adding `WHERE tenant_id = $1` filters here
 * would mask RLS bugs — a misconfigured role with BYPASSRLS would still return
 * correct rows because of the WHERE, silently breaking the RLS guarantee.
 * Do NOT add tenant_id filters to any query in this file.
 *
 * Exception: insertUser passes tenant_id in the INSERT column list because
 * the RLS WITH CHECK policy requires the inserted row's tenant_id to match
 * app.current_tenant. This is an RLS-enforced write constraint, not a filter.
 *
 * System-role escapes (findInvitationByTokenHashSystem, withSystemClient) are
 * documented at their call sites. They exist solely for the pre-auth
 * acceptInvitation path and must not be used for tenant-scoped operations.
 */

import type { PoolClient } from 'pg';
import { getPool } from '@assessiq/tenancy';
import type {
  User,
  UserInvitation,
  UserRole,
  UserStatus,
  ListUsersInput,
} from './types.js';

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const USER_COLUMNS = `id, tenant_id, email, name, role, status, metadata, created_at, updated_at, deleted_at`;

const INVITATION_COLUMNS = `id, tenant_id, email, role, token_hash, invited_by, expires_at, accepted_at, created_at`;

// ---------------------------------------------------------------------------
// Row interfaces (raw Postgres types before mapping)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Mapper functions
// ---------------------------------------------------------------------------

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function mapInvitationRow(row: InvitationRow): UserInvitation {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    email: row.email,
    role: row.role as UserRole,
    token_hash: row.token_hash,
    invited_by: row.invited_by,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// System client helper (pre-auth path only)
// ---------------------------------------------------------------------------

/**
 * Acquire a raw pool client WITHOUT tenant context (runs as the pool user,
 * which in production is assessiq_system or assessiq_app without SET LOCAL).
 *
 * Used ONLY by the pre-auth acceptInvitation path to look up the invitation's
 * tenant_id before we know which tenant to scope to. The caller is responsible
 * for releasing the client.
 *
 * Security argument: token_hash is the sha256 of a 32-byte random value
 * (256 bits of entropy). A global lookup is safe because collision/guessing is
 * computationally infeasible. The alternative — accepting a token only within a
 * known tenant context — would require the caller to know the tenant_id upfront,
 * which is precisely the information the invitation lookup provides. Cross-tenant
 * token replay is also infeasible since each token_hash maps to exactly one row.
 */
export async function withSystemClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

export async function findUserById(client: PoolClient, id: string): Promise<User | null> {
  const result = await client.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapUserRow(row) : null;
}

/**
 * Find a user by their normalized (lowercased + trimmed) email address.
 * The email arg MUST already be normalized at the call site; lower() here
 * is defense-in-depth and uses the users_email_lower_idx from migration 020.
 * RLS scopes the result to the current tenant.
 */
export async function findUserByEmailNormalized(
  client: PoolClient,
  normalizedEmail: string,
): Promise<User | null> {
  const result = await client.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1 LIMIT 1`,
    [normalizedEmail],
  );
  const row = result.rows[0];
  return row !== undefined ? mapUserRow(row) : null;
}

export async function listUsersRows(
  client: PoolClient,
  filters: ListUsersInput,
): Promise<{ items: User[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // includeDeleted=false (default) filters to non-deleted rows
  if (!filters.includeDeleted) {
    conditions.push(`deleted_at IS NULL`);
  }

  if (filters.role !== undefined) {
    conditions.push(`role = $${i}`);
    values.push(filters.role);
    i++;
  }

  if (filters.status !== undefined) {
    conditions.push(`status = $${i}`);
    values.push(filters.status);
    i++;
  }

  if (filters.search !== undefined && filters.search.length > 0) {
    // Case-insensitive prefix match on name OR email (addendum § 9).
    // lower($search) || '%' uses the users_email_lower_idx for the email branch.
    conditions.push(
      `(lower(name) LIKE lower($${i}) || '%' OR lower(email) LIKE lower($${i}) || '%')`,
    );
    values.push(filters.search);
    i++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Separate count query against the same WHERE clause (addendum § 9).
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM users ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const dataResult = await client.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  return { items: dataResult.rows.map(mapUserRow), total };
}

export async function insertUser(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    role: UserRole;
    status: UserStatus;
    metadata: Record<string, unknown>;
  },
): Promise<User> {
  const result = await client.query<UserRow>(
    `INSERT INTO users (id, tenant_id, email, name, role, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${USER_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.email,
      input.name,
      input.role,
      input.status,
      JSON.stringify(input.metadata),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('insertUser: INSERT returned no row');
  }
  return mapUserRow(row);
}

export async function updateUserRow(
  client: PoolClient,
  id: string,
  patch: {
    name?: string;
    role?: string;
    status?: string;
    metadata?: Record<string, unknown>;
    deleted_at?: Date | null;
  },
): Promise<User> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i}`);
    values.push(patch.name);
    i++;
  }
  if (patch.role !== undefined) {
    sets.push(`role = $${i}`);
    values.push(patch.role);
    i++;
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i}`);
    values.push(patch.status);
    i++;
  }
  if (patch.metadata !== undefined) {
    sets.push(`metadata = $${i}::jsonb`);
    values.push(JSON.stringify(patch.metadata));
    i++;
  }
  if (patch.deleted_at !== undefined) {
    if (patch.deleted_at === null) {
      sets.push(`deleted_at = NULL`);
    } else {
      sets.push(`deleted_at = $${i}`);
      values.push(patch.deleted_at);
      i++;
    }
  }

  sets.push(`updated_at = now()`);

  values.push(id);
  const result = await client.query<UserRow>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${USER_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateUserRow: no row found for id ${id}`);
  }
  return mapUserRow(row);
}

export async function softDeleteUser(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function restoreUser(client: PoolClient, id: string): Promise<User> {
  const result = await client.query<UserRow>(
    `UPDATE users SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`restoreUser: no row found for id ${id}`);
  }
  return mapUserRow(row);
}

/**
 * Count active admins in the current tenant excluding the given user.
 * Used by the last-admin invariant assertion. RLS scopes to the current tenant.
 */
export async function countActiveAdmins(
  client: PoolClient,
  excludingUserId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM users
      WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
        AND id <> $1`,
    [excludingUserId],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Invitation queries
// ---------------------------------------------------------------------------

export async function insertInvitation(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    email: string;
    role: UserRole;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
  },
): Promise<UserInvitation> {
  const result = await client.query<InvitationRow>(
    `INSERT INTO user_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${INVITATION_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.email,
      input.role,
      input.tokenHash,
      input.invitedBy,
      input.expiresAt,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('insertInvitation: INSERT returned no row');
  }
  return mapInvitationRow(row);
}

/**
 * Look up an invitation by token hash within tenant context.
 * Use this variant when the tenant_id is already known (in-tenant operations).
 */
export async function findInvitationByTokenHash(
  client: PoolClient,
  tokenHash: string,
): Promise<UserInvitation | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM user_invitations WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

/**
 * System-role invitation lookup for the pre-auth acceptInvitation path.
 *
 * Security argument: token_hash is sha256 of a 32-byte (256-bit) random value.
 * A global lookup without tenant context is safe — the high entropy makes
 * cross-tenant token guessing computationally infeasible. This is the ONLY
 * correct approach because the tenant_id is unknown until AFTER the lookup.
 * See withSystemClient() above for the full security rationale.
 *
 * The systemClient must be a raw pool client (no SET LOCAL ROLE assessiq_app,
 * no app.current_tenant). It runs as the pool's configured user which in tests
 * is the superuser; in production it should be assessiq_system (BYPASSRLS).
 */
export async function findInvitationByTokenHashSystem(
  systemClient: PoolClient,
  tokenHash: string,
): Promise<UserInvitation | null> {
  // Run as assessiq_system to bypass RLS (no tenant context is set).
  // Only token_hash is used in the WHERE; see module-level security comment.
  const result = await systemClient.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM user_invitations WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

/**
 * Find a pending (unaccepted) invitation by normalized email.
 * Uses the partial index from migration 021 (WHERE accepted_at IS NULL).
 */
export async function findPendingInvitationByEmail(
  client: PoolClient,
  normalizedEmail: string,
): Promise<UserInvitation | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM user_invitations
      WHERE lower(email) = $1 AND accepted_at IS NULL
      LIMIT 1`,
    [normalizedEmail],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

/**
 * Atomic single-use mark. Returns ok=true if the row was updated (first use),
 * ok=false if the row had already been accepted (concurrent or duplicate call).
 */
export async function markInvitationAccepted(
  client: PoolClient,
  id: string,
): Promise<{ ok: boolean }> {
  const result = await client.query<{ id: string }>(
    `UPDATE user_invitations SET accepted_at = now()
      WHERE id = $1 AND accepted_at IS NULL
      RETURNING id`,
    [id],
  );
  return { ok: (result.rowCount ?? 0) > 0 };
}

export async function deleteInvitation(client: PoolClient, id: string): Promise<void> {
  await client.query(`DELETE FROM user_invitations WHERE id = $1`, [id]);
}

/**
 * Delete all pending (unaccepted) invitations for a given email address.
 * Used by softDelete to cascade and by inviteUser re-invite to replace old tokens.
 * lower() is defense-in-depth; the email arg should already be normalized.
 */
export async function deleteInvitationsForEmail(
  client: PoolClient,
  normalizedEmail: string,
): Promise<void> {
  await client.query(
    `DELETE FROM user_invitations WHERE lower(email) = $1 AND accepted_at IS NULL`,
    [normalizedEmail],
  );
}
