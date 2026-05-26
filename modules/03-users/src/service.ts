import { streamLogger, NotFoundError, ValidationError, ConflictError, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { auditInTx } from '@assessiq/audit-log';
import type {
  User,
  UserRole,
  UserStatus,
  PaginatedUsers,
  ListUsersInput,
  CreateUserInput,
  UpdateUserPatch,
} from './types.js';
import { normalizeEmail } from './normalize.js';
import { assertNotLastAdmin, assertValidStatusTransition } from './invariants.js';
import * as repo from './repository.js';
import { sweepUserSessions } from './redis-sweep.js';
import { redactUserForAudit } from './audit-redact.js';

const log = streamLogger('app');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set(['admin', 'reviewer', 'candidate']);
const VALID_STATUSES: ReadonlySet<string> = new Set(['active', 'disabled', 'pending']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 200;
const MAX_PAGE_SIZE = 100;

function assertValidEmail(email: string): void {
  if (!EMAIL_REGEX.test(email)) {
    throw new ValidationError(`Invalid email address: '${email}'`, {
      details: { code: 'INVALID_EMAIL', email },
    });
  }
}

function assertValidRole(role: string): asserts role is UserRole {
  if (!VALID_ROLES.has(role)) {
    throw new ValidationError(`Invalid role: '${role}'`, {
      details: { code: 'INVALID_ROLE', role },
    });
  }
}

function assertValidStatus(status: string): asserts status is UserStatus {
  if (!VALID_STATUSES.has(status)) {
    throw new ValidationError(`Invalid status: '${status}'`, {
      details: { code: 'INVALID_STATUS', status },
    });
  }
}

function assertValidName(name: string): void {
  if (name.trim().length === 0) {
    throw new ValidationError(`Name must not be empty`, {
      details: { code: 'MISSING_REQUIRED', field: 'name' },
    });
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `Name must not exceed ${MAX_NAME_LENGTH} characters`,
      { details: { code: 'NAME_TOO_LONG', maxLength: MAX_NAME_LENGTH } },
    );
  }
}

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

export async function listUsers(
  tenantId: string,
  filters: ListUsersInput = {},
): Promise<PaginatedUsers> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;

  // Cap per addendum § 9 — stricter than global 200.
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `pageSize must not exceed ${MAX_PAGE_SIZE} for the users endpoint`,
      { details: { code: 'INVALID_PAGE_SIZE', pageSize, max: MAX_PAGE_SIZE } },
    );
  }

  return withTenant(tenantId, async (client) => {
    const { items, total } = await repo.listUsersRows(client, {
      ...filters,
      page,
      pageSize,
    });
    return {
      items,
      page,
      pageSize,
      total,
    };
  });
}

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

export async function getUser(tenantId: string, id: string): Promise<User> {
  const user = await withTenant(tenantId, (client) =>
    repo.findUserById(client, id),
  );
  if (user === null) {
    throw new NotFoundError(`User not found: ${id}`);
  }
  return user;
}

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

