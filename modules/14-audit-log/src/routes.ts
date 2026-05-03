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
import { list, exportCsv, exportJsonl } from './service.js';

// ---------------------------------------------------------------------------
// DI options
// ---------------------------------------------------------------------------

export interface RegisterAuditRoutesOptions {
  /** Admin-gated preHandler — `authChain({ roles: ['admin'] })` from apps/api. */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
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

const EXPORT_QUERY_SCHEMA = z.object({
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

  // GET /api/admin/audit/export.csv — streaming CSV
  app.get('/api/admin/audit/export.csv', { preHandler }, async (req, reply) => {
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const rawQuery = req.query as Record<string, string>;
    const parsed = EXPORT_QUERY_SCHEMA.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters: ' + parsed.error.message);
    }

    const stream = await exportCsv({ tenantId, filters: {
      ...(parsed.data.actorUserId !== undefined ? { actorUserId: parsed.data.actorUserId } : {}),
      ...(parsed.data.actorKind !== undefined ? { actorKind: parsed.data.actorKind } : {}),
      ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      ...(parsed.data.entityType !== undefined ? { entityType: parsed.data.entityType } : {}),
      ...(parsed.data.entityId !== undefined ? { entityId: parsed.data.entityId } : {}),
      ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    } });
    return reply
      .code(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-${tenantId.slice(0, 8)}.csv"`)
      .send(stream);
  });

  // GET /api/admin/audit/export.jsonl — streaming JSONL
  app.get('/api/admin/audit/export.jsonl', { preHandler }, async (req, reply) => {
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const rawQuery = req.query as Record<string, string>;
    const parsed = EXPORT_QUERY_SCHEMA.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters: ' + parsed.error.message);
    }

    const stream = await exportJsonl({ tenantId, filters: {
      ...(parsed.data.actorUserId !== undefined ? { actorUserId: parsed.data.actorUserId } : {}),
      ...(parsed.data.actorKind !== undefined ? { actorKind: parsed.data.actorKind } : {}),
      ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      ...(parsed.data.entityType !== undefined ? { entityType: parsed.data.entityType } : {}),
      ...(parsed.data.entityId !== undefined ? { entityId: parsed.data.entityId } : {}),
      ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
    } });
    return reply
      .code(200)
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="audit-${tenantId.slice(0, 8)}.jsonl"`)
      .send(stream);
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
