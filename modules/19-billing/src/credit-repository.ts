// AssessIQ — modules/19-billing/src/credit-repository.ts
//
// Z-93: SQL for the credit ledger (credit_grants + credit_burns, migration 0215).
// Same rules as repository.ts: callers own the transaction, no try/catch.

import type { PoolClient } from 'pg';
import type { CreditBalance, CreditGrantView } from './types.js';
import { BURN, FREE_MONTHLY_CREDITS, GRANT_VALIDITY_MONTHS, type TestType } from './burn-rates.js';

/** Conflict target of the one-free-grant-per-UTC-month partial unique index. */
const FREE_MONTHLY_CONFLICT =
  `ON CONFLICT (tenant_id, (date_trunc('month', granted_at AT TIME ZONE 'UTC'))) WHERE source = 'free_monthly' DO NOTHING`;

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

interface GrantRow {
  id: string;
  source: CreditGrantView['source'];
  credits: number;
  remaining: number;
  granted_at: Date;
  expires_at: Date;
  invoice_ref: string | null;
  note: string | null;
}

const toView = (r: GrantRow): CreditGrantView => ({
  ...r,
  granted_at: iso(r.granted_at),
  expires_at: iso(r.expires_at),
});

async function burnTotals(client: PoolClient, tenantId: string): Promise<CreditBalance['burn_by_type']> {
  const b = await client.query<{ test_type: TestType; n: number }>(
    `SELECT test_type, SUM(credits)::int AS n FROM credit_burns WHERE tenant_id = $1 GROUP BY test_type`,
    [tenantId],
  );
  const burn = { mock: 0, real: 0, real_camera: 0 };
  for (const r of b.rows) burn[r.test_type] = r.n;
  return burn;
}

/**
 * Burn the credits for one graded attempt. Runs in the grading transaction
 * (assessiq_app + tenant GUC). NEVER throws on a low balance: grading must not
 * fail. Takes from the oldest-expiring unexpired grants first and splits across
 * grants; whatever it cannot cover is stored as `shortfall`.
 * Skipped for unlimited tenants (included_credits NULL) and tenants without a plan row.
 * Idempotent: grant rows are locked first, then an existing burn row ends the call.
 */
export async function burnCredits(client: PoolClient, tenantId: string, attemptId: string): Promise<void> {
  const meta = await client.query<{ delivery_mode: string; camera_enabled: boolean; included_credits: number | null }>(
    `SELECT a.delivery_mode, a.camera_enabled, p.included_credits
       FROM attempts a JOIN tenant_plans p ON p.tenant_id = a.tenant_id
      WHERE a.id = $1 AND a.tenant_id = $2`,
    [attemptId, tenantId],
  );
  const m = meta.rows[0];
  if (m === undefined || m.included_credits === null) return;
  const testType: TestType = m.delivery_mode === 'mock' ? 'mock' : m.camera_enabled ? 'real_camera' : 'real';
  const cost = BURN[testType];

  const grants = await client.query<{ id: string; remaining: number }>(
    `SELECT id, remaining FROM credit_grants
      WHERE tenant_id = $1 AND remaining > 0 AND expires_at > now()
      ORDER BY expires_at ASC, granted_at ASC
      FOR UPDATE`,
    [tenantId],
  );
  const done = await client.query(`SELECT 1 FROM credit_burns WHERE tenant_id = $1 AND attempt_id = $2`, [tenantId, attemptId]);
  if (done.rows.length > 0) return;

  let need = cost;
  let firstGrant: string | null = null;
  for (const g of grants.rows) {
    if (need === 0) break;
    const take = Math.min(g.remaining, need);
    await client.query(`UPDATE credit_grants SET remaining = remaining - $2 WHERE id = $1 AND tenant_id = $3`, [g.id, take, tenantId]);
    firstGrant ??= g.id;
    need -= take;
  }
  await client.query(
    `INSERT INTO credit_burns (tenant_id, attempt_id, grant_id, credits, shortfall, test_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, attempt_id) DO NOTHING`,
    [tenantId, attemptId, firstGrant, cost, need, testType],
  );
}

/**
 * Z-147: credits held by invitations that can still lead to a submitted attempt, computed live (no table).
 * Counted: started invitations, and pending/viewed ones whose link has not lapsed, on published/active
 * assessments. Submitted and expired (revoked) rows never count, so revoke, lapse, cancel and submit release.
 * Cost per invite = BURN of the assessment's type. Runs under withTenant; the explicit tenant filter is a second guard.
 */