export async function createUser(
  tenantId: string,
  input: CreateUserInput,
  actorUserId: string,
): Promise<User> {
  const normalizedEmail = normalizeEmail(input.email);
  assertValidEmail(normalizedEmail);
  assertValidName(input.name);
  assertValidRole(input.role);

  const id = uuidv7();
  log.info({ tenantId, id, role: input.role }, 'createUser');

  try {
    return await withTenant(tenantId, async (client) => {
      const user = await repo.insertUser(client, {
        id,
        tenantId,
        email: normalizedEmail,
        name: input.name,
        role: input.role,
        // Candidates authenticate via per-assessment magic links (no invite-accept
        // flow), so they are created active immediately. Admins and reviewers
        // remain pending until they accept their invitation email. There is
        // deliberately no `status` input field on CreateUserInput, which means
        // an active admin/reviewer cannot be minted through this path.
        status: input.role === 'candidate' ? 'active' : 'pending',
        metadata: input.metadata ?? {},
      });
      await auditInTx(client, {
        tenantId,
        actorKind: 'user',
        actorUserId,
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        after: redactUserForAudit({
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          metadata: user.metadata,
        }),
      });
      return user;
    });
  } catch (err: unknown) {
    // Translate Postgres unique_violation (23505) to ConflictError per addendum § 10.
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new ConflictError(
        'A user with this email already exists in this tenant.',
        { details: { code: 'USER_EMAIL_EXISTS', email: normalizedEmail } },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

export async function updateUser(
  tenantId: string,
  id: string,
  patch: UpdateUserPatch,
  actorUserId: string,
): Promise<User> {
  if (patch.role !== undefined) assertValidRole(patch.role);
  if (patch.status !== undefined) assertValidStatus(patch.status);
  if (patch.name !== undefined) assertValidName(patch.name);
  if (patch.metadata !== undefined) {
    const normalizedEmail = patch.metadata['email'] as string | undefined;
    if (normalizedEmail !== undefined) {
      // If metadata happens to carry an email key, normalize it too — belt-and-braces.
      patch = {
        ...patch,
        metadata: { ...patch.metadata, email: normalizeEmail(normalizedEmail) },
      };
    }
  }

  log.info({ tenantId, id }, 'updateUser');

  let shouldSweepRedis = false;

  const updatedUser = await withTenant(tenantId, async (client) => {
    const current = await repo.findUserById(client, id);
    if (current === null) {
      throw new NotFoundError(`User not found: ${id}`);
    }

    // Status transition validation (addendum § 7)
    if (patch.status !== undefined && patch.status !== current.status) {
      assertValidStatusTransition(current.status, patch.status);
    }

    // Last-admin invariant (addendum § 4):
    // Fires when the target is currently an active admin AND:
    //   - patch demotes role away from admin, OR
    //   - patch disables the user (status → disabled)
    if (current.role === 'admin' && current.status === 'active' && current.deleted_at === null) {
      const demotingRole =
        patch.role !== undefined && patch.role !== 'admin';
      const disabling =
        patch.status !== undefined && patch.status === 'disabled';

      if (demotingRole || disabling) {
        await assertNotLastAdmin(client, id, demotingRole ? 'roleChange' : 'statusChange');
      }
    }

    // Determine if we need to sweep Redis after commit
    if (patch.status === 'disabled' && current.status !== 'disabled') {
      shouldSweepRedis = true;
    }

    // Build the patch object without undefined values — exactOptionalPropertyTypes
    // forbids passing `undefined` as the value of an optional property.
    const repoPatch: Parameters<typeof repo.updateUserRow>[2] = {};
    if (patch.name !== undefined) repoPatch.name = patch.name;
    if (patch.role !== undefined) repoPatch.role = patch.role;
    if (patch.status !== undefined) repoPatch.status = patch.status;
    if (patch.metadata !== undefined) repoPatch.metadata = patch.metadata;

    const updated = await repo.updateUserRow(client, id, repoPatch);

    // Compute changed-fields list across the four mutable columns. This is
    // forensic diff metadata (cheap to query) and avoids logging full row
    // dumps that mostly haven't changed.
    const changedFields: string[] = [];
    if (patch.name !== undefined && patch.name !== current.name) changedFields.push('name');
    if (patch.role !== undefined && patch.role !== current.role) changedFields.push('role');
    if (patch.status !== undefined && patch.status !== current.status) changedFields.push('status');
    if (patch.metadata !== undefined) changedFields.push('metadata');

    // Marker for downstream forensic queries: a single "what kind of update
    // was this" tag, derivable from the diff. Disable/role-change get their
    // own kind so audit consumers can filter on it without parsing
    // changed_fields. role.changed and disabled would have been first-class
    // actions but the catalog (modules/14-audit-log) is load-bearing — kind
    // markers keep ACTION_CATALOG growth bounded (CLAUDE.md rule).
    let kind: 'status_change' | 'role_change' | 'general' = 'general';
    if (patch.status !== undefined && patch.status !== current.status) {
      kind = 'status_change';
    } else if (patch.role !== undefined && patch.role !== current.role) {
      kind = 'role_change';
    }

    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      before: redactUserForAudit({
        name: current.name,
        role: current.role,
        status: current.status,
        metadata: current.metadata,
      }),
      after: redactUserForAudit({
        name: updated.name,
        role: updated.role,
        status: updated.status,
        metadata: updated.metadata,
        changed_fields: changedFields,
        kind,
      }),
    });

    return updated;
  });

  // Redis sweep runs AFTER the transaction commits (non-transactional).
  // Per addendum § 7: sweep on disable.
  if (shouldSweepRedis) {
    await sweepUserSessions(id);
  }

  return updatedUser;
}

// ---------------------------------------------------------------------------
// softDelete
// ---------------------------------------------------------------------------

export async function softDelete(
  tenantId: string,
  id: string,
  actorUserId: string,
): Promise<void> {
  log.info({ tenantId, id }, 'softDelete');

  await withTenant(tenantId, async (client) => {
    const target = await repo.findUserById(client, id);
    if (target === null) {
      throw new NotFoundError(`User not found: ${id}`);
    }

    // Last-admin invariant (addendum § 4): check before flipping deleted_at
    // when the target is an active admin.
    if (target.role === 'admin' && target.status === 'active' && target.deleted_at === null) {
      await assertNotLastAdmin(client, id, 'softDelete');
    }

    await repo.softDeleteUser(client, id);

    // Cascade: delete pending invitations for this email (addendum § 5).
    const cascadedCount = await repo.deleteInvitationsForEmail(
      client,
      normalizeEmail(target.email),
    );

    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.deleted',
      entityType: 'user',
      entityId: id,
      before: redactUserForAudit({
        email: target.email,
        name: target.name,
        role: target.role,
        status: target.status,
      }),
      after: redactUserForAudit({
        deleted: true,
        cascaded_pending_invitations: cascadedCount,
      }),
    });
  });

  // Sweep Redis sessions after commit (addendum § 7).
  await sweepUserSessions(id);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function restore(
  tenantId: string,
  id: string,
  actorUserId: string,
): Promise<User> {
  log.info({ tenantId, id }, 'restore');

  // restore does NOT touch invitations or sessions per addendum § 5.
  return withTenant(tenantId, async (client) => {
    const target = await repo.findUserById(client, id);
    if (target === null) {
      throw new NotFoundError(`User not found: ${id}`);
    }

    const restored = await repo.restoreUser(client, id);

    await auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId,
      action: 'user.restored',
      entityType: 'user',
      entityId: id,
      before: redactUserForAudit({
        deleted_at: target.deleted_at,
        status: target.status,
        role: target.role,
      }),
      after: redactUserForAudit({
        deleted_at: restored.deleted_at,
        status: restored.status,
        role: restored.role,
      }),
    });

    return restored;
  });
}
