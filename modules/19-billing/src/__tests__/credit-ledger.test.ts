// AssessIQ — modules/19-billing/src/__tests__/credit-ledger.test.ts
//
// Z-93 credit ledger, DB-backed (postgres:16-alpine testcontainer; skipped without Docker,
// loud failure in CI — same pattern as billing-events.test.ts).
//
// Coverage:
//   (a) burn takes the oldest-expiring grant first and splits across grants
//   (b) burn never throws with a zero balance (shortfall recorded) and is idempotent
//   (c) an expired grant is not burned
//   (d) monthly refill is idempotent and has no rollover
//   (e) grantCredits writes the grant and one billing.credits_granted audit row

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyAllMigrations } from '../../../../tools/test-support/apply-all-migrations.js';

// CI runs vitest from the repo root; a local run starts in the module folder.
const MIGRATION_0225 = [
  join(process.cwd(), 'modules/19-billing/migrations/0225_credit_scale_x10.sql'),
  join(process.cwd(), 'migrations/0225_credit_scale_x10.sql'),
].find((f) => existsSync(f)) ?? '';
import { setPoolForTesting, closePool, withTenant } from '@assessiq/tenancy';
import { recordGradedAttempt, grantCredits, refillFreeMonthlyCredits, getCreditBalance, sendCreditLowBalanceNotices, sendCreditExpiryNotices, getUsage } from '../service.js';
import { BURN, FREE_MONTHLY_CREDITS } from '../burn-rates.js';

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 30_000 });
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
let ADMIN_ID: string;

async function sup<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** New tenant with a finite plan, one assessment, returns helpers to seed attempts. */
async function seedTenant(tier: 'free' | 'pro', included: number | null) {
  const tenantId = randomUUID();
  return sup(async (c) => {
    await c.query(`INSERT INTO tenants (id, slug, name, status) VALUES ($1, $2, 'T', 'active')`, [tenantId, `t-${randomUUID().slice(0, 8)}`]);
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1, $2, $3, 'A', 'admin')`, [ADMIN_ID = randomUUID(), tenantId, `a-${randomUUID().slice(0, 6)}@test.com`]);
    await c.query(`INSERT INTO tenant_plans (tenant_id, tier, included_credits) VALUES ($1, $2, $3)`, [tenantId, tier, included]);
    const packId = randomUUID();
    const levelId = randomUUID();
    await c.query(`INSERT INTO question_packs (id, tenant_id, slug, name, domain, status, version, created_by) VALUES ($1,$2,$3,'P','soc','published',1,$4)`, [packId, tenantId, `p-${randomUUID().slice(0, 8)}`, ADMIN_ID]);
    await c.query(`INSERT INTO levels (id, pack_id, position, label, duration_minutes, default_question_count) VALUES ($1,$2,1,'L1',30,5)`, [levelId, packId]);
    const asmId = randomUUID();
    await c.query(`INSERT INTO assessments (id, tenant_id, pack_id, level_id, pack_version, name, question_count, status, created_by) VALUES ($1,$2,$3,$4,1,'A',5,'published',$5)`, [asmId, tenantId, packId, levelId, ADMIN_ID]);
    return { tenantId, adminId: ADMIN_ID, asmId };
  });
}

async function seedAttempt(tenantId: string, asmId: string, mode: 'real' | 'mock' = 'real', camera = false): Promise<string> {
  const id = randomUUID();
  const userId = randomUUID();
  await sup(async (c) => {
    await c.query(`INSERT INTO users (id, tenant_id, email, name, role) VALUES ($1,$2,$3,'C','candidate')`, [userId, tenantId, `c-${userId}@test.com`]);
    await c.query(`INSERT INTO attempts (id, tenant_id, user_id, assessment_id, status, delivery_mode, camera_enabled) VALUES ($1,$2,$3,$4,'graded',$5,$6)`, [id, tenantId, userId, asmId, mode, camera]);
  });
  return id;
}

async function addGrant(tenantId: string, source: string, credits: number, expiresSql: string, grantedSql = 'now()'): Promise<string> {
  const id = randomUUID();
  await sup((c) =>
    c.query(
      `INSERT INTO credit_grants (id, tenant_id, source, credits, remaining, granted_at, expires_at) VALUES ($1,$2,$3,$4,$4,${grantedSql},${expiresSql})`,
      [id, tenantId, source, credits],
    ),
  );
  return id;
}

const remaining = (id: string) =>
  sup(async (c) => (await c.query<{ remaining: number }>(`SELECT remaining FROM credit_grants WHERE id = $1`, [id])).rows[0]!.remaining);

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withExposedPorts(5432)
    .start();
  url = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/testdb`;
  await setPoolForTesting(url);
  await sup((c) => applyAllMigrations(c));
}, 300_000);

