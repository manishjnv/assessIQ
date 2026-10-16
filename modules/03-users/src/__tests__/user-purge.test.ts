/**
 * LC-2 — purgeSoftDeletedUsers integration tests (postgres:16-alpine testcontainer).
 * Docker required. No Redis: the purge touches Postgres only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool } from '../../../02-tenancy/src/pool.js';
import { purgeSoftDeletedUsers, MIN_USER_PURGE_DAYS } from '../purge.js';

let container: StartedTestContainer;
let containerUrl: string;

const tenantA = randomUUID();
const tenantB = randomUUID();
const soleAdminA = randomUUID(); // soft-deleted 200d, only admin -> skipped last_admin
const oldCandA = randomUUID(); // soft-deleted 200d -> purged
const recentCandA = randomUUID(); // soft-deleted 10d -> untouched
const midCandA = randomUUID(); // soft-deleted 100d -> untouched (clamp check)
const oldCandB = randomUUID(); // tenant B, soft-deleted 200d -> purged
const OLD_EMAIL = 'old.candidate@example.com';

async function withSuper<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: containerUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function insertUser(
  c: Client,
  id: string,
  tenantId: string,
  email: string,
  role: 'admin' | 'candidate',
  deletedDaysAgo: number,
): Promise<void> {
  await c.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status, metadata, deleted_at)
     VALUES ($1, $2, $3, $4, $5, 'active', '{"roll_number":"R1","branch":"CS","keep":"x"}'::jsonb,
             now() - make_interval(days => $6::int))`,
    [id, tenantId, email, `Name ${email}`, role, deletedDaysAgo],
  );
}

async function insertSession(c: Client, userId: string, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO sessions (user_id, tenant_id, role, token_hash, expires_at)
     VALUES ($1, $2, 'candidate', $3, now() + interval '1 day')`,
    [userId, tenantId, `th-${randomUUID()}`],
  );
}

async function snapshot(): Promise<string> {
  return withSuper(async (c) => {
    const u = await c.query(`SELECT id, name, email, status, erased_at, metadata FROM users ORDER BY id`);
    const s = await c.query(`SELECT count(*)::int AS n FROM sessions`);
    const a = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.purged'`);
    return JSON.stringify([u.rows, s.rows, a.rows]);
  });
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  containerUrl = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/aiq_test`;

  await withSuper(async (c) => {
    await applyAllMigrations(c);
    await c.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO assessiq_app`);
    await c.query(`GRANT SELECT, INSERT ON audit_log TO assessiq_app`);

    for (const [id, slug] of [
      [tenantA, 'purge-a'],
      [tenantB, 'purge-b'],
    ] as const) {
      await c.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, slug, slug]);
      await c.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
    }

    await insertUser(c, soleAdminA, tenantA, 'sole.admin@example.com', 'admin', 200);
    await insertUser(c, oldCandA, tenantA, OLD_EMAIL, 'candidate', 200);
    await insertUser(c, recentCandA, tenantA, 'recent@example.com', 'candidate', 10);
    await insertUser(c, midCandA, tenantA, 'mid@example.com', 'candidate', 100);
    await insertUser(c, oldCandB, tenantB, 'b.old@example.com', 'candidate', 200);

    for (const [uid, tid] of [
      [oldCandA, tenantA],
      [recentCandA, tenantA],
      [soleAdminA, tenantA],
      [oldCandB, tenantB],
    ] as const) {
      await insertSession(c, uid, tid);
    }

    // Pending invitation for the purged candidate's email (inviter = soleAdminA, kept).
    await c.query(
      `INSERT INTO user_invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'candidate', $3, $4, now() + interval '1 day')`,
      [tenantA, OLD_EMAIL.toUpperCase(), `inv-${randomUUID()}`, soleAdminA],
    );

    // Attempt rows of the purged candidates must survive. FK checks off for this
    // seed only (session-level, superuser): the assessment graph is irrelevant here.
    await c.query(`SET session_replication_role = replica`);
    await c.query(
      `INSERT INTO attempts (tenant_id, assessment_id, user_id, status) VALUES ($1, $2, $3, 'submitted')`,
      [tenantA, randomUUID(), oldCandA],
    );
    await c.query(
      `INSERT INTO attempts (tenant_id, assessment_id, user_id, status) VALUES ($1, $2, $3, 'submitted')`,
      [tenantB, randomUUID(), oldCandB],
    );
    await c.query(`SET session_replication_role = DEFAULT`);
  });

  await setPoolForTesting(containerUrl);
}, 240_000);

afterAll(async () => {
  await closePool();
  if (container !== undefined) await container.stop();
});

describe('purgeSoftDeletedUsers', () => {
  it('clamps minDays to the 180-day floor (unit)', () => {
    expect(MIN_USER_PURGE_DAYS).toBe(180);
  });

  it('dry run reports candidates and changes no row', async () => {
    const before = await snapshot();
    const rep = await purgeSoftDeletedUsers({ minDays: 1 }); // enabled omitted = dry run; minDays clamped
    expect(rep.dryRun).toBe(true);
    const a = rep.tenants.find((t) => t.tenantId === tenantA)!;
    const b = rep.tenants.find((t) => t.tenantId === tenantB)!;
    expect(a.purged).toEqual([oldCandA]); // mid (100d) NOT selected: minDays 1 clamped to 180
    expect(a.skipped).toEqual([{ userId: soleAdminA, reason: 'last_admin' }]);
    expect(b.purged).toEqual([oldCandB]);
    expect(rep.totalPurged).toBe(2);
    expect(await snapshot()).toBe(before);
  });

  it('purges per tenant, tombstones the row, keeps business rows, audits as system', async () => {
    const rep = await purgeSoftDeletedUsers({ enabled: true });
    expect(rep.dryRun).toBe(false);
    expect(rep.totalPurged).toBe(2);
    expect(rep.tenants.find((t) => t.tenantId === tenantA)!.purged).toEqual([oldCandA]);
    expect(rep.tenants.find((t) => t.tenantId === tenantB)!.purged).toEqual([oldCandB]);
    expect(rep.tenants.every((t) => t.error === undefined)).toBe(true);

    await withSuper(async (c) => {
      const u = await c.query(
        `SELECT name, email, status, erased_at, deleted_at, metadata FROM users WHERE id = $1`,
        [oldCandA],
      );
      const row = u.rows[0];
      expect(row.name).toMatch(/^deleted_user_[0-9a-f]{12}$/);
      expect(row.email).toMatch(/^deleted\+[0-9a-f]{12}@erased\.assessiq\.local$/);
      expect(row.status).toBe('disabled');
      expect(row.erased_at).not.toBeNull();
      expect(row.deleted_at).not.toBeNull();
      expect(row.metadata).toEqual({ keep: 'x' });

      const sess = async (id: string): Promise<number> =>
        (await c.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [id])).rows[0].n;
      expect(await sess(oldCandA)).toBe(0);
      expect(await sess(oldCandB)).toBe(0);
      expect(await sess(recentCandA)).toBe(1);
      expect(await sess(soleAdminA)).toBe(1);

      const inv = await c.query(`SELECT count(*)::int AS n FROM user_invitations WHERE tenant_id = $1`, [tenantA]);
      expect(inv.rows[0].n).toBe(0);

      const att = await c.query(`SELECT user_id FROM attempts ORDER BY tenant_id`);
      expect(att.rows.map((r) => r.user_id).sort()).toEqual([oldCandA, oldCandB].sort());

      const audit = await c.query(
        `SELECT tenant_id, actor_kind, actor_user_id, entity_type, entity_id, after::text AS after
           FROM audit_log WHERE action = 'user.purged' ORDER BY tenant_id`,
      );
      expect(audit.rows).toHaveLength(2);
      for (const r of audit.rows) {
        expect(r.actor_kind).toBe('system');
        expect(r.actor_user_id).toBeNull();
        expect(r.entity_type).toBe('user');
        expect(r.after).not.toContain('example.com');
        expect(JSON.parse(r.after).tables.sessions).toBe(1);
      }
      const forA = audit.rows.find((r) => r.tenant_id === tenantA);
      expect(forA.entity_id).toBe(oldCandA);

      // Untouched rows.
      for (const id of [soleAdminA, recentCandA, midCandA]) {
        const r = await c.query(`SELECT erased_at, status FROM users WHERE id = $1`, [id]);
        expect(r.rows[0].erased_at).toBeNull();
        expect(r.rows[0].status).toBe('active');
      }
    });
  });

  it('refuses to restore a purged tombstone (409 USER_PURGED)', async () => {
    const { restore } = await import('../service.js');
    await expect(restore(tenantA, oldCandA, soleAdminA)).rejects.toMatchObject({
      details: { code: 'USER_PURGED' },
    });
    await withSuper(async (c) => {
      const r = await c.query(`SELECT erased_at, deleted_at FROM users WHERE id = $1`, [oldCandA]);
      expect(r.rows[0].erased_at).not.toBeNull();
      expect(r.rows[0].deleted_at).not.toBeNull();
    });
  });

  it('is idempotent: a second run purges nothing more', async () => {
    const rep = await purgeSoftDeletedUsers({ enabled: true });
    expect(rep.totalPurged).toBe(0);
    expect(rep.tenants.flatMap((t) => t.skipped)).toEqual([{ userId: soleAdminA, reason: 'last_admin' }]);
  });
});