export async function countHeldCredits(
  client: PoolClient,
  tenantId: string,
): Promise<{ held: number; heldInvites: number }> {
  const r = await client.query<{ held: string; n: string }>(
    `SELECT COALESCE(SUM(CASE WHEN a.delivery_mode = 'mock' THEN $2::int
                              WHEN a.camera_required THEN $4::int ELSE $3::int END), 0) AS held,
            count(*) AS n
       FROM assessment_invitations i JOIN assessments a ON a.id = i.assessment_id
      WHERE a.tenant_id = $1 AND a.status IN ('published', 'active')
        AND (i.status = 'started' OR (i.status IN ('pending', 'viewed') AND i.expires_at > now()))`,
    [tenantId, BURN.mock, BURN.real, BURN.real_camera],
  );
  return { held: parseInt(r.rows[0]?.held ?? '0', 10), heldInvites: parseInt(r.rows[0]?.n ?? '0', 10) };
}

/**
 * Z-147: what an invite check needs. `unlimited` = no plan row or included_credits NULL (these tenants never burn,
 * see burnCredits). Call it AFTER taking the credit_hold lock so balance and held are read as one consistent view.
 */
export async function readCreditHoldState(
  client: PoolClient,
  tenantId: string,
): Promise<{ unlimited: boolean; available: number }> {
  const p = await client.query<{ included_credits: number | null }>(
    `SELECT included_credits FROM tenant_plans WHERE tenant_id = $1`,
    [tenantId],
  );
  if (p.rows[0] === undefined || p.rows[0].included_credits === null) return { unlimited: true, available: 0 };
  const b = await client.query<{ balance: string }>(
    `SELECT COALESCE(SUM(remaining), 0) AS balance FROM credit_grants
      WHERE tenant_id = $1 AND remaining > 0 AND expires_at > now()`,
    [tenantId],
  );
  const { held } = await countHeldCredits(client, tenantId);
  return { unlimited: false, available: Math.max(0, parseInt(b.rows[0]?.balance ?? '0', 10) - held) };
}

/** Ledger view for one tenant (under withTenant: RLS limits rows to the tenant). */
export async function readCreditBalance(
  client: PoolClient,
  tenantId: string,
  aiAnswers: number,
  unlimited: boolean,
): Promise<CreditBalance> {
  const g = await client.query<GrantRow>(
    `SELECT id, source, credits, remaining, granted_at, expires_at, invoice_ref, note
       FROM credit_grants
      WHERE tenant_id = $1 AND expires_at > now()
      ORDER BY expires_at ASC, granted_at ASC`,
    [tenantId],
  );
  const anyRow = await client.query(`SELECT 1 FROM credit_grants WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
  const live = g.rows.filter((r) => r.remaining > 0);
  const balance = live.reduce((a, r) => a + r.remaining, 0);
  const { held, heldInvites } = await countHeldCredits(client, tenantId);
  return {
    unlimited,
    has_grants: anyRow.rows.length > 0,
    balance,
    held,
    held_invites: heldInvites,
    available: Math.max(0, balance - held),
    next_expiry: live[0] ? iso(live[0].expires_at) : null,
    grants: g.rows.map(toView),
    burn_by_type: await burnTotals(client, tenantId),
    ai_answers: aiAnswers,
  };
}

/** Insert one grant (system role for purchase/bonus/pilot). */
export async function insertCreditGrant(
  client: PoolClient,
  tenantId: string,
  g: {
    source: string;
    credits: number;
    expiresInMonths: number;
    expiresAt: Date | null;
    invoiceRef: string | null;
    note: string | null;
    createdBy: string | null;
  },
): Promise<{ id: string; expires_at: Date }> {
  const r = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at, invoice_ref, note, created_by)
     VALUES ($1, $2, $3, $3, COALESCE($4::timestamptz, now() + make_interval(months => $5)), $6, $7, $8)
     RETURNING id, expires_at`,
    [tenantId, g.source, g.credits, g.expiresAt, g.expiresInMonths, g.invoiceRef, g.note, g.createdBy],
  );
  return r.rows[0]!;
}

/** Free monthly grant for the current UTC month; no-op if one already exists. */
export async function insertFreeMonthlyGrant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(
    `INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at, note)
     VALUES ($1, 'free_monthly', $2, $2, now() + make_interval(months => $3), 'free monthly credits')
     ${FREE_MONTHLY_CONFLICT}`,
    [tenantId, FREE_MONTHLY_CREDITS, GRANT_VALIDITY_MONTHS],
  );
}

/**
 * Monthly refill for all active free tenants (system role). No rollover: zero the
 * free grants from earlier months, then add this month's grant (unique index = idempotent).
 */
