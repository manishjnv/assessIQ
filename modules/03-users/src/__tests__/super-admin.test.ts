/**
 * RW-36(a): super-admin user queries moved out of
 * apps/api/src/routes/admin-super/users.ts into 03-users repository + service.
 * Live Postgres (RLS + audit_log), same harness as users.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool } from '../../../02-tenancy/src/pool.js';
import {
  listTenantUsersForSuperAdmin,
  resolveUserTenant,
  findTenantFirstAdmin,
  resolvePendingInvitationTenant,
  disableUserAsSuperAdmin,
  reenableUserAsSuperAdmin,
  softDeleteUserAsSuperAdmin,
  restoreUserAsSuperAdmin,
  updateUserProfileAsSuperAdmin,
} from '../super-admin.js';

let container: StartedTestContainer;
let url: string;
const T = randomUUID();
const ADMIN = randomUUID(); // first admin, active
const ADMIN2 = randomUUID(); // second admin, active
const PENDING = randomUUID(); // pending admin-less user for profile edit
const INV = randomUUID();
const ACCEPTED_INV = randomUUID();

async function sql<R = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<R[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as R[];
  } finally {
    await c.end();
  }
}

const auditActions = async (userId: string): Promise<string[]> =>
  (await sql<{ action: string }>(
    `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at ASC`,
    [userId],
  )).map((r) => r.action);

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await applyAllMigrations(c);
  await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
  await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);
  await c.end();
  await setPoolForTesting(url);

  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'sa-t', 'SA Tenant')`, [T]);
  await sql(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [T]);
  await sql(
    `INSERT INTO users (id, tenant_id, email, name, role, status, created_at) VALUES
       ($1, $4, 'a1@sa.test', 'Admin One', 'admin', 'active', now() - interval '2 day'),
       ($2, $4, 'a2@sa.test', 'Admin Two', 'admin', 'active', now() - interval '1 day'),
       ($3, $4, 'p@sa.test', 'Pending P', 'admin', 'pending', now())`,
    [ADMIN, ADMIN2, PENDING, T],
  );
  await sql(
    `INSERT INTO user_credentials (user_id, tenant_id, totp_secret_enc, totp_enrolled_at) VALUES ($1, $2, decode('00', 'hex'), now())`,
    [ADMIN, T],
  );
  await sql(
    `INSERT INTO user_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, 'p@sa.test', 'admin', 'h1', $3, now() + interval '1 day')`,
    [INV, T, ADMIN],
  );
  await sql(
    `INSERT INTO user_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at, accepted_at)
     VALUES ($1, $2, 'done@sa.test', 'admin', 'h2', $3, now() + interval '1 day', now())`,
    [ACCEPTED_INV, T, ADMIN],
  );
}, 120_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe('system-role reads', () => {
  it('lists users + pending invitations for a tenant', async () => {
    const r = await listTenantUsersForSuperAdmin(T, { includeDisabled: false, includeDeleted: false });
    expect(r.users.map((u) => u.email)).toEqual(['p@sa.test', 'a2@sa.test', 'a1@sa.test']);
    expect(r.pending_invitations.map((i) => i.id)).toEqual([INV]);
    // totp_enrolled: true only for the user with a TOTP secret set (a1).
    expect(r.users.map((u) => [u.email, u.totp_enrolled])).toEqual([
      ['p@sa.test', false],
      ['a2@sa.test', false],
      ['a1@sa.test', true],
    ]);
  });

  it('resolves user tenant, first admin and invitation tenant', async () => {
    expect(await resolveUserTenant(ADMIN)).toMatchObject({ tenantId: T, email: 'a1@sa.test', role: 'admin' });
    expect(await resolveUserTenant(randomUUID())).toBeNull();
    expect(await findTenantFirstAdmin(T)).toMatchObject({ id: ADMIN, email: 'a1@sa.test' });
    expect(await resolvePendingInvitationTenant(INV)).toBe(T);
    await expect(resolvePendingInvitationTenant(randomUUID())).rejects.toThrow(/Invitation not found/);
    await expect(resolvePendingInvitationTenant(ACCEPTED_INV)).rejects.toThrow(/already been accepted/);
  });
});

describe('lifecycle mutations (tx + audit)', () => {
  it('disable / reenable write audit rows; last-admin guard + override', async () => {
    const target = (await resolveUserTenant(ADMIN2))!;
    const d = await disableUserAsSuperAdmin({
      target, userId: ADMIN2, actorUserId: ADMIN, reason: undefined, confirmLastAdmin: false,
    });
    expect(d).toMatchObject({ id: ADMIN2, status: 'disabled', isOverride: false });

    // ADMIN is now the last active admin.
    const t1 = (await resolveUserTenant(ADMIN))!;
    await expect(
      disableUserAsSuperAdmin({ target: t1, userId: ADMIN, actorUserId: ADMIN, reason: undefined, confirmLastAdmin: false }),
    ).rejects.toThrow(/last active admin/);

    const re = await reenableUserAsSuperAdmin({
      target: (await resolveUserTenant(ADMIN2))!, userId: ADMIN2, actorUserId: ADMIN, reason: 'back',
    });
    expect(re).toMatchObject({ id: ADMIN2, status: 'active' });
    expect(await auditActions(ADMIN2)).toEqual(['user.disabled', 'user.reenabled']);
  });

  it('soft-delete cascades pending invitation; restore clears deleted_at', async () => {
    const target = (await resolveUserTenant(PENDING))!;
    await softDeleteUserAsSuperAdmin({
      target, userId: PENDING, actorUserId: ADMIN, reason: undefined, confirmLastAdmin: false,
    });
    expect((await sql(`SELECT deleted_at FROM users WHERE id = $1`, [PENDING]))[0]!.deleted_at).not.toBeNull();
    expect(await sql(`SELECT 1 FROM user_invitations WHERE id = $1`, [INV])).toHaveLength(0);

    const r = await restoreUserAsSuperAdmin({
      target: (await resolveUserTenant(PENDING))!, userId: PENDING, actorUserId: ADMIN, reason: undefined,
    });
    expect(r.deleted_at).toBeNull();
    expect(await auditActions(PENDING)).toEqual(['user.soft_deleted', 'user.restored']);
  });

  it('profile edit changes name+email, drops google link, audits once, maps unique violation', async () => {
    await sql(
      `INSERT INTO oauth_identities (tenant_id, user_id, provider, subject) VALUES ($1, $2, 'google', 'sub-1')`,
      [T, ADMIN2],
    );
    const target = (await resolveUserTenant(ADMIN2))!;
    const auditId = await updateUserProfileAsSuperAdmin({
      target, userId: ADMIN2, actorUserId: ADMIN, reason: 'fix',
      newName: 'Admin Two B', newRole: undefined, newEmail: 'a2b@sa.test',
      nameChanged: true, roleChanged: false, emailChanged: true, wasPending: false, currentEmail: 'a2@sa.test',
    });
    expect(auditId).not.toBeNull();
    const u = (await sql<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [ADMIN2]))[0]!;
    expect(u).toMatchObject({ name: 'Admin Two B', email: 'a2b@sa.test' });
    expect(await sql(`SELECT 1 FROM oauth_identities WHERE user_id = $1`, [ADMIN2])).toHaveLength(0);

    await expect(
      updateUserProfileAsSuperAdmin({
        target: (await resolveUserTenant(ADMIN2))!, userId: ADMIN2, actorUserId: ADMIN, reason: undefined,
        newName: undefined, newRole: undefined, newEmail: 'a1@sa.test',
        nameChanged: false, roleChanged: false, emailChanged: true, wasPending: false, currentEmail: 'a2b@sa.test',
      }),
    ).rejects.toMatchObject({ details: { code: 'USER_EMAIL_EXISTS' } });
  });
});
