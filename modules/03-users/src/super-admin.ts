/**
 * Super-admin (platform operator) user operations.
 *
 * RW-36(a): moved out of apps/api/src/routes/admin-super/users.ts so routes
 * hold no SQL. Cross-tenant design is unchanged: resolve the target's tenant
 * via a system-role read, then operate under withTenant(targetTenantId) —
 * NEVER the platform tenant. These functions deliberately do NOT enforce
 * assertNotLastAdmin through the shared service; they implement the explicit
 * confirm_last_admin override path, and every mutation writes its audit row
 * via auditInTx in the same transaction.
 */

import { ConflictError, NotFoundError } from '@assessiq/core';
import { withTenant, withSystemRole } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import { deleteGoogleIdentitiesForUser } from '@assessiq/auth';
import type { PoolClient } from 'pg';
import * as repo from './repository.js';

export interface ResolvedUserTenant {
  tenantId: string;
  email: string;
  name: string;
  role: string;
  status: string;
  deleted_at: Date | null;
}

/** System-role (BYPASSRLS) cross-tenant read: the caller must be super-admin. */
export async function listTenantUsersForSuperAdmin(
  tenantId: string,
  opts: { includeDisabled: boolean; includeDeleted: boolean },
): Promise<{
  users: repo.SuperAdminUserRow[];
  pending_invitations: repo.SuperAdminPendingInvitationRow[];
}> {
  return withSystemRole('super-admin cross-tenant user list', async (client) => {
    const users = await repo.listTenantUsersSystem(
      client,
      tenantId,
      opts.includeDisabled,
      opts.includeDeleted,
    );
    const pending_invitations = await repo.listPendingInvitationsSystem(client, tenantId);
    return { users, pending_invitations };
  });
}

/** Resolve the target user's tenantId via system-role (BYPASSRLS). Null if absent. Caller must be super-admin. */
export async function resolveUserTenant(userId: string): Promise<ResolvedUserTenant | null> {
  const row = await withSystemRole('super-admin user tenant resolve', (client) => repo.findUserTenantSystem(client, userId));
  if (row === undefined) return null;
  return {
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    deleted_at: row.deleted_at,
  };
}

/** Earliest-created admin of the tenant (system role), or null. Caller must be super-admin. */
export async function findTenantFirstAdmin(
  tenantId: string,
): Promise<repo.TenantAdminLookupRow | null> {
  const row = await withSystemRole('super-admin tenant first-admin lookup', (client) => repo.findFirstAdminSystem(client, tenantId));
  return row ?? null;
}

/**
 * Resolve a pending invitation's tenantId via system-role lookup. Caller must be super-admin.
 * Throws NotFoundError / ConflictError exactly as the former route did.
 */
export async function resolvePendingInvitationTenant(invitationId: string): Promise<string> {
  const row = await withSystemRole('super-admin invitation tenant resolve', (client) =>
    repo.findInvitationTenantSystem(client, invitationId),
  );
  if (row === undefined) {
    throw new NotFoundError(`Invitation not found: ${invitationId}`, {
      details: { code: 'INVITATION_NOT_FOUND' },
    });
  }
  if (row.accepted_at !== null) {
    throw new ConflictError(
      'This invitation has already been accepted and cannot be cancelled.',
      { details: { code: 'INVITATION_ALREADY_ACCEPTED' } },
    );
  }
  return row.tenant_id;
}

/** Last-admin invariant with the explicit confirm_last_admin + reason override. */
async function assertLastAdminOrOverride(
  client: PoolClient,
  target: ResolvedUserTenant,
  userId: string,
  confirmLastAdmin: boolean,
  reason: string | undefined,
): Promise<void> {
  if (target.role === 'admin' && target.status === 'active' && target.deleted_at === null) {
    const otherAdmins = await repo.countActiveAdmins(client, userId);
    if (otherAdmins === 0) {
      if (!confirmLastAdmin || !reason) {
        throw new ConflictError(
          'This is the last active admin. Pass confirm_last_admin=true and a non-empty reason to override.',
          { details: { code: 'LAST_ADMIN' } },
        );
      }
    }
  }
}

export async function disableUserAsSuperAdmin(input: {
  target: ResolvedUserTenant;
  userId: string;
  actorUserId: string;
  reason: string | undefined;
  confirmLastAdmin: boolean;
}): Promise<{ id: string; status: string; isOverride: boolean }> {
  const { target, userId, actorUserId, reason, confirmLastAdmin } = input;
  const targetTenantId = target.tenantId;
  return withTenant(targetTenantId, async (client) => {
    await assertLastAdminOrOverride(client, target, userId, confirmLastAdmin, reason);

    const row = await repo.disableUserReturning(client, userId);
    if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

    const isOverride = confirmLastAdmin && !!reason;
    await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.disabled',
      entityType: 'user',
      entityId: userId,
      before: { status: target.status },
      after: {
        status: 'disabled',
        reason: reason ?? null,
        ...(isOverride ? { is_override: true } : {}),
      },
    });

    return { id: row.id, status: row.status, isOverride };
  });
}

