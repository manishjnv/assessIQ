// EXP-17: organisation-upload plan limits. Numbers come from plan data (19-billing getUploadLimits), never from code.
// Enforced only while PLAN_TIERS_ENFORCED is on (like the other tier gates); with the flag off nothing is blocked
// but the limits and usage are still returned for the screen.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, config } from "@assessiq/core";
import { getUploadLimits, type UploadLimits } from "@assessiq/billing";

export interface UploadUsage { uploads_this_month: number; questions_total: number }
export interface UploadPlanView { tiers_enforced: boolean; limits: UploadLimits; usage: UploadUsage }

/** Committed organisation uploads this UTC calendar month, and live (not withdrawn) questions this tenant uploaded. */
export async function getUploadUsage(client: PoolClient, tenantId: string): Promise<UploadUsage> {
  const r = await client.query<{ m: number; q: number }>(
    `SELECT (SELECT COUNT(*)::int FROM question_imports
              WHERE tenant_id = $1 AND upload_rights_status IS NOT NULL AND status = 'committed'
                AND updated_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS m,
            (SELECT COUNT(*)::int FROM question_source
              WHERE tenant_id = $1 AND origin = 'tenant_upload' AND rights_status <> 'withdrawn') AS q`,
    [tenantId],
  );
  return { uploads_this_month: r.rows[0]!.m, questions_total: r.rows[0]!.q };
}

export async function getUploadPlanView(client: PoolClient, tenantId: string): Promise<UploadPlanView> {
  return {
    tiers_enforced: config.PLAN_TIERS_ENFORCED,
    limits: await getUploadLimits(client, tenantId),
    usage: await getUploadUsage(client, tenantId),
  };
}

/** Throws when this upload of `rows` questions breaks a plan limit. The import being checked is still 'staged', so it is not in the usage counts. */
export async function assertUploadWithinPlan(client: PoolClient, tenantId: string, rows: number): Promise<void> {
  if (!config.PLAN_TIERS_ENFORCED) return;
  const limits = await getUploadLimits(client, tenantId);
  if (limits.perUpload === 0 || limits.perMonth === 0 || limits.total === 0) {
    throw new AppError("Your plan does not include organisation question uploads.", "UPLOAD_NOT_IN_PLAN", 403, { details: { code: "UPLOAD_NOT_IN_PLAN" } });
  }
  if (limits.perUpload !== null && rows > limits.perUpload) {
    throw new AppError(`This file has ${rows} questions; your plan allows ${limits.perUpload} per upload.`, "UPLOAD_TOO_LARGE_FOR_PLAN", 422,
      { details: { code: "UPLOAD_TOO_LARGE_FOR_PLAN", limit: limits.perUpload, rows } });
  }
  const usage = await getUploadUsage(client, tenantId);
  if (limits.perMonth !== null && usage.uploads_this_month >= limits.perMonth) {
    throw new AppError(`Your plan allows ${limits.perMonth} uploads a month.`, "UPLOAD_MONTH_LIMIT", 409, { details: { code: "UPLOAD_MONTH_LIMIT", limit: limits.perMonth } });
  }
  if (limits.total !== null && usage.questions_total + rows > limits.total) {
    throw new AppError(`Your plan allows ${limits.total} uploaded questions in total.`, "UPLOAD_TOTAL_LIMIT", 409,
      { details: { code: "UPLOAD_TOTAL_LIMIT", limit: limits.total, current: usage.questions_total, rows } });
  }
}

/** One lock per tenant, held to the end of the commit transaction, so two commits cannot both pass the checks. */
export async function lockTenantUploads(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`org_upload:${tenantId}`]);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** ORG-<first 8 hex of tenant id>-<YYYYMMDD>-<6 base32 chars>. Server-generated, one per upload. */
export function newLicenceId(tenantId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const b = randomBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += B32[b[i]! & 31];
  return `ORG-${tenantId.replace(/-/g, "").slice(0, 8).toLowerCase()}-${day}-${s}`;
}
