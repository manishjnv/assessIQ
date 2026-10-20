/**
 * candidate-cap.test.ts — DB-backed test of the race-safe Free-plan total candidate cap
 * (migration 0222, countCandidateOrRefuse wired into createUser, importCandidates, updateUser).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';
import { setPoolForTesting, closePool } from '@assessiq/tenancy';

const { cfg } = vi.hoisted(() => ({ cfg: { PLAN_TIERS_ENFORCED: true } }));
vi.mock('@assessiq/core', async (orig) => {
  const real = await orig<typeof import('@assessiq/core')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, k) => (k === 'PLAN_TIERS_ENFORCED' ? cfg.PLAN_TIERS_ENFORCED : (t as never)[k]),
    }),
  };
});

import { createUser, updateUser, softDelete } from '../service.js';
import { importCandidates } from '../import.js';

let pg: StartedTestContainer;
let url: string;
async function sql<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
async function tenant(tier: 'free' | 'pro' = 'free'): Promise<{ t: string; admin: string }> {
  const t = randomUUID();
  const admin = randomUUID();
  await sql(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [t, `t-${t.slice(0, 8)}`]);
  await sql(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'A','admin','active')`, [admin, t, `a-${admin}@x.test`]);
  await sql(`INSERT INTO tenant_plans (tenant_id, tier) VALUES ($1, $2)`, [t, tier]);
  return { t, admin };
}
const cand = (n: string) => ({ email: `${n}@c.test`, name: `C ${n}`, role: 'candidate' as const });
const counted = async (t: string) =>
  Number((await sql<{ n: string }>(`SELECT COUNT(*) n FROM tenant_candidate_counted WHERE tenant_id=$1`, [t]))[0]!.n);
const candUsers = async (t: string) =>
  Number((await sql<{ n: string }>(`SELECT COUNT(*) n FROM users WHERE tenant_id=$1 AND role='candidate'`, [t]))[0]!.n);

beforeAll(async () => {
  pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'aiq_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
  url = `postgres://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/aiq_test`;
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await applyAllMigrations(c);
  } finally {
    await c.end();
  }
  await setPoolForTesting(url);
}, 180_000);
afterAll(async () => {
  await closePool();
  await pg?.stop();
});

describe('Free-plan total candidate cap (race-safe)', () => {
  it('two parallel creates at count 4: exactly one wins, DB ends at 5 counted and 5 users', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant();
    for (let i = 0; i < 4; i++) await createUser(t, cand(`s${i}`), admin);
    const r = await Promise.allSettled([createUser(t, cand('p1'), admin), createUser(t, cand('p2'), admin)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const bad = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason).toMatchObject({ code: 'TIER_LIMIT_REACHED', status: 403 });
    expect(await counted(t)).toBe(5);
    expect(await candUsers(t)).toBe(5);
  });

  it('6th create is refused and leaves no user and no counted row', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant();
    for (let i = 0; i < 5; i++) await createUser(t, cand(`c${i}`), admin);
    await expect(createUser(t, cand('c6'), admin)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
    expect(await counted(t)).toBe(5);
    expect(await candUsers(t)).toBe(5);
  });

  it('delete then re-add does not reset the count', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await createUser(t, cand(`d${i}`), admin));
    await softDelete(t, made[0]!.id, admin);
    await expect(createUser(t, cand('d9'), admin)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
    expect(await counted(t)).toBe(5);
  });

  it('flag off: no cap and no counted rows written', async () => {
    cfg.PLAN_TIERS_ENFORCED = false;
    const { t, admin } = await tenant();
    for (let i = 0; i < 7; i++) await createUser(t, cand(`o${i}`), admin);
    expect(await candUsers(t)).toBe(7);
    expect(await counted(t)).toBe(0);
  });

  it('paid tier is never blocked', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant('pro');
    for (let i = 0; i < 7; i++) await createUser(t, cand(`pr${i}`), admin);
    expect(await candUsers(t)).toBe(7);
  });

  it('role flip admin to candidate counts and is refused at the cap', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant();
    for (let i = 0; i < 5; i++) await createUser(t, cand(`r${i}`), admin);
    const extra = randomUUID();
    await sql(`INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1,$2,$3,'B','admin','active')`, [extra, t, `b-${extra}@x.test`]);
    await expect(updateUser(t, extra, { role: 'candidate' }, admin)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
    expect((await sql<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [extra]))[0]!.role).toBe('admin');
    expect(await counted(t)).toBe(5);
  });

  it('CSV import: existing candidates are not double-counted; the 6th new row aborts the whole import', async () => {
    cfg.PLAN_TIERS_ENFORCED = true;
    const { t, admin } = await tenant();
    for (let i = 0; i < 4; i++) await createUser(t, cand(`i${i}`), admin);
    const csv = (rows: string[]) => `email,name\n${rows.map((e) => `${e}@c.test,N`).join('\n')}\n`;
    const ok = await importCandidates(t, csv(['i0', 'i1', 'i2', 'i3', 'new1']), admin);
    expect(ok).toMatchObject({ created: 1, existing: 4 });
    expect(await counted(t)).toBe(5);
    await expect(importCandidates(t, csv(['i0', 'new2']), admin)).rejects.toMatchObject({ code: 'TIER_LIMIT_REACHED' });
    expect(await candUsers(t)).toBe(5);
    expect(await counted(t)).toBe(5);
  });
});
