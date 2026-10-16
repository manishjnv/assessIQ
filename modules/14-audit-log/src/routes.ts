// AssessIQ — modules/14-audit-log/src/routes.ts
//
// Phase 3 G3.A — 5 admin Fastify routes for the audit_log module.
//
// Routes:
//   GET  /api/admin/audit              — paginated list with filters
//   GET  /api/admin/audit/export.csv   — streaming CSV export
//   GET  /api/admin/audit/export.jsonl — streaming JSONL export
//   GET  /api/admin/audit/archives     — list S3 archives for this tenant
//   POST /api/admin/audit/archives/:date/restore — stream archive download
//
// All routes start with /api/ — covered by Caddy @api matcher; no edge-routing
// lint violation.
//
// Multi-tenancy: tenantId always read from req.session (never URL/body).
// Auth: all routes require admin role; caller injects preHandler chain.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { list, exportCsv, exportJsonl, countForExport, EXPORT_ROW_LIMIT } from './service.js';
import { auditInTx } from './audit.js';

// ---------------------------------------------------------------------------
// DI options
// ---------------------------------------------------------------------------

export interface RegisterAuditRoutesOptions {
  /** Admin-gated preHandler — `authChain({ roles: ['admin'] })` from apps/api. */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /** Optional throttle appended after adminOnly on the export + archive routes (injected: this module must not import @assessiq/auth). */
  heavyOpGuard?: preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Inline Zod schemas
// ---------------------------------------------------------------------------

const LIST_QUERY_SCHEMA = z.object({
  page: z.string().optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1)),
  pageSize: z.string().optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 50))
    .pipe(z.number().int().min(1).max(200)),
  actorUserId: z.string().uuid().optional(),
  actorKind: z.enum(['user', 'api_key', 'system']).optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const MAX_ARCHIVE_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

const ARCHIVE_BODY_SCHEMA = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  format: z.literal('jsonl'),
}).refine((b) => Date.parse(b.to) > Date.parse(b.from), { message: 'to must be after from', path: ['to'] })
  .refine((b) => Date.parse(b.to) - Date.parse(b.from) <= MAX_ARCHIVE_SPAN_MS, { message: 'range must be 366 days or less', path: ['to'] });

/** Drop undefined keys so the filters object stays clean in the audit payload. */
function definedOnly<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

