// Camera retention sweep. Function only: the worker wiring is a later job. No AI, no ambient claude.
//
// Per tenant, in one withTenant tx: pick files with expires_at <= now. HOLD a file when its attempt is
// flagged AND (not reviewed OR appeal open) AND taken_at is younger than the flag max age
// (school 90 days, other 365). Delete the disk file first (ENOENT is fine), then the row. A failed
// disk delete keeps the row, so the next day retries it. One audit row per tenant sweep when files
// were deleted. Per-tenant errors never stop the other tenants.

import { streamLogger, deleteCameraFile } from "@assessiq/core";
import { withTenant, withSystemRole } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { FLAG_MAX_DAYS_OTHER, FLAG_MAX_DAYS_SCHOOL } from "./constants.js";

const log = streamLogger("app");

export interface CameraRetentionResult {
  tenantId: string;
  scanned: number;
  deleted: number;
  held: number;
  failed: number;
}

export async function runCameraRetentionForTenant(tenantId: string, now: Date = new Date()): Promise<CameraRetentionResult> {
  return withTenant(tenantId, async (client) => {
    const t = await client.query<{ status: string; is_school: boolean }>(`SELECT status, is_school FROM tenants WHERE id = $1`, [tenantId]);
    const tenant = t.rows[0];
    const empty = { tenantId, scanned: 0, deleted: 0, held: 0, failed: 0 };
    if (tenant === undefined || (tenant.status !== "active" && tenant.status !== "suspended")) return empty;
    const maxAgeDays = tenant.is_school ? FLAG_MAX_DAYS_SCHOOL : FLAG_MAX_DAYS_OTHER;

    const r = await client.query<{ id: string; storage_path: string; held: boolean }>(
      `SELECT f.id, f.storage_path,
              (EXISTS (SELECT 1 FROM camera_files x WHERE x.attempt_id = f.attempt_id AND x.flagged)
               AND NOT EXISTS (SELECT 1 FROM camera_attempt_reviews v
                                WHERE v.attempt_id = f.attempt_id AND v.reviewed_at IS NOT NULL AND v.appeal_state <> 'open'
                                  AND v.reviewed_at >= (SELECT max(y.taken_at) FROM camera_files y WHERE y.attempt_id = f.attempt_id AND y.flagged))
               AND f.taken_at > $1::timestamptz - make_interval(days => $2::int)) AS held
         FROM camera_files f
        WHERE f.expires_at <= $1::timestamptz
        ORDER BY f.expires_at, f.id`,
      [now.toISOString(), maxAgeDays],
    );
    const res = { ...empty, scanned: r.rows.length };
    const gone: string[] = [];
    for (const row of r.rows) {
      if (row.held) {
        res.held++;
        continue;
      }
      try {
        await deleteCameraFile(row.storage_path);
        gone.push(row.id);
      } catch (err) {
        res.failed++;
        log.error({ tenantId, fileId: row.id, error: err instanceof Error ? err.message : String(err) }, "camera.retention: disk delete failed; row kept");
      }
    }
    if (gone.length > 0) {
      await client.query(`DELETE FROM camera_files WHERE id = ANY($1::uuid[])`, [gone]);
      res.deleted = gone.length;
      await auditInTx(client, {
        tenantId,
        actorKind: "system",
        action: "camera.retention.sweep",
        entityType: "tenant",
        entityId: tenantId,
        after: { deleted: res.deleted, held: res.held, failed: res.failed },
      });
    }
    return res;
  });
}

export async function runCameraRetentionAll(now: Date = new Date()): Promise<CameraRetentionResult[]> {
  const out: CameraRetentionResult[] = [];
  // Suspended tenants are swept too: their expired files must not stay on disk. Archived ones go with the tenant purge.
  const ids = await withSystemRole("camera retention tenant list", async (client) => {
    const r = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE status IN ('active','suspended') ORDER BY id`);
    return r.rows.map((x) => x.id);
  });
  for (const tenantId of ids) {
    try {
      out.push(await runCameraRetentionForTenant(tenantId, now));
    } catch (err) {
      log.error({ tenantId, error: err instanceof Error ? err.message : String(err) }, "camera.retention: tenant failed; continuing");
      out.push({ tenantId, scanned: 0, deleted: 0, held: 0, failed: 1 });
    }
  }
  return out;
}