afterAll(async () => {
  if (dockerAvailable) {
    await closePool();
    if (container) await container.stop();
  }
});

describe('burn order and split', () => {
  it.skipIf(!dockerAvailable)('takes the oldest-expiring grant first and splits across grants', async () => {
    const { tenantId, asmId } = await seedTenant('pro', 100);
    const late = await addGrant(tenantId, 'purchase', 30, `now() + interval '300 days'`);
    const soon = await addGrant(tenantId, 'bonus', 5, `now() + interval '10 days'`);
    const attemptId = await seedAttempt(tenantId, asmId, 'real'); // cost 20
    await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, attemptId));
    expect(await remaining(soon)).toBe(0);
    expect(await remaining(late)).toBe(30 - (BURN.real - 5));
    const row = await sup((c) => c.query(`SELECT grant_id, credits, shortfall, test_type FROM credit_burns WHERE attempt_id = $1`, [attemptId]));
    expect(row.rows[0]).toMatchObject({ grant_id: soon, credits: BURN.real, shortfall: 0, test_type: 'real' });
    // idempotent: a second call burns nothing more
    await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, attemptId));
    expect(await remaining(late)).toBe(30 - (BURN.real - 5));
  });
});

describe('burn amounts (Z-95 x10 scale)', () => {
  it.skipIf(!dockerAvailable)('real burns 20, mock 10, camera 30', async () => {
    expect(BURN).toEqual({ mock: 10, real: 20, real_camera: 30 });
    const { tenantId, asmId } = await seedTenant('pro', 1000);
    const g = await addGrant(tenantId, 'purchase', 100, `now() + interval '300 days'`);
    for (const [mode, camera] of [['real', false], ['mock', false], ['real', true]] as const) {
      const a = await seedAttempt(tenantId, asmId, mode, camera);
      await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, a));
    }
    expect(await remaining(g)).toBe(100 - 20 - 10 - 30);
  });
});

describe('burn with no balance', () => {
  it.skipIf(!dockerAvailable)('never throws; records the shortfall; mock burns 10 and camera burns 30', async () => {
    const { tenantId, asmId } = await seedTenant('pro', 100);
    const a = await seedAttempt(tenantId, asmId, 'real', true);
    await expect(withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, a))).resolves.toBeUndefined();
    const r = await sup((c) => c.query(`SELECT grant_id, credits, shortfall, test_type FROM credit_burns WHERE attempt_id = $1`, [a]));
    expect(r.rows[0]).toMatchObject({ grant_id: null, credits: BURN.real_camera, shortfall: BURN.real_camera, test_type: 'real_camera' });
    const m = await seedAttempt(tenantId, asmId, 'mock');
    await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, m));
    const mr = await sup((c) => c.query(`SELECT credits, test_type FROM credit_burns WHERE attempt_id = $1`, [m]));
    expect(mr.rows[0]).toMatchObject({ credits: BURN.mock, test_type: 'mock' });
  });

  it.skipIf(!dockerAvailable)('skips unlimited tenants (included_credits NULL)', async () => {
    const { tenantId, asmId } = await seedTenant('pro', null);
    const a = await seedAttempt(tenantId, asmId);
    await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, a));
    const r = await sup((c) => c.query(`SELECT 1 FROM credit_burns WHERE attempt_id = $1`, [a]));
    expect(r.rows.length).toBe(0);
  });
});

describe('expired grant', () => {
  it.skipIf(!dockerAvailable)('is not burned and not counted in the balance', async () => {
    const { tenantId, asmId } = await seedTenant('pro', 100);
    const old = await addGrant(tenantId, 'purchase', 10, `now() - interval '1 day'`, `now() - interval '400 days'`);
    const a = await seedAttempt(tenantId, asmId);
    await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, a));
    expect(await remaining(old)).toBe(10);
    expect((await getCreditBalance(tenantId)).balance).toBe(0);
  });
});

