// AssessIQ — modules/14-audit-log/src/archive-job.ts
//
// Phase 3 G3.A — BullMQ daily archive job (P3.D11).
//
// Archives audit_log rows older than tenant_settings.audit_retention_years to
// S3 (tenant-prefixed, gzip-compressed, lifecycle to Glacier), then DELETEs
// the archived rows from the hot table.
//
// GUARDED: the job only registers and runs when S3_BUCKET is set in env.
// Without it, archiveJobProcessor() is a no-op and logs info. This allows
// the audit table to be live (Phase 3) before S3 credentials are configured.
//
// S3 STRATEGY (P3.D11):
//   Bucket:  process.env.S3_BUCKET
//   Key:     <bucket>/<tenant_id>/audit/YYYY-MM-DD.jsonl.gz
//   Method:  PutObject with If-None-Match: * (idempotent — skip if already
//            uploaded for this date+tenant combination)
//   After:   DELETE rows only AFTER S3 PutObject returns 200 OK.
//            Never delete before confirming the archive exists.
//   Glacier: managed by S3 lifecycle rule (not by this job).
//
// DELETE PERMISSION:
//   archive-job runs as assessiq_system (BYPASSRLS). Application code
//   (assessiq_app role) CANNOT delete audit_log rows — the REVOKE in the
//   migration enforces this.
//
// PHASE 4 NOTE:
//   Full S3 SDK integration is Phase 4. This file provides the BullMQ job
//   skeleton and the processor signature. The processor logs a warning and
//   returns early when S3_BUCKET is absent.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config, streamLogger } from '@assessiq/core';
import { getPool } from '@assessiq/tenancy';

const log = streamLogger('worker');

const QUEUE_NAME = 'assessiq-archive';
const JOB_NAME = 'audit.archive.daily';

let _archiveQueue: Queue | null = null;

function getArchiveQueue(): Queue {
  if (_archiveQueue === null) {
    const redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _archiveQueue = new Queue(QUEUE_NAME, { connection: redis });
  }
  return _archiveQueue;
}

/**
 * Register the daily archive job (repeating cron at 02:00 UTC).
 *
 * Only runs when S3_BUCKET env var is set. Returns immediately otherwise.
 *
 * Called by apps/worker at startup alongside other BullMQ job registrations.
 */
export async function registerAuditArchiveJob(): Promise<void> {
  const s3Bucket = process.env['S3_BUCKET'];
  if (s3Bucket === undefined || s3Bucket.length === 0) {
    log.info(
      { job: JOB_NAME },
      'audit-archive: S3_BUCKET not set — archive job not registered (Phase 4)',
    );
    return;
  }

  const queue = getArchiveQueue();
  await queue.upsertJobScheduler(JOB_NAME, {
    pattern: '0 2 * * *', // 02:00 UTC daily
  }, {
    name: JOB_NAME,
    data: { triggeredBy: 'scheduler' },
  });

  log.info({ job: JOB_NAME, s3Bucket }, 'audit-archive: daily job registered');
}

/**
 * BullMQ processor for the archive job.
 *
 * Phase 3 skeleton: logs a warning when S3_BUCKET is absent.
 * Phase 4: full S3 upload + delete implementation.
 */
export async function archiveJobProcessor(): Promise<void> {
  const s3Bucket = process.env['S3_BUCKET'];
  if (s3Bucket === undefined || s3Bucket.length === 0) {
    log.warn(
      { job: JOB_NAME },
      'audit-archive: S3_BUCKET not set — skipping archive run (Phase 4 pending)',
    );
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    // Retrieve all tenants with their retention windows.
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');
    const { rows: tenants } = await client.query<{
      id: string;
      audit_retention_years: number;
    }>(
      `SELECT t.id, COALESCE(ts.audit_retention_years, 7) AS audit_retention_years
       FROM tenants t
       LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
       WHERE t.status = 'active'`,
    );
    await client.query('COMMIT');

    for (const tenant of tenants) {
      await archiveTenant(tenant.id, tenant.audit_retention_years, s3Bucket);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err, job: JOB_NAME }, 'audit-archive: job failed');
    throw err;
  } finally {
    client.release();
  }
}

async function archiveTenant(
  tenantId: string,
  retentionYears: number,
  s3Bucket: string,
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - retentionYears);
    const cutoffIso = cutoff.toISOString();
    const dateKey = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // Count rows to archive.
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log
       WHERE tenant_id = $1 AND at < $2::timestamptz`,
      [tenantId, cutoffIso],
    );
    const rowCount = parseInt(countRows[0]!.count, 10);
    if (rowCount === 0) {
      await client.query('COMMIT');
      return;
    }

    // Phase 4: implement S3 PutObject with If-None-Match: * here.
    // For now: log that S3 upload would occur, then DO NOT delete rows
    // (safe default: never delete without confirmed S3 upload).
    log.warn(
      {
        tenantId,
        cutoffDate: cutoffIso,
        s3Key: `${tenantId}/audit/${dateKey}.jsonl.gz`,
        s3Bucket,
        rowCount,
      },
      'audit-archive: Phase 4 — S3 upload + DELETE pending implementation; rows retained',
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error({ err, tenantId, job: JOB_NAME }, 'audit-archive: tenant archive failed');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Start the archive Worker. Called by apps/worker at startup.
 * Returns undefined if S3_BUCKET is not set.
 */
export function startAuditArchiveWorker(): Worker | undefined {
  const s3Bucket = process.env['S3_BUCKET'];
  if (s3Bucket === undefined || s3Bucket.length === 0) return undefined;

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => { await archiveJobProcessor(); },
    { connection: redis, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id }, 'audit-archive: worker job failed');
  });

  return worker;
}