export async function refillFreeMonthlyAll(client: PoolClient): Promise<{ zeroed: number; granted: number }> {
  const z = await client.query(
    `UPDATE credit_grants g SET remaining = 0
       FROM tenant_plans p
      WHERE g.tenant_id = p.tenant_id AND p.tier = 'free' AND g.source = 'free_monthly' AND g.remaining > 0
        AND g.granted_at < (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
  );
  const i = await client.query(
    `INSERT INTO credit_grants (tenant_id, source, credits, remaining, expires_at, note)
     SELECT p.tenant_id, 'free_monthly', $1, $1, now() + make_interval(months => $2), 'free monthly credits'
       FROM tenant_plans p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.tier = 'free' AND p.status = 'active' AND t.status = 'active'
     ${FREE_MONTHLY_CONFLICT}`,
    [FREE_MONTHLY_CREDITS, GRANT_VALIDITY_MONTHS],
  );
  return { zeroed: z.rowCount ?? 0, granted: i.rowCount ?? 0 };
}

/** Daily: zero the remaining credits of expired grants (system role). */
export async function expireCreditGrants(client: PoolClient): Promise<number> {
  const r = await client.query(`UPDATE credit_grants SET remaining = 0 WHERE expires_at < now() AND remaining > 0`);
  return r.rowCount ?? 0;
}

/** Super-admin view: every grant (expired too) plus burn totals (system role). */
export async function listGrantsAndBurns(
  client: PoolClient,
  tenantId: string,
): Promise<{ grants: CreditGrantView[]; burns: CreditBalance['burn_by_type'] }> {
  const g = await client.query<GrantRow>(
    `SELECT id, source, credits, remaining, granted_at, expires_at, invoice_ref, note
       FROM credit_grants WHERE tenant_id = $1 ORDER BY granted_at DESC`,
    [tenantId],
  );
  return { grants: g.rows.map(toView), burns: await burnTotals(client, tenantId) };
}

/**
 * Z-96: one row per tenant with finite credits: its largest unexpired grant and the
 * summed remaining credits of its unexpired grants (system role, cross-tenant read).
 * Spent grants still count as "largest" so a tenant at zero is still told.
 */
export async function listLowBalanceCandidates(
  client: PoolClient,
): Promise<Array<{ tenant_id: string; grant_id: string; largest: number; balance: number }>> {
  const r = await client.query<{ tenant_id: string; grant_id: string; largest: number; balance: number }>(
    `SELECT DISTINCT ON (g.tenant_id) g.tenant_id, g.id AS grant_id, g.credits AS largest,
            (SUM(g.remaining) OVER (PARTITION BY g.tenant_id))::int AS balance
       FROM credit_grants g
       JOIN tenants t ON t.id = g.tenant_id AND t.status = 'active'
       JOIN tenant_plans p ON p.tenant_id = g.tenant_id AND p.included_credits IS NOT NULL
      WHERE g.expires_at > now() AND g.credits > 0
      ORDER BY g.tenant_id, g.credits DESC, g.granted_at DESC`,
  );
  return r.rows;
}

/** Z-96: record the levels; returns only the levels that were new (UNIQUE grant_id+level). */
export async function insertLowBalanceNotices(
  client: PoolClient,
  tenantId: string,
  grantId: string,
  levels: number[],
): Promise<number[]> {
  const r = await client.query<{ level: number }>(
    `INSERT INTO credit_lowbalance_notices (tenant_id, grant_id, level)
     SELECT $1, $2, l FROM unnest($3::smallint[]) AS l
     ON CONFLICT (grant_id, level) DO NOTHING
     RETURNING level`,
    [tenantId, grantId, levels],
  );
  return r.rows.map((x) => Number(x.level));
}

/** Z-96: active admin addresses of a tenant (system role). */
export async function listTenantAdminEmails(client: PoolClient, tenantId: string): Promise<string[]> {
  const r = await client.query<{ email: string }>(
    `SELECT email FROM users
      WHERE tenant_id = $1 AND role = 'admin' AND status = 'active' AND deleted_at IS NULL AND erased_at IS NULL`,
    [tenantId],
  );
  return r.rows.map((x) => x.email);
}

/** Z-96: unexpired paid/bonus/pilot grants with credits left that expire within 30 days and were not yet mailed. */
export async function listExpiringGrantCandidates(
  client: PoolClient,
): Promise<Array<{ tenant_id: string; grant_id: string; remaining: number; expires_at: Date }>> {
  const r = await client.query<{ tenant_id: string; grant_id: string; remaining: number; expires_at: Date }>(
    `SELECT g.tenant_id, g.id AS grant_id, g.remaining, g.expires_at
       FROM credit_grants g
       JOIN tenants t ON t.id = g.tenant_id AND t.status = 'active'
      WHERE g.source <> 'free_monthly' AND g.remaining > 0
        AND g.expires_at > now() AND g.expires_at <= now() + interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM credit_expiry_notices n WHERE n.grant_id = g.id)`,
  );
  return r.rows;
}

/** Z-96: record the notice; false when another tick already did (UNIQUE grant_id). */
export async function insertExpiryNotice(client: PoolClient, tenantId: string, grantId: string): Promise<boolean> {
  const r = await client.query(
    `INSERT INTO credit_expiry_notices (tenant_id, grant_id) VALUES ($1, $2) ON CONFLICT (grant_id) DO NOTHING`,
    [tenantId, grantId],
  );
  return (r.rowCount ?? 0) > 0;
}
