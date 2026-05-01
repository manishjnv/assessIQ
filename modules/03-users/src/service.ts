import { logger, NotFoundError, ValidationError, ConflictError, uuidv7 } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
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

export async function createUser(tenantId: string, input: CreateUserInput): Promise<User> {
  const normalizedEmail = normalizeEmail(input.email);
  assertValidEmail(normalizedEmail);
  assertValidName(input.name);
  assertValidRole(input.role);

  const id = uuidv7();
  logger.info({ tenantId, id, role: input.role }, 'createUser');

  try {
    return await withTenant(tenantId, (client) =>
      repo.insertUser(client, {
        id,
        tenantId,
        email: normalizedEmail,
        name: input.name,
        role: input.role,
        status: 'pending', // Default per addendum § 3: createUser does NOT activate
        metadata: input.metadata ?? {},
      }),
    );
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

  logger.info({ tenantId, id }, 'updateUser');

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

    return repo.updateUserRow(client, id, repoPatch);
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

export async function softDelete(tenantId: string, id: string): Promise<void> {
  logger.info({ tenantId, id }, 'softDelete');

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
    await repo.deleteInvitationsForEmail(client, normalizeEmail(target.email));
  });

  // Sweep Redis sessions after commit (addendum § 7).
  await sweepUserSessions(id);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function restore(tenantId: string, id: string): Promise<User> {
  logger.info({ tenantId, id }, 'restore');

  // restore does NOT touch invitations or sessions per addendum § 5.
  return withTenant(tenantId, async (client) => {
    const target = await repo.findUserById(client, id);
    if (target === null) {
      throw new NotFoundError(`User not found: ${id}`);
    }
    return repo.restoreUser(client, id);
  });
}