const EXPORT_QUERY_SCHEMA = z.object({
  limit: z.coerce.number().int().min(1).max(100000).default(100000),
  actorUserId: z.string().uuid().optional(),
  actorKind: z.enum(['user', 'api_key', 'system']).optional(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerAuditRoutes(
  app: FastifyInstance,
  opts: RegisterAuditRoutesOptions,
): Promise<void> {
  const { adminOnly } = opts;
  const preHandler = Array.isArray(adminOnly) ? adminOnly : [adminOnly];
  const heavyPreHandler = opts.heavyOpGuard ? [...preHandler, opts.heavyOpGuard] : preHandler;

  // GET /api/admin/audit — paginated list
  app.get('/api/admin/audit', { preHandler }, async (req, reply) => {
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const rawQuery = req.query as Record<string, string>;
    const parsed = LIST_QUERY_SCHEMA.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters: ' + parsed.error.message);
    }
    const { page, pageSize, ...filters } = parsed.data;

    const result = await list({
      tenantId,
      filters: {
        ...(filters.actorUserId !== undefined ? { actorUserId: filters.actorUserId } : {}),
        ...(filters.actorKind !== undefined ? { actorKind: filters.actorKind } : {}),
        ...(filters.action !== undefined ? { action: filters.action } : {}),
        ...(filters.entityType !== undefined ? { entityType: filters.entityType } : {}),
        ...(filters.entityId !== undefined ? { entityId: filters.entityId } : {}),
        ...(filters.from !== undefined ? { from: filters.from } : {}),
        ...(filters.to !== undefined ? { to: filters.to } : {}),
      },
      page,
      pageSize,
    });

    return reply.code(200).send(result);
  });

  // GET /api/admin/audit/export.csv and export.jsonl — streaming, capped, self-audited.
  for (const format of ['csv', 'jsonl'] as const) {
    app.get(`/api/admin/audit/export.${format}`, { preHandler: heavyPreHandler }, async (req, reply) => {
      const { tenantId, userId } = (req as unknown as { session: { tenantId: string; userId: string } }).session;
      const parsed = EXPORT_QUERY_SCHEMA.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('invalid query parameters: ' + parsed.error.message);
      }
      const { limit, ...rest } = parsed.data;
      const filters = definedOnly(rest);

      const { truncated } = await countForExport(tenantId, filters, limit);
      // A read-only export is not an admin mutation, so its audit row gets its own short
      // transaction, written BEFORE the stream starts. The row never holds audit row contents.
      await withTenant(tenantId, (client) => auditInTx(client, {
        tenantId,
        actorKind: 'user',
        actorUserId: userId,
        action: 'audit.exported',
        entityType: 'audit_log',
        after: { format, filters, limit, truncated },
      }));

      const stream = format === 'csv'
        ? await exportCsv({ tenantId, filters, limit })
        : await exportJsonl({ tenantId, filters, limit, truncated });
      return reply
        .code(200)
        .header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson')
        .header('Content-Disposition', `attachment; filename="audit-${tenantId.slice(0, 8)}.${format}"`)
        .header('X-Export-Truncated', String(truncated))
        .send(stream);
    });
  }

  // POST /api/admin/audit/archive
  // Archive = export + mark. Deleting archived rows is the parked S3 job (archive-job.ts,
  // owner decision FR1 2026-10-03); the app role cannot delete audit_log rows.
  app.post('/api/admin/audit/archive', { preHandler: heavyPreHandler }, async (req, reply) => {
    const { tenantId, userId } = (req as unknown as { session: { tenantId: string; userId: string } }).session;
    const parsed = ARCHIVE_BODY_SCHEMA.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('invalid archive request: ' + parsed.error.message);
    }
    const { from, to, format } = parsed.data;
    const { rowCount, truncated } = await countForExport(tenantId, { from, to }, EXPORT_ROW_LIMIT);
    const exportUrl = `/api/admin/audit/export.jsonl?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const row = await withTenant(tenantId, (client) => auditInTx(client, {
      tenantId,
      actorKind: 'user',
      actorUserId: userId,
      action: 'audit.archived',
      entityType: 'audit_log',
      after: { from, to, row_count: rowCount, format, export_path: exportUrl },
    }));
    return reply.code(200).send({
      archive_id: row?.id ?? null,
      row_count: rowCount,
      truncated,
      export_url: exportUrl,
    });
  });

  // GET /api/admin/audit/archives — list S3 archives
  // Phase 4 placeholder: returns empty list when S3_BUCKET is not set.
  app.get('/api/admin/audit/archives', { preHandler }, async (req, reply) => {
    const s3Bucket = process.env['S3_BUCKET'];
    if (s3Bucket === undefined || s3Bucket.length === 0) {
      return reply.code(200).send({ archives: [], note: 'S3 archive not configured (Phase 4)' });
    }
    // Phase 4: list objects under <tenantId>/audit/ prefix in S3.
    return reply.code(200).send({ archives: [], note: 'S3 listing pending Phase 4 implementation' });
  });

  // POST /api/admin/audit/archives/:date/restore — stream archive download
  // Phase 4 placeholder: returns 503 when S3_BUCKET is not set.
  app.post('/api/admin/audit/archives/:date/restore', { preHandler }, async (req, reply) => {
    const s3Bucket = process.env['S3_BUCKET'];
    if (s3Bucket === undefined || s3Bucket.length === 0) {
      return reply.code(503).send({
        error: 'S3_NOT_CONFIGURED',
        message: 'Audit archive restore requires S3_BUCKET (Phase 4)',
      });
    }
    // Phase 4: stream object from S3 to client.
    return reply.code(503).send({ error: 'S3_NOT_IMPLEMENTED', message: 'Phase 4 pending' });
  });
}