describe('monthly refill', () => {
  it.skipIf(!dockerAvailable)('is idempotent and does not roll over the previous month', async () => {
    const { tenantId } = await seedTenant('free', 250);
    const prev = await addGrant(tenantId, 'free_monthly', FREE_MONTHLY_CREDITS, `now() + interval '300 days'`, `now() - interval '40 days'`);
    await refillFreeMonthlyCredits();
    await refillFreeMonthlyCredits();
    expect(await remaining(prev)).toBe(0);
    const bal = await getCreditBalance(tenantId);
    expect(FREE_MONTHLY_CREDITS).toBe(200);
    expect(bal.balance).toBe(200);
    const n = await sup((c) => c.query(`SELECT COUNT(*)::int AS n FROM credit_grants WHERE tenant_id = $1 AND source = 'free_monthly'`, [tenantId]));
    expect(n.rows[0].n).toBe(2);
  });
});

describe('grantCredits', () => {
  it.skipIf(!dockerAvailable)('writes the grant and one billing.credits_granted audit row; rejects bad input', async () => {
    const { tenantId, adminId } = await seedTenant('pro', 100);
    const res = await grantCredits(tenantId, { source: 'purchase', credits: 40, invoiceRef: 'INV-9' }, adminId);
    expect(await remaining(res.id)).toBe(40);
    const au = await sup((c) => c.query(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'billing.credits_granted'`, [res.id]));
    expect(au.rows.length).toBe(1);
    await expect(grantCredits(tenantId, { source: 'purchase', credits: 0 }, adminId)).rejects.toThrow();
  });
});

describe('0225 credit scale x10', () => {
  const sql = readFileSync(MIGRATION_0225, 'utf8');
  it.skipIf(!dockerAvailable)('scales an existing grant once; a second run does not scale again', async () => {
    const { tenantId } = await seedTenant('pro', 100);
    const id = randomUUID();
    await sup(async (c) => {
      await c.query(`INSERT INTO credit_grants (id, tenant_id, source, credits, remaining, expires_at) VALUES ($1,$2,'purchase',20,15, now() + interval '30 days')`, [id, tenantId]);
      await c.query(`COMMENT ON TABLE credit_grants IS NULL`); // simulate a DB that has not run 0225 yet
      await c.query(sql);
      await c.query(sql);
    });
    const r = await sup((c) => c.query(`SELECT credits, remaining FROM credit_grants WHERE id = $1`, [id]));
    expect(r.rows[0]).toEqual({ credits: 200, remaining: 150 });
  });

  it.skipIf(!dockerAvailable)('app role may insert a 200-credit free_monthly grant, not 201 or another source', async () => {
    const { tenantId } = await seedTenant('free', 250);
    const ins = (source: string, n: number) =>
      withTenant(tenantId, (c) =>
        c.query(`INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at) VALUES ($1,$2,$3,$3, now() + interval '30 days')`, [tenantId, source, n]),
      );
    await expect(ins('free_monthly', 201)).rejects.toThrow();
    await expect(ins('purchase', 10)).rejects.toThrow();
    await expect(ins('free_monthly', 200)).resolves.toBeDefined();
  });
});

// Z-96: low-balance emails (20 and 10 percent of the largest active grant), once per level per grant.
describe('low-balance notices', () => {
  const setRemaining = (id: string, n: number) => sup((c) => c.query(`UPDATE credit_grants SET remaining = $2 WHERE id = $1`, [id, n]));
  const notices = (tenantId: string) =>
    sup(async (c) => (await c.query<{ level: number }>(`SELECT level FROM credit_lowbalance_notices WHERE tenant_id = $1 ORDER BY level DESC`, [tenantId])).rows.map((r) => r.level));
  const auditCount = (tenantId: string) =>
    sup(async (c) => (await c.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'billing.credit_low_balance_notice'`, [tenantId])).rows[0]!.n);

  it.skipIf(!dockerAvailable)('sends one email per level, never repeats, and rolls back when the send fails', async () => {
    const { tenantId } = await seedTenant('pro', 1000);
    const grant = await addGrant(tenantId, 'purchase', 1000, `now() + interval '300 days'`);
    const mine: number[] = [];
    const ok = async (m: { tenantId: string; level: number }) => {
      if (m.tenantId === tenantId) mine.push(m.level);
    };

    await sendCreditLowBalanceNotices(ok);
    expect(mine).toEqual([]); // 100 percent left: nothing

    await setRemaining(grant, 200); // 20 percent
    await sendCreditLowBalanceNotices(ok);
    await sendCreditLowBalanceNotices(ok); // second tick: no second email
    expect(mine).toEqual([20]);
    expect(await auditCount(tenantId)).toBe(1);

    // failure: every send throws -> notice is rolled back, next tick retries
    await setRemaining(grant, 100); // 10 percent
    const bad = await sendCreditLowBalanceNotices(async () => {
      throw new Error('smtp down');
    });
    expect(bad.failed).toBeGreaterThanOrEqual(1);
    expect(await notices(tenantId)).toEqual([20]);
    await sendCreditLowBalanceNotices(ok);
    await sendCreditLowBalanceNotices(ok);
    expect(mine).toEqual([20, 10]);
    expect(await notices(tenantId)).toEqual([20, 10]);
    expect(await auditCount(tenantId)).toBe(2);
  });
});

