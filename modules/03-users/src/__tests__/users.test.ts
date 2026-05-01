/**
 * Integration tests for modules/03-users.
 *
 * Uses a postgres:16-alpine testcontainer so the full RLS stack is exercised.
 * Container is started ONCE in beforeAll and torn down in afterAll.
 * All tests share the same container.
 *
 * Migration apply order: lexical across BOTH 02-tenancy/migrations/ AND
 * 03-users/migrations/. The 02-tenancy files (0001_, 0002_, 0003_) sort
 * before the 03-users files (020_, 021_) so tenant tables exist first.
 *
 * ESLint: no console.log — vitest reporter output only.
 */

import { describe, it, test, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// setPoolForTesting and closePool are test-only helpers in 02-tenancy/src/pool.ts.
// They are NOT exported from @assessiq/tenancy public surface — import the source directly.
// The 02-tenancy pool singleton IS the shared pool used by withTenant, so pointing it at
// the testcontainer URL causes all service calls to use the test DB.
import { setPoolForTesting, closePool } from '../../../02-tenancy/src/pool.js';

// setRedisForTesting / closeRedis swap the @assessiq/auth singleton Redis client
// against the local testcontainer's URL. Required because acceptInvitation
// transitively calls sessions.create() which writes to Redis after the
// Postgres mirror lands.
import { setRedisForTesting, closeRedis } from '@assessiq/auth';

// The service + invitations under test
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  softDelete,
} from '../service.js';
import { inviteUser, acceptInvitation } from '../invitations.js';
import { ConflictError, NotFoundError, ValidationError } from '@assessiq/core';

// ---------------------------------------------------------------------------
// Mock @assessiq/notifications to capture invitation emails
// ---------------------------------------------------------------------------

interface CapturedEmail {
  to: string;
  role: string;
  invitationLink: string;
  tenantName?: string;
}
const capturedEmails: CapturedEmail[] = [];

vi.mock('@assessiq/notifications', () => ({
  sendInvitationEmail: vi.fn(async (input: CapturedEmail) => {
    capturedEmails.push(input);
  }),
}));

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let container: StartedTestContainer;
let redisContainer: StartedTestContainer;
let containerUrl: string;
let redisUrl: string;
let tenantA: string;
let tenantB: string;

