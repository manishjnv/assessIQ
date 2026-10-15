// AssessIQ — RW-47: revokeEntitlement archives the tenant's cloned packs (same tx).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';
import { grantEntitlement, revokeEntitlement } from '../service.js';

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const dockerAvailable = isDockerAvailable();
if (!dockerAvailable && (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')) {
  throw new Error('Docker testcontainer required but unavailable in CI.');
}

let container: StartedTestContainer;
let url: string;
const T1 = randomUUID(); // revoking tenant
const T2 = randomUUID(); // bystander tenant
const PLATFORM = randomUUID();
const ACTOR = randomUUID();
const SRC_A = randomUUID(); // domain "rw47"
const SRC_B = randomUUID(); // domain "rw47"
const SRC_C = randomUUID(); // domain "other"
const CLONE: Record<string, string> = {}; // key `${tenant}:${src}` -> clone id
let QUESTION_ID: string;

async function db<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const statusOf = (id: string) =>
  db(async (c) => (await c.query(`SELECT status FROM question_packs WHERE id=$1`, [id])).rows[0].status as string);

async function seedPack(c: Client, id: string, tenant: string, slug: string, domain: string, src: string | null) {
  await c.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, created_by, source_pack_id, source_version)
     VALUES ($1,$2,$3,$3,$4,'published',$5,$6,$7)`,
    [id, tenant, slug, domain, ACTOR, src, src ? 1 : null],
  );
}

async function reset(): Promise<void> {
  await db(async (c) => {
    await c.query(`DROP TRIGGER IF EXISTS boom ON question_packs`);
    await c.query(`UPDATE question_packs SET status='published' WHERE source_pack_id IS NOT NULL`);
    await c.query(`DELETE FROM tenant_entitlements`);
    await c.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [T1]);
  });
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withExposedPorts(5432)
    .start();
  url = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  await setPoolForTesting(url);
  await db(async (c) => {
    await applyAllMigrations(c);
    for (const [id, slug] of [[T1, 't1'], [T2, 't2'], [PLATFORM, 'plat']]) {
      await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1,$2,$2,'active')`, [id, `rw47-${slug}`]);
    }
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,'a@rw47.test','A','admin')`, [ACTOR, T1]);
    for (const t of [T1, T2]) {
      await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1,'free',25)`, [t]);
    }
    await seedPack(c, SRC_A, PLATFORM, 'src-a', 'rw47', null);
    await seedPack(c, SRC_B, PLATFORM, 'src-b', 'rw47', null);
    await seedPack(c, SRC_C, PLATFORM, 'src-c', 'other', null);
    for (const t of [T1, T2]) {
      for (const s of [SRC_A, SRC_B, SRC_C]) {
        const id = randomUUID();
        CLONE[`${t}:${s}`] = id;
        await seedPack(c, id, t, `clone-${s.slice(0, 4)}`, s === SRC_C ? 'other' : 'rw47', s);
      }
    }
    const lvl = (
      await c.query(
        `INSERT INTO levels (pack_id, position, label, duration_minutes, default_question_count)
         VALUES ($1,1,'L1',10,1) RETURNING id`,
        [CLONE[`${T1}:${SRC_A}`]],
      )
    ).rows[0].id;
    QUESTION_ID = (
      await c.query(
        `INSERT INTO questions (pack_id, level_id, type, topic, points, status, content, created_by)
         VALUES ($1,$2,'mcq','t',1,'active','{"q":"x"}',$3) RETURNING id`,
        [CLONE[`${T1}:${SRC_A}`], lvl, ACTOR],
      )
    ).rows[0].id;
  });
}, 300_000);

afterAll(async () => {
  if (dockerAvailable) {
    await closePool();
    if (container) await container.stop();
  }
});

describe('revokeEntitlement — clone archive (RW-47)', () => {
  it.skipIf(!dockerAvailable)('pack scope archives only that pack clone for that tenant + audits once', async () => {
    await reset();
    await grantEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A });
    await revokeEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A });
    expect(await statusOf(CLONE[`${T1}:${SRC_A}`]!)).toBe('archived');
    expect(await statusOf(CLONE[`${T1}:${SRC_B}`]!)).toBe('published');
    expect(await statusOf(CLONE[`${T2}:${SRC_A}`]!)).toBe('published');
    expect(await statusOf(SRC_A)).toBe('published'); // platform source untouched
    const rows = await db(async (c) =>
      (await c.query(`SELECT after FROM audit_log WHERE tenant_id=$1 AND action='tenant.pack_clone_archived'`, [T1])).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after.archived_clone_ids).toEqual([CLONE[`${T1}:${SRC_A}`]]);
    expect(rows[0].after.archived_count).toBe(1);
  });

  it.skipIf(!dockerAvailable)('domain scope archives every clone in the domain for the tenant only', async () => {
    await reset();
    await grantEntitlement(ACTOR, T1, { scopeType: 'domain', scopeId: 'rw47' });
    await revokeEntitlement(ACTOR, T1, { scopeType: 'domain', scopeId: 'rw47' });
    expect(await statusOf(CLONE[`${T1}:${SRC_A}`]!)).toBe('archived');
    expect(await statusOf(CLONE[`${T1}:${SRC_B}`]!)).toBe('archived');
    expect(await statusOf(CLONE[`${T1}:${SRC_C}`]!)).toBe('published');
    expect(await statusOf(CLONE[`${T2}:${SRC_A}`]!)).toBe('published');
  });

  it.skipIf(!dockerAvailable)('cloned questions survive the archive (attempts snapshot / resolve them)', async () => {
    await reset();
    await grantEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A });
    await revokeEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A });
    const q = await db(async (c) =>
      (await c.query(`SELECT status, content FROM questions WHERE id=$1`, [QUESTION_ID])).rows[0],
    );
    expect(q.status).toBe('active');
    expect(q.content).toEqual({ q: 'x' });
  });

  it.skipIf(!dockerAvailable)('archive failure rolls back the entitlement revoke and the audit', async () => {
    await reset();
    await grantEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A });
    await db(async (c) => {
      await c.query(
        `CREATE OR REPLACE FUNCTION rw47_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`,
      );
      await c.query(
        `CREATE TRIGGER boom BEFORE UPDATE ON question_packs FOR EACH ROW WHEN (NEW.status='archived') EXECUTE FUNCTION rw47_boom()`,
      );
    });
    await expect(revokeEntitlement(ACTOR, T1, { scopeType: 'pack', scopeId: SRC_A })).rejects.toThrow();
    await db(async (c) => {
      await c.query(`DROP TRIGGER boom ON question_packs`);
      const e = await c.query(`SELECT status FROM tenant_entitlements WHERE tenant_id=$1 AND scope_id=$2`, [T1, SRC_A]);
      expect(e.rows[0].status).toBe('active');
      const a = await c.query(`SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='tenant.entitlement_revoked'`, [T1]);
      expect(a.rowCount).toBe(0);
    });
    expect(await statusOf(CLONE[`${T1}:${SRC_A}`]!)).toBe('published');
  });
});