export async function reenableUserAsSuperAdmin(input: {
  target: ResolvedUserTenant;
  userId: string;
  actorUserId: string;
  reason: string | undefined;
}): Promise<{ id: string; status: string }> {
  const { target, userId, actorUserId, reason } = input;
  const targetTenantId = target.tenantId;
  return withTenant(targetTenantId, async (client) => {
    const row = await repo.reenableUserReturning(client, userId);
    if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

    await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.reenabled',
      entityType: 'user',
      entityId: userId,
      before: { status: target.status },
      after: { status: 'active', reason: reason ?? null },
    });

    return row;
  });
}

export async function softDeleteUserAsSuperAdmin(input: {
  target: ResolvedUserTenant;
  userId: string;
  actorUserId: string;
  reason: string | undefined;
  confirmLastAdmin: boolean;
}): Promise<void> {
  const { target, userId, actorUserId, reason, confirmLastAdmin } = input;
  const targetTenantId = target.tenantId;
  await withTenant(targetTenantId, async (client) => {
    await assertLastAdminOrOverride(client, target, userId, confirmLastAdmin, reason);

    await repo.softDeleteUser(client, userId);

    // Cascade: delete pending invitations for this email.
    await repo.deleteInvitationsForEmail(client, target.email.toLowerCase());

    const isOverride = confirmLastAdmin && !!reason;
    await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.soft_deleted',
      entityType: 'user',
      entityId: userId,
      before: { status: target.status, deleted_at: null },
      after: {
        deleted: true,
        reason: reason ?? null,
        ...(isOverride ? { is_override: true } : {}),
      },
    });
  });
}

export async function restoreUserAsSuperAdmin(input: {
  target: ResolvedUserTenant;
  userId: string;
  actorUserId: string;
  reason: string | undefined;
}): Promise<{ id: string; status: string; deleted_at: Date | null }> {
  const { target, userId, actorUserId, reason } = input;
  const targetTenantId = target.tenantId;
  return withTenant(targetTenantId, async (client) => {
    const row = await repo.restoreUserReturningStatus(client, userId);
    if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

    await auditInTx(client, {
      tenantId: targetTenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.restored',
      entityType: 'user',
      entityId: userId,
      before: { deleted_at: 'non-null', status: target.status },
      after: { deleted_at: null, status: row.status, reason: reason ?? null },
    });

    return row;
  });
}

/**
 * Apply a validated profile edit (name / role / email) + audit in one tx.
 * Returns the audit row id (or null if the audit helper returned no id).
 * UNIQUE (tenant_id, email) collision (pg 23505) → ConflictError USER_EMAIL_EXISTS.
 */
export async function updateUserProfileAsSuperAdmin(input: {
  target: ResolvedUserTenant;
  userId: string;
  actorUserId: string;
  reason: string | undefined;
  newName: string | undefined;
  newRole: 'admin' | undefined;
  newEmail: string | undefined;
  nameChanged: boolean;
  roleChanged: boolean;
  emailChanged: boolean;
  wasPending: boolean;
  currentEmail: string;
}): Promise<string | null> {
  const {
    target, userId, actorUserId, reason, newName, newRole, newEmail,
    nameChanged, roleChanged, emailChanged, wasPending, currentEmail,
  } = input;
  const targetTenantId = target.tenantId;

  let auditId: string | null = null;
  try {
    await withTenant(targetTenantId, async (client) => {
      const patch: { name?: string; role?: string; email?: string } = {};
      if (newName !== undefined) patch.name = newName;
      if (newRole !== undefined) patch.role = newRole;
      if (newEmail !== undefined) patch.email = newEmail;
      await repo.updateUserProfileFields(client, userId, patch);

      if (emailChanged) {
        // Drop the stale Google identity link. Login resolves by email, so the
        // old (provider,subject)→user_id row is inert, but removing it avoids a
        // dangling mapping and lets the new address re-link JIT on next login.
        await deleteGoogleIdentitiesForUser(client, userId);
        // Pending admin: retire the old-address invitation now; a fresh invite
        // to the new address is issued post-commit via inviteUser.
        if (wasPending) {
          await repo.deleteInvitationsForEmail(client, currentEmail);
        }
      }

      const changedFields = [
        ...(nameChanged ? ['name'] : []),
        ...(roleChanged ? ['role'] : []),
        ...(emailChanged ? ['email'] : []),
      ];
      const auditRes: unknown = await auditInTx(client, {
        tenantId: targetTenantId,
        actorKind: 'user',
        actorUserId,
        action: 'user.updated',
        entityType: 'user',
        entityId: userId,
        before: {
          name: target.name,
          role: target.role,
          ...(emailChanged ? { email: target.email } : {}),
        },
        after: {
          ...(nameChanged ? { name: newName } : {}),
          ...(roleChanged ? { role: newRole } : {}),
          ...(emailChanged ? { email: newEmail } : {}),
          changed_fields: changedFields,
          kind: 'super_profile_edit',
          ...(emailChanged ? { email_identity_transfer: target.status === 'active' } : {}),
          reason: reason ?? null,
        },
      });
      if (auditRes !== null && typeof auditRes === 'object' && 'id' in auditRes) {
        auditId = String((auditRes as { id: unknown }).id);
      }
    });
  } catch (err) {
    // UNIQUE (tenant_id, email) collision → 409 (mirror createUser).
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new ConflictError('A user with this email already exists in this organisation.', {
        details: { code: 'USER_EMAIL_EXISTS', email: newEmail },
      });
    }
    throw err;
  }
  return auditId;
}
