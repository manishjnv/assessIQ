/**
 * jit-user.test.ts — DB-backed test of the REAL resolveJitUser insert path
 * (FR4 / RV43 / BUG-A). Ephemeral postgres via testcontainers; all module
 * migrations applied with the shared helper.
 *
 * INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { AuthzError } from '@assessiq/core';
import { resolveJitUser } from '../jit-user.js';

let pgContainer: StartedTestContainer;
let pgUrl: string;

async function sql<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: pgUrl });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

async function createTenant(): Promise<string> {
  const id = randomUUID();
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [id, `t-${id.slice(0, 8)}`]);
  return id;
}

const input = (tenantId: string, email: string) => ({
  tenantId,
  email,
  name: 'Jit Candidate',
  externalSub: 'host-sub-1',
});

beforeAll(async () => {
  pgContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  pgUrl = `postgres://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/aiq_test`;
  const c = new Client({ connectionString: pgUrl });
  await c.connect();
  try {
    await applyAllMigrations(c);
  } finally {
    await c.end();
  }
  await setPoolForTesting(pgUrl);
}, 120_000);

afterAll(async () => {
  await closePool();
  await pgContainer?.stop();
});

describe('resolveJitUser (real insert path)', () => {
  it('creates a new active candidate with external_id metadata', async () => {
    const t = await createTenant();
    const r = await resolveJitUser(input(t, 'New.User@Embed.Test'));
    expect(r.created).toBe(true);
    const [row] = await sql<{ email: string; role: string; status: string; metadata: { external_id: string } }>(
      `SELECT email, role, status, metadata FROM users WHERE id = $1`,
      [r.userId],
    );
    expect(row).toMatchObject({ email: 'new.user@embed.test', role: 'candidate', status: 'active' });
    expect(row?.metadata.external_id).toBe('host-sub-1');
  });

  it('second call returns the same user with created=false', async () => {
    const t = await createTenant();
    const a = await resolveJitUser(input(t, 'again@embed.test'));
    const b = await resolveJitUser(input(t, 'again@embed.test'));
    expect(b).toEqual({ userId: a.userId, created: false });
  });

  it('concurrent double-call does not throw and yields one user', async () => {
    const t = await createTenant();
    const [a, b] = await Promise.all([
      resolveJitUser(input(t, 'race@embed.test')),
      resolveJitUser(input(t, 'race@embed.test')),
    ]);
    expect(a.userId).toBe(b.userId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const rows = await sql(`SELECT 1 FROM users WHERE tenant_id = $1 AND email = 'race@embed.test'`, [t]);
    expect(rows).toHaveLength(1);
  });

  it('refuses an erased user', async () => {
    const t = await createTenant();
    const { userId } = await resolveJitUser(input(t, 'erased@embed.test'));
    await sql(`UPDATE users SET erased_at = now() WHERE id = $1`, [userId]);
    await expect(resolveJitUser(input(t, 'erased@embed.test'))).rejects.toBeInstanceOf(AuthzError);
  });

  it('refuses a soft-deleted or disabled user', async () => {
    const t = await createTenant();
    const del = await resolveJitUser(input(t, 'deleted@embed.test'));
    await sql(`UPDATE users SET deleted_at = now() WHERE id = $1`, [del.userId]);
    await expect(resolveJitUser(input(t, 'deleted@embed.test'))).rejects.toBeInstanceOf(AuthzError);
    const dis = await resolveJitUser(input(t, 'disabled@embed.test'));
    await sql(`UPDATE users SET status = 'disabled' WHERE id = $1`, [dis.userId]);
    await expect(resolveJitUser(input(t, 'disabled@embed.test'))).rejects.toBeInstanceOf(AuthzError);
  });

  it('refuses an admin with the same email', async () => {
    const t = await createTenant();
    await sql(
      `INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, 'boss@embed.test', 'Boss', 'admin')`,
      [randomUUID(), t],
    );
    await expect(resolveJitUser(input(t, 'boss@embed.test'))).rejects.toBeInstanceOf(AuthzError);
  });

  it('same email in another tenant is a different user', async () => {
    const t1 = await createTenant();
    const t2 = await createTenant();
    const a = await resolveJitUser(input(t1, 'shared@embed.test'));
    const b = await resolveJitUser(input(t2, 'shared@embed.test'));
    expect(b.created).toBe(true);
    expect(b.userId).not.toBe(a.userId);
  });
});
