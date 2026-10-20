/**
 * Z-71: provisionSelfServePlan / provisionDefaultPlanInTx. Live Postgres.
 * Free plan + monthly credit grant + sample-set entitlements share the caller's transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool, withSystemRole } from '@assessiq/tenancy';
import { provisionDefaultPlan, DEFAULT_FREE_CREDITS } from '../service.js';
import { provisionSelfServePlan, FREE_SAMPLE_PACK_SLUGS } from '../self-serve-plan.js';

let container: StartedTestContainer;
let db: Client;
let platformId: string;
let platformUser: string;

const mkTenant = async (slug: string): Promise<string> => {
  const id = randomUUID();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$2)`, [id, slug]);
  await db.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [id]);
  return id;
};
const mkPack = async (slug: string, status: string, version: number): Promise<string> => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by)
     VALUES ($1,$2,$3,$3,'aptitude',$4,$5,$6)`,
    [id, platformId, slug, status, version, platformUser],
  );
  return id;
};
const n = async (sql: string, args: unknown[]): Promise<number> => Number((await db.query(sql, args)).rows[0].n);

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'assessiq', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'assessiq' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  const url = `postgres://assessiq:pw@${container.getHost()}:${container.getMappedPort(5432)}/assessiq`;
  db = new Client({ connectionString: url });
  await db.connect();
  await applyAllMigrations(db);
  setPoolForTesting(url);
  platformId = (await db.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows[0].id as string;
  platformUser = randomUUID();
  await db.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,'content@platform.test','C','admin')`, [platformUser, platformId]);
}, 120_000);

afterAll(async () => {
  await closePool();
  await db?.end();
  if (container !== undefined) await container.stop();
});

describe('provisionSelfServePlan', () => {
  it('creates the Free plan, the monthly credit grant and an entitlement for the latest published sample pack', async () => {
    const slug = FREE_SAMPLE_PACK_SLUGS[0]!;
    await mkPack(slug, 'published', 1);
    const latest = await mkPack(slug, 'published', 2);
    await mkPack(slug, 'draft', 3); // a draft never counts
    await mkPack('not-a-sample-pack', 'published', 1);
    const t = await mkTenant('plan-co');

    const out = await withSystemRole('test self-serve plan', (c) => provisionSelfServePlan(c, t));
    expect(out).toEqual({ plan: 'free', packsGranted: 1 });

    const plan = (await db.query(`SELECT tier, included_credits FROM tenant_plans WHERE tenant_id=$1`, [t])).rows[0];
    expect(plan).toEqual({ tier: 'free', included_credits: DEFAULT_FREE_CREDITS });
    expect(await n(`SELECT count(*) n FROM credit_grants WHERE tenant_id=$1 AND source='free_monthly'`, [t])).toBe(1);
    const ent = (await db.query(`SELECT scope_type, scope_id, status FROM tenant_entitlements WHERE tenant_id=$1`, [t])).rows;
    expect(ent).toEqual([{ scope_type: 'pack', scope_id: latest, status: 'active' }]);
  });

  it('grants what exists when fewer sample packs are published (none is fine)', async () => {
    await db.query(`UPDATE question_packs SET status='archived' WHERE tenant_id=$1`, [platformId]);
    const t = await mkTenant('plan-empty-co');
    const out = await withSystemRole('test self-serve plan', (c) => provisionSelfServePlan(c, t));
    expect(out.packsGranted).toBe(0);
    expect(await n(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1`, [t])).toBe(1);
  });

  it('is part of the caller transaction: a later failure rolls plan, grant and entitlement back', async () => {
    const t = await mkTenant('plan-rollback-co');
    await expect(
      withSystemRole('test self-serve plan rollback', async (c) => {
        await provisionSelfServePlan(c, t);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await n(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1`, [t])).toBe(0);
    expect(await n(`SELECT count(*) n FROM credit_grants WHERE tenant_id=$1`, [t])).toBe(0);
  });

  it('the existing provisionDefaultPlan behaves as before (plan + grant, idempotent)', async () => {
    const t = await mkTenant('legacy-plan-co');
    await provisionDefaultPlan(t);
    await provisionDefaultPlan(t);
    expect(await n(`SELECT count(*) n FROM tenant_plans WHERE tenant_id=$1`, [t])).toBe(1);
    expect(await n(`SELECT count(*) n FROM credit_grants WHERE tenant_id=$1 AND source='free_monthly'`, [t])).toBe(1);
  });
});