// Z-96: the usage meter shows the real burn from the ledger (10/20/30), not attempts x 10.
describe('exact usage meter', () => {
  it.skipIf(!dockerAvailable)('sums the real burn for a ledger tenant and falls back to the old count without ledger rows', async () => {
    const { tenantId, asmId } = await seedTenant('pro', 1000);
    await addGrant(tenantId, 'purchase', 1000, `now() + interval '300 days'`);
    for (const [mode, cam] of [['mock', false], ['real', false], ['real', true]] as const) {
      const a = await seedAttempt(tenantId, asmId, mode, cam);
      await withTenant(tenantId, (c) => recordGradedAttempt(c, tenantId, a));
    }
    expect((await getUsage(tenantId)).used).toBe(BURN.mock + BURN.real + BURN.real_camera); // 60, not 3 x 10

    // no ledger rows: old counter (graded attempts x 10)
    const old = await seedTenant('pro', 1000);
    await sup((c) => c.query(`INSERT INTO billing_events (tenant_id, attempt_id, event_type) SELECT $1, id, 'assessment_graded' FROM attempts WHERE tenant_id = $1`, [old.tenantId]));
    const a2 = await seedAttempt(old.tenantId, old.asmId, 'real');
    await sup((c) => c.query(`INSERT INTO billing_events (tenant_id, attempt_id, event_type) VALUES ($1, $2, 'assessment_graded')`, [old.tenantId, a2]));
    expect((await getUsage(old.tenantId)).used).toBe(10);
  });
});

// Z-96: expiry warning, one email per grant, 30 days before it expires.
describe('expiry-warning notices', () => {
  const auditCount = (tenantId: string) =>
    sup(async (c) => (await c.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'billing.credit_expiry_notice'`, [tenantId])).rows[0]!.n);

  it.skipIf(!dockerAvailable)('mails once inside 30 days, skips far, spent and free grants, and retries after a failed send', async () => {
    const { tenantId } = await seedTenant('pro', 1000);
    await addGrant(tenantId, 'purchase', 500, `now() + interval '200 days'`); // too far
    await addGrant(tenantId, 'free_monthly', 200, `now() + interval '10 days'`); // free refills: skipped
    const spent = await addGrant(tenantId, 'bonus', 100, `now() + interval '10 days'`);
    await sup((c) => c.query(`UPDATE credit_grants SET remaining = 0 WHERE id = $1`, [spent]));
    const near = await addGrant(tenantId, 'purchase', 300, `now() + interval '20 days'`);
    const mine: number[] = [];
    const ok = async (m: { tenantId: string; remaining: number }) => {
      if (m.tenantId === tenantId) mine.push(m.remaining);
    };

    const bad = await sendCreditExpiryNotices(async () => {
      throw new Error('smtp down');
    });
    expect(bad.failed).toBeGreaterThanOrEqual(1);
    expect(await auditCount(tenantId)).toBe(0); // rolled back with the notice row

    await sendCreditExpiryNotices(ok);
    await sendCreditExpiryNotices(ok); // second tick: no second email
    expect(mine).toEqual([300]);
    expect(await auditCount(tenantId)).toBe(1);
    const n = await sup((c) => c.query(`SELECT grant_id FROM credit_expiry_notices WHERE tenant_id = $1`, [tenantId]));
    expect(n.rows.map((r) => r.grant_id)).toEqual([near]);
  });
});
