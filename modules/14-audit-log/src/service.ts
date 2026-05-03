// AssessIQ — modules/14-audit-log/src/service.ts
//
// Phase 3 G3.A — admin query layer for the audit_log table.
//
// Provides:
//   list()       — paginated, filterable query (admin viewer)
//   exportCsv()  — streaming CSV via Postgres cursor (P3.D17)
//   exportJsonl() — streaming JSONL via Postgres cursor (P3.D17)
//
// All queries go through withTenant which sets app.current_tenant GUC,
// so RLS enforces tenant isolation automatically. No WHERE tenant_id = $1.
//
// PDF export is deferred to Phase 4 per P3.D17.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { withTenant } from '@assessiq/tenancy';
import { streamLogger } from '@assessiq/core';
import { Readable } from 'node:stream';
import type { AuditRow, AuditListInput, AuditExportInput } from './types.js';

const log = streamLogger('app');

// Cursor batch size — 1000 rows keeps memory bounded for multi-GB exports.
const CURSOR_BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// list() — paginated admin viewer
// ---------------------------------------------------------------------------

export interface AuditListResult {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function list(input: AuditListInput): Promise<AuditListResult> {
  const { tenantId, filters = {}, page, pageSize } = input;
  const clampedPageSize = Math.min(Math.max(pageSize, 1), 200);
  const offset = (Math.max(page, 1) - 1) * clampedPageSize;

  const { whereClause, params } = buildWhereClause(filters);

  return withTenant(tenantId, async (client) => {
    // Count total (for pagination envelope) — same WHERE clause.
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0]!.count, 10);

    // Fetch page.
    const rowsResult = await client.query<AuditRow>(
      `SELECT
         id::text, tenant_id::text, actor_user_id::text,
         actor_kind, action, entity_type, entity_id::text,
         before, after, ip::text, user_agent,
         at::text
       FROM audit_log
       ${whereClause}
       ORDER BY at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, clampedPageSize, offset],
    );

    return {
      rows: rowsResult.rows,
      total,
      page: Math.max(page, 1),
      pageSize: clampedPageSize,
    };
  });
}

// ---------------------------------------------------------------------------
// exportCsv() — streaming CSV (Node.js Readable)
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  'id', 'tenant_id', 'actor_user_id', 'actor_kind', 'action',
  'entity_type', 'entity_id', 'before', 'after', 'ip', 'user_agent', 'at',
].join(',');

export async function exportCsv(input: AuditExportInput): Promise<Readable> {
  const { tenantId, filters = {} } = input;
  const { whereClause, params } = buildWhereClause(filters);

  log.info({ tenantId }, 'audit.exportCsv: starting streaming export');

  const readable = new Readable({ objectMode: false, read() {} });
  readable.push(CSV_HEADERS + '\n');

  // Stream in background — caller pipes the Readable to the HTTP response.
  streamRows(tenantId, whereClause, params, (row) => {
    readable.push(rowToCsvLine(row) + '\n');
  }).then(() => {
    readable.push(null); // EOF
  }).catch((err) => {
    readable.destroy(err as Error);
  });

  return readable;
}

// ---------------------------------------------------------------------------
// exportJsonl() — streaming JSONL (one JSON object per line)
// ---------------------------------------------------------------------------

export async function exportJsonl(input: AuditExportInput): Promise<Readable> {
  const { tenantId, filters = {} } = input;
  const { whereClause, params } = buildWhereClause(filters);

  log.info({ tenantId }, 'audit.exportJsonl: starting streaming export');

  const readable = new Readable({ objectMode: false, read() {} });

  streamRows(tenantId, whereClause, params, (row) => {
    readable.push(JSON.stringify(row) + '\n');
  }).then(() => {
    readable.push(null);
  }).catch((err) => {
    readable.destroy(err as Error);
  });

  return readable;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WhereResult {
  whereClause: string;
  params: unknown[];
}

function buildWhereClause(filters: NonNullable<AuditListInput['filters']>): WhereResult {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.actorUserId !== undefined) {
    conditions.push(`actor_user_id = $${idx++}::uuid`);
    params.push(filters.actorUserId);
  }
  if (filters.actorKind !== undefined) {
    conditions.push(`actor_kind = $${idx++}`);
    params.push(filters.actorKind);
  }
  if (filters.action !== undefined) {
    conditions.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.entityType !== undefined) {
    conditions.push(`entity_type = $${idx++}`);
    params.push(filters.entityType);
  }
  if (filters.entityId !== undefined) {
    conditions.push(`entity_id = $${idx++}::uuid`);
    params.push(filters.entityId);
  }
  if (filters.from !== undefined) {
    conditions.push(`at >= $${idx++}::timestamptz`);
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    conditions.push(`at <= $${idx++}::timestamptz`);
    params.push(filters.to);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  return { whereClause, params };
}

async function streamRows(
  tenantId: string,
  whereClause: string,
  params: unknown[],
  onRow: (row: AuditRow) => void,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    // Use a named cursor for memory-bounded streaming.
    const cursorName = `audit_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await client.query('BEGIN');
    try {
      await client.query(
        `DECLARE ${cursorName} CURSOR FOR
         SELECT
           id::text, tenant_id::text, actor_user_id::text,
           actor_kind, action, entity_type, entity_id::text,
           before, after, ip::text, user_agent,
           at::text
         FROM audit_log
         ${whereClause}
         ORDER BY at DESC`,
        params,
      );

      while (true) {
        const batch = await client.query<AuditRow>(
          `FETCH ${CURSOR_BATCH_SIZE} FROM ${cursorName}`,
        );
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) onRow(row);
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // RFC 4180: fields containing comma, double-quote, or newline are quoted.
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsvLine(row: AuditRow): string {
  return [
    row.id,
    row.tenant_id,
    csvEscape(row.actor_user_id),
    row.actor_kind,
    row.action,
    row.entity_type,
    csvEscape(row.entity_id),
    csvEscape(row.before),
    csvEscape(row.after),
    csvEscape(row.ip),
    csvEscape(row.user_agent),
    row.at,
  ].join(',');
}