// Path helper — strip Windows-style leading slash before drive letter.
// import.meta.url on Windows: file:///E:/code/...
// new URL('.', import.meta.url).pathname: /E:/code/.../src/__tests__/  (trailing slash)
// We strip the leading slash so join() works correctly on Windows.
function toFsPath(url: URL): string {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

// __tests__/ is at: modules/03-users/src/__tests__/
// path.join normalizes the trailing slash, so two `..` reach the module root.
const THIS_DIR = toFsPath(new URL('.', import.meta.url));    // .../modules/03-users/src/__tests__/
const USERS_MODULE_ROOT = join(THIS_DIR, '..', '..');         // .../modules/03-users/
const MODULES_ROOT = join(USERS_MODULE_ROOT, '..');           // .../modules/

const TENANCY_MIGRATIONS_DIR = join(MODULES_ROOT, '02-tenancy', 'migrations');
const AUTH_MIGRATIONS_DIR = join(MODULES_ROOT, '01-auth', 'migrations');
const USERS_MIGRATIONS_DIR = join(USERS_MODULE_ROOT, 'migrations');

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function withSuperClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: containerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function insertTenant(client: Client, id: string, slug: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`,
    [id, slug, name],
  );
  await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Spin up postgres:16-alpine and redis:7-alpine in parallel.
  [container, redisContainer] = await Promise.all([
    new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'aiq_test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(60_000)
      .start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(60_000)
      .start(),
  ]);

  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  // 2. Apply migrations in dependency order across three directories.
  //
  // Lexical order WOULD be 0001-0003 (tenancy) → 010-015 (auth) → 020-021
  // (users/invitations) — but the auth migrations 010-013, 015 FK to
  // users(id) which is created in 020. So we apply per-directory in
  // dependency-resolved order: tenancy → users (020) → auth → invitations
  // (021). The runtime tools/migrate.ts has the same latent ordering issue
  // for fresh DBs; production deploys have applied 0001-0003 + 020-021 via
  // psql -f, and W4 deploys 010-015 against an already-populated DB so the
  // ordering bug never bites in production. Recorded as a Phase 1 follow-up.
  const [tenancyFiles, authFiles, usersFiles] = await Promise.all([
    readdir(TENANCY_MIGRATIONS_DIR),
    readdir(AUTH_MIGRATIONS_DIR),
    readdir(USERS_MIGRATIONS_DIR),
  ]);

  const tenancySorted = tenancyFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: TENANCY_MIGRATIONS_DIR, file: f }));
  const authSorted = authFiles.filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ dir: AUTH_MIGRATIONS_DIR, file: f }));
  const usersSorted = usersFiles.filter((f) => f.endsWith('.sql')).sort();
  const usersTable = usersSorted.filter((f) => f.startsWith('020_'))
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));
  const usersInvitations = usersSorted.filter((f) => !f.startsWith('020_'))
    .map((f) => ({ dir: USERS_MIGRATIONS_DIR, file: f }));

  const allFiles = [
    ...tenancySorted,        // 0001-0003: tenants + RLS helpers + tenant RLS
    ...usersTable,           // 020: users (auth FKs target this)
    ...authSorted,           // 010-015: auth tables (FK users + tenants)
    ...usersInvitations,     // 021: user_invitations
  ];

  await withSuperClient(async (client) => {
    for (const { dir, file } of allFiles) {
      const sql = await readFile(join(dir, file), 'utf-8');
      await client.query(sql);
    }
  });

  // 3. Point pool + Redis client at testcontainers
  await setPoolForTesting(containerUrl);
  await setRedisForTesting(redisUrl);

  // 4. Seed two tenants
  tenantA = randomUUID();
  tenantB = randomUUID();
  await withSuperClient(async (client) => {
    await insertTenant(client, tenantA, 'tenant-a', 'Tenant A');
    await insertTenant(client, tenantB, 'tenant-b', 'Tenant B');
  });
}, 90_000);

afterAll(async () => {
  await closePool();
  await closeRedis();
  await Promise.all([
    container !== undefined ? container.stop() : Promise.resolve(),
    redisContainer !== undefined ? redisContainer.stop() : Promise.resolve(),
  ]);
});

beforeEach(() => {
  capturedEmails.length = 0;
});

// ---------------------------------------------------------------------------
// Test 1: createUser + getUser happy path
// ---------------------------------------------------------------------------

describe('createUser + getUser', () => {
  it('seeds an admin in tenant A and retrieves it', async () => {
    const user = await createUser(tenantA, {
      email: 'alice@example.com',
      name: 'Alice',
      role: 'admin',
    });

    expect(user.email).toBe('alice@example.com');
    expect(user.role).toBe('admin');
    expect(user.status).toBe('pending'); // createUser defaults to pending per § 3

    const fetched = await getUser(tenantA, user.id);
    expect(fetched.id).toBe(user.id);

    const { items } = await listUsers(tenantA);
    const ids = items.map((u) => u.id);
    expect(ids).toContain(user.id);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Email normalization at write
// ---------------------------------------------------------------------------

it('normalizes email at write (trims + lowercases)', async () => {
  const user = await createUser(tenantA, {
    email: 'Foo@Example.COM ',
    name: 'Foo User',
    role: 'reviewer',
  });
  expect(user.email).toBe('foo@example.com');
});

// ---------------------------------------------------------------------------
// Test 3: Per-tenant case-insensitive uniqueness
// ---------------------------------------------------------------------------

describe('email uniqueness', () => {
  it('rejects duplicate email in same tenant (case-insensitive)', async () => {
    await createUser(tenantA, { email: 'same@x.com', name: 'User One', role: 'reviewer' });

    await expect(
      createUser(tenantA, { email: 'Same@X.COM', name: 'User Two', role: 'reviewer' }),
    ).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'USER_EMAIL_EXISTS'
      );
    });
  });

  it('allows the same email in a different tenant', async () => {
    // same@x.com already exists in tenantA from the test above;
    // it must succeed in tenantB.
    const user = await createUser(tenantB, { email: 'same@x.com', name: 'Tenant B User', role: 'reviewer' });
    expect(user.email).toBe('same@x.com');
    expect(user.tenant_id).toBe(tenantB);
  });
});

// ---------------------------------------------------------------------------
// Test 4: listUsers prefix search + pageSize cap
// ---------------------------------------------------------------------------

describe('listUsers', () => {
  it('prefix-searches name and email', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-search-${tid.slice(0, 8)}`, 'Search Tenant');
    });

    // Seed: 5 users — 2 with name starting 'J', 1 with email starting 'j', 2 others
    await createUser(tid, { email: 'bob@z.com', name: 'Bob', role: 'reviewer' });
    await createUser(tid, { email: 'carol@z.com', name: 'Carol', role: 'reviewer' });
    await createUser(tid, { email: 'jane@z.com', name: 'Jane', role: 'reviewer' });
    await createUser(tid, { email: 'jack@z.com', name: 'Jack', role: 'reviewer' });
    await createUser(tid, { email: 'jfoo@z.com', name: 'Zara', role: 'reviewer' }); // email starts with j

    const { items } = await listUsers(tid, { search: 'j' });
    const names = items.map((u) => u.name);
    expect(names).toContain('Jane');
    expect(names).toContain('Jack');
    expect(names).toContain('Zara'); // email 'jfoo@z.com' matches
    expect(names).not.toContain('Bob');
    expect(names).not.toContain('Carol');
  });

  it('rejects pageSize > 100', async () => {
    await expect(listUsers(tenantA, { pageSize: 101 })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVALID_PAGE_SIZE',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: includeDeleted flag
// ---------------------------------------------------------------------------

describe('soft-delete visibility', () => {
  it('excludes soft-deleted by default; includeDeleted=true returns them', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-del-${tid.slice(0, 8)}`, 'Del Tenant');
    });

    // Need 2 admins so we can delete the first without hitting last-admin invariant
    const u1 = await createUser(tid, { email: 'del1@example.com', name: 'Del1', role: 'admin' });
    await createUser(tid, { email: 'del2@example.com', name: 'Del2', role: 'admin' });

    // Activate both so the last-admin check fires correctly
    await updateUser(tid, u1.id, { status: 'active' });
    const u2 = await createUser(tid, { email: 'del3@example.com', name: 'Del3', role: 'admin' });
    await updateUser(tid, u2.id, { status: 'active' });

    // Now soft-delete u1 (u2 is still active admin)
    await softDelete(tid, u1.id);

    const { items: withoutDeleted } = await listUsers(tid);
    const idsWithout = withoutDeleted.map((u) => u.id);
    expect(idsWithout).not.toContain(u1.id);

    const { items: withDeleted } = await listUsers(tid, { includeDeleted: true });
    const idsWith = withDeleted.map((u) => u.id);
    expect(idsWith).toContain(u1.id);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Last-admin invariant on softDelete
// ---------------------------------------------------------------------------

describe('last-admin invariant — softDelete', () => {
  it('blocks softDelete of sole active admin', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-la1-${tid.slice(0, 8)}`, 'LastAdmin1');
    });

    const admin = await createUser(tid, { email: 'only@admin.com', name: 'Only Admin', role: 'admin' });
    // Activate so they're the sole active admin
    await updateUser(tid, admin.id, { status: 'active' });

    await expect(softDelete(tid, admin.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'LAST_ADMIN',
    );
  });

  it('allows softDelete when a second admin exists', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-la2-${tid.slice(0, 8)}`, 'LastAdmin2');
    });

    const admin1 = await createUser(tid, { email: 'admin1@la.com', name: 'Admin1', role: 'admin' });
    const admin2 = await createUser(tid, { email: 'admin2@la.com', name: 'Admin2', role: 'admin' });
    await updateUser(tid, admin1.id, { status: 'active' });
    await updateUser(tid, admin2.id, { status: 'active' });

    // Should succeed — admin2 remains
    await expect(softDelete(tid, admin1.id)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 7: Last-admin invariant on role change
// ---------------------------------------------------------------------------

describe('last-admin invariant — role change', () => {
  it('blocks demoting sole active admin', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-rc1-${tid.slice(0, 8)}`, 'RoleChange1');
    });

    const admin = await createUser(tid, { email: 'solo@rc.com', name: 'Solo', role: 'admin' });
    await updateUser(tid, admin.id, { status: 'active' });

    await expect(updateUser(tid, admin.id, { role: 'reviewer' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'LAST_ADMIN',
    );
  });

  it('allows demotion when a second active admin exists', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-rc2-${tid.slice(0, 8)}`, 'RoleChange2');
    });

    const admin1 = await createUser(tid, { email: 'a1@rc.com', name: 'A1', role: 'admin' });
    const admin2 = await createUser(tid, { email: 'a2@rc.com', name: 'A2', role: 'admin' });
    await updateUser(tid, admin1.id, { status: 'active' });
    await updateUser(tid, admin2.id, { status: 'active' });

    const updated = await updateUser(tid, admin1.id, { role: 'reviewer' });
    expect(updated.role).toBe('reviewer');
  });
});

// ---------------------------------------------------------------------------
// Test 8: Status transition matrix
// ---------------------------------------------------------------------------

describe('status transition matrix', () => {
  async function makeTenantWithUser(suffix: string, role: 'admin' | 'reviewer', initialStatus: 'pending' | 'active' | 'disabled') {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-stm-${suffix}`, `STM ${suffix}`);
    });
    const user = await createUser(tid, { email: `stm${suffix}@x.com`, name: `STM ${suffix}`, role });
    if (initialStatus !== 'pending') {
      // pending → active first, then potentially → disabled
      await updateUser(tid, user.id, { status: 'active' });
      if (initialStatus === 'disabled') {
        await updateUser(tid, user.id, { status: 'disabled' });
      }
    }
    return { tid, userId: user.id };
  }

  it('allows pending → active', async () => {
    const { tid, userId } = await makeTenantWithUser('pa', 'reviewer', 'pending');
    const u = await updateUser(tid, userId, { status: 'active' });
    expect(u.status).toBe('active');
  });

  it('allows pending → disabled', async () => {
    const { tid, userId } = await makeTenantWithUser('pd', 'reviewer', 'pending');
    const u = await updateUser(tid, userId, { status: 'disabled' });
    expect(u.status).toBe('disabled');
  });

  it('allows active → disabled (with second admin present)', async () => {
    const { tid, userId } = await makeTenantWithUser('ad', 'reviewer', 'active');
    const u = await updateUser(tid, userId, { status: 'disabled' });
    expect(u.status).toBe('disabled');
  });

  it('allows disabled → active', async () => {
    const { tid, userId } = await makeTenantWithUser('da', 'reviewer', 'disabled');
    const u = await updateUser(tid, userId, { status: 'active' });
    expect(u.status).toBe('active');
  });

  it('rejects disabled → pending', async () => {
    const { tid, userId } = await makeTenantWithUser('dp', 'reviewer', 'disabled');
    await expect(updateUser(tid, userId, { status: 'pending' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVALID_STATUS_TRANSITION',
    );
  });

  it('rejects active → pending', async () => {
    const { tid, userId } = await makeTenantWithUser('ap', 'reviewer', 'active');
    await expect(updateUser(tid, userId, { status: 'pending' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVALID_STATUS_TRANSITION',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 9: inviteUser admin happy path + re-invite replaces invitation
// ---------------------------------------------------------------------------

describe('inviteUser', () => {
  it('happy path: creates user + invitation, token NOT returned, email stub called', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-inv-${tid.slice(0, 8)}`, 'Inv Tenant');
    });

    // Need an invited_by admin
    const inviter = await createUser(tid, { email: 'boss@inv.com', name: 'Boss', role: 'admin' });

    const result = await inviteUser(tid, {
      email: 'newbie@inv.com',
      role: 'reviewer',
      invited_by: inviter.id,
    });

    expect(result.user.email).toBe('newbie@inv.com');
    expect(result.user.status).toBe('pending');
    expect(result.invitation).not.toBeNull();
    // No token field on the invitation
    expect(result.invitation).not.toHaveProperty('token');

    // Email stub must have been called
    expect(capturedEmails).toHaveLength(1);
    expect(capturedEmails[0]?.to).toBe('newbie@inv.com');
    // Token must appear in the invitationLink
    expect(capturedEmails[0]?.invitationLink).toMatch(/token=/);
  });

  it('re-invite pending user replaces invitation (old token_hash gone)', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-reinv-${tid.slice(0, 8)}`, 'ReInv Tenant');
    });
    const inviter = await createUser(tid, { email: 'boss@reinv.com', name: 'Boss', role: 'admin' });

    // First invite
    const first = await inviteUser(tid, { email: 'pending@reinv.com', role: 'reviewer', invited_by: inviter.id });
    const firstInvId = first.invitation?.id;
    expect(firstInvId).toBeDefined();

    capturedEmails.length = 0;

    // Second invite — same email, same tenant
    const second = await inviteUser(tid, { email: 'pending@reinv.com', role: 'reviewer', invited_by: inviter.id });
    expect(second.invitation?.id).not.toBe(firstInvId); // new row
    expect(capturedEmails).toHaveLength(1); // new email sent
  });
});

// ---------------------------------------------------------------------------
// Test 10: inviteUser candidate role → 501
// ---------------------------------------------------------------------------

it('inviteUser with candidate role throws CANDIDATE_INVITATION_PHASE_1', async () => {
  const tid = randomUUID();
  await withSuperClient(async (client) => {
    await insertTenant(client, tid, `tenant-cand-${tid.slice(0, 8)}`, 'Cand Tenant');
  });

  await expect(
    inviteUser(tid, { email: 'cand@x.com', role: 'candidate', invited_by: randomUUID() }),
  ).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof ValidationError &&
      (e.details as Record<string, unknown> | undefined)?.['code'] === 'CANDIDATE_INVITATION_PHASE_1',
  );
});

// ---------------------------------------------------------------------------
// Test 11: acceptInvitation happy path
// ---------------------------------------------------------------------------

describe('acceptInvitation', () => {
  it('happy path: invite → accept → user active, real session token minted', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-accept-${tid.slice(0, 8)}`, 'Accept Tenant');
    });
    const inviter = await createUser(tid, { email: 'boss@accept.com', name: 'Boss', role: 'admin' });

    capturedEmails.length = 0;
    await inviteUser(tid, { email: 'newrev@accept.com', role: 'reviewer', invited_by: inviter.id });

    // Extract plaintext token from captured email link
    const link = capturedEmails[0]?.invitationLink ?? '';
    const tokenMatch = /token=([^&]+)/.exec(link);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1]!;

    const result = await acceptInvitation(token);

    expect(result.user.email).toBe('newrev@accept.com');
    expect(result.user.status).toBe('active');
    // Real session token: 43-char base64url (32 bytes of entropy via
    // randomTokenBase64Url(32)) — distinct from the legacy mock prefix.
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Test 12: acceptInvitation expired
  // ---------------------------------------------------------------------------

  it('rejects expired invitation', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-exp-${tid.slice(0, 8)}`, 'Exp Tenant');
    });
    const inviter = await createUser(tid, { email: 'boss@exp.com', name: 'Boss', role: 'admin' });

    capturedEmails.length = 0;
    await inviteUser(tid, { email: 'expired@exp.com', role: 'reviewer', invited_by: inviter.id });
    const link = capturedEmails[0]?.invitationLink ?? '';
    const token = /token=([^&]+)/.exec(link)?.[1] ?? '';

    // Back-date the invitation's expires_at in the DB
    await withSuperClient(async (client) => {
      await client.query(
        `UPDATE user_invitations SET expires_at = now() - interval '1 day'
          WHERE lower(email) = 'expired@exp.com' AND accepted_at IS NULL`,
      );
    });

    await expect(acceptInvitation(token)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVITATION_EXPIRED',
    );
  });

  // ---------------------------------------------------------------------------
  // Test 13: acceptInvitation already-used
  // ---------------------------------------------------------------------------

  it('rejects already-used invitation', async () => {
    const tid = randomUUID();
    await withSuperClient(async (client) => {
      await insertTenant(client, tid, `tenant-used-${tid.slice(0, 8)}`, 'Used Tenant');
    });
    const inviter = await createUser(tid, { email: 'boss@used.com', name: 'Boss', role: 'admin' });

    capturedEmails.length = 0;
    await inviteUser(tid, { email: 'onceonly@used.com', role: 'reviewer', invited_by: inviter.id });
    const token = /token=([^&]+)/.exec(capturedEmails[0]?.invitationLink ?? '')?.[1] ?? '';

    // First acceptance should succeed
    await acceptInvitation(token);

    // Second acceptance must fail
    await expect(acceptInvitation(token)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConflictError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVITATION_ALREADY_USED',
    );
  });

  // ---------------------------------------------------------------------------
  // Test 14: acceptInvitation unknown token
  // ---------------------------------------------------------------------------

  it('rejects unknown token with INVITATION_NOT_FOUND', async () => {
    await expect(acceptInvitation('totallyfaketoken_that_does_not_exist_in_db')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NotFoundError &&
        (e.details as Record<string, unknown> | undefined)?.['code'] === 'INVITATION_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 15: Cross-tenant isolation
// ---------------------------------------------------------------------------

describe('cross-tenant isolation', () => {
  it('listUsers under tenantA returns only tenantA users', async () => {
    // Use tenantA and tenantB seeded in beforeAll. Each has users from other tests.
    // Seed a fresh user in each so we can assert isolation.
    const ua = await createUser(tenantA, { email: `iso-a-${randomUUID().slice(0, 8)}@x.com`, name: 'IsoA', role: 'reviewer' });
    const ub = await createUser(tenantB, { email: `iso-b-${randomUUID().slice(0, 8)}@x.com`, name: 'IsoB', role: 'reviewer' });

    const { items: aItems } = await listUsers(tenantA, { includeDeleted: true });
    const aIds = aItems.map((u) => u.id);
    expect(aIds).toContain(ua.id);
    expect(aIds).not.toContain(ub.id);
  });

  it('getUser(tenantA, idFromB) throws NotFoundError', async () => {
    const ub = await createUser(tenantB, {
      email: `cross-${randomUUID().slice(0, 8)}@b.com`,
      name: 'CrossB',
      role: 'reviewer',
    });

    await expect(getUser(tenantA, ub.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Test 16: softDelete cascades to pending invitations
// ---------------------------------------------------------------------------

it('softDelete cascades: pending invitations for the user are deleted', async () => {
  const tid = randomUUID();
  await withSuperClient(async (client) => {
    await insertTenant(client, tid, `tenant-casc-${tid.slice(0, 8)}`, 'Casc Tenant');
  });

  // Create an admin (inviter) and a second admin so last-admin invariant doesn't block
  const admin1 = await createUser(tid, { email: 'admin1@casc.com', name: 'Admin1', role: 'admin' });
  const admin2 = await createUser(tid, { email: 'admin2@casc.com', name: 'Admin2', role: 'admin' });
  await updateUser(tid, admin1.id, { status: 'active' });
  await updateUser(tid, admin2.id, { status: 'active' });

  // Invite a pending reviewer — creates user + invitation
  capturedEmails.length = 0;
  const invResult = await inviteUser(tid, {
    email: 'toberemoved@casc.com',
    role: 'reviewer',
    invited_by: admin1.id,
  });
  const pendingUserId = invResult.user.id;

  // Verify invitation exists
  const beforeRows = await withSuperClient(async (client) => {
    const r = await client.query(
      `SELECT id FROM user_invitations WHERE lower(email) = 'toberemoved@casc.com' AND accepted_at IS NULL`,
    );
    return r.rows;
  });
  expect(beforeRows.length).toBeGreaterThan(0);

  // softDelete the pending user — must cascade to invitation
  await softDelete(tid, pendingUserId);

  const afterRows = await withSuperClient(async (client) => {
    const r = await client.query(
      `SELECT id FROM user_invitations WHERE lower(email) = 'toberemoved@casc.com' AND accepted_at IS NULL`,
    );
    return r.rows;
  });
  expect(afterRows).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: Redis sweep (stubbed — no Redis container in Phase 0)
// ---------------------------------------------------------------------------

test.todo(
  'Redis sweep: sweepUserSessions removes all session keys from the per-user index [TODO(phase-1): Redis sweep integration test — requires Redis testcontainer]',
);
