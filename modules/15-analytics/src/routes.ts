// AssessIQ — modules/15-analytics/src/routes.ts
//
// Phase 3 G3.C — Fastify admin route plugin for analytics.
//
// Mounts (per P3.D15):
//   GET /api/admin/reports/topic-heatmap?packId=&from=&to=
//   GET /api/admin/reports/archetype-distribution/:assessmentId
//   GET /api/admin/reports/cost-by-month?year=YYYY
//   GET /api/admin/reports/exports/attempts.csv
//   GET /api/admin/reports/exports/attempts.jsonl
//   GET /api/admin/reports/exports/topic-heatmap.csv
//
// NOTE: /admin/reports/cohort/:assessmentId and /admin/reports/individual/:userId
// are owned by 09-scoring (G2.B Session 3). 15-analytics is the service layer
// those routes call; no route re-registration here.
//
// All routes are under /api/admin/* → covered by Caddy @api path matcher.
// No public-facing leaderboard. Tenant context from session only.
//
// Export endpoints write an audit_log row (admin downloading bulk data is an
// auditable action per Phase 3 seam review). The audit() call uses
// actorKind: 'user' + the admin's userId from req.session.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { config, ValidationError } from '@assessiq/core';
import { audit } from '@assessiq/audit-log';
import {
  getAdminCohortReport,
  topicHeatmap,
  archetypeDistribution,
  gradingCostByMonth,
  exportAttemptsCsv,
  exportAttemptsJsonl,
  exportTopicHeatmapCsv,
} from './service.js';
import { ExportFilterSchema } from './types.js';
import { EXPORT_ROW_CAP } from './repository.js';
import { processRefreshMvJob } from './refresh-mv-job.js';

// ---------------------------------------------------------------------------
// Convenience session accessor (matches the cast pattern across all modules)
// ---------------------------------------------------------------------------

type SessionReq = { session: { tenantId: string; userId: string } };
function sess(req: unknown): SessionReq['session'] {
  return (req as unknown as SessionReq).session;
}

// ---------------------------------------------------------------------------
// DI options
// ---------------------------------------------------------------------------

export interface RegisterAnalyticsRoutesOptions {
  /** Admin-gated preHandler — authChain({ roles: ['admin'] }) from apps/api. */
  adminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
  /**
   * Super-admin-only preHandler — authChain({ roles: ['super_admin'] }) from apps/api.
   * Used for the POST /api/admin/analytics/refresh endpoint that triggers a
   * manual REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv.
   * Super-admin required because the refresh acquires a non-exclusive lock and
   * could be used to mask data-staleness in reports — restrict to platform ops.
   */
  superAdminOnly: preHandlerHookHandler[] | preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const TopicHeatmapQuerySchema = z.object({
  packId: z.string().uuid({ message: 'packId must be a valid UUID' }),
  from: z.string().optional(),
  to: z.string().optional(),
});

const CostByMonthQuerySchema = z.object({
  year: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().min(2020).max(2100)),
});

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  opts: RegisterAnalyticsRoutesOptions,
): Promise<void> {
  const preHandler = Array.isArray(opts.adminOnly)
    ? opts.adminOnly
    : [opts.adminOnly];
  const superAdminHandler = Array.isArray(opts.superAdminOnly)
    ? opts.superAdminOnly
    : [opts.superAdminOnly];

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/topic-heatmap
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/topic-heatmap',
    { preHandler },
    async (req, reply) => {
      const parsed = TopicHeatmapQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('invalid query parameters', {
          details: { validation: parsed.error.errors },
        });
      }
      const { tenantId } = sess(req);
      const { packId, from, to } = parsed.data;
      const result = await topicHeatmap({
        tenantId,
        packId,
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
      });
      return reply.send({ data: result });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/archetype-distribution/:assessmentId
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/archetype-distribution/:assessmentId',
    { preHandler },
    async (req, reply) => {
      const { assessmentId } = req.params as { assessmentId: string };
      if (!assessmentId.match(/^[0-9a-f-]{36}$/i)) {
        throw new ValidationError('assessmentId must be a valid UUID');
      }
      const { tenantId } = sess(req);
      const result = await archetypeDistribution(tenantId, assessmentId);
      return reply.send({ data: result });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/cost-by-month?year=YYYY
  // P3.D21: returns { items: [], mode: 'claude-code-vps', message: '...' }
  // when AI_PIPELINE_MODE=claude-code-vps.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/cost-by-month',
    { preHandler },
    async (req, reply) => {
      const parsed = CostByMonthQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('year must be a 4-digit integer between 2020 and 2100', {
          details: { validation: parsed.error.errors },
        });
      }
      const { tenantId } = sess(req);

      if (config.AI_PIPELINE_MODE === 'claude-code-vps') {
        return reply.send({
          items: [],
          mode: 'claude-code-vps',
          message:
            'No cost telemetry in this pipeline mode — see docs/05-ai-pipeline.md D6 for context',
        });
      }

      const items = await gradingCostByMonth(tenantId, parsed.data.year);
      return reply.send({ items });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/exports/attempts.csv
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/exports/attempts.csv',
    { preHandler },
    async (req, reply) => {
      const parsed = ExportFilterSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('invalid query parameters', {
          details: { validation: parsed.error.errors },
        });
      }
      const { tenantId, userId } = sess(req);

      // Audit: admin downloading bulk data is an auditable action
      await audit({
        tenantId,
        actorUserId: userId,
        actorKind: 'user',
        action: 'attempt.exported',
        entityType: 'attempts',
        after: { format: 'csv', filters: parsed.data as Record<string, unknown> },
      });

      const stream = await exportAttemptsCsv({
        tenantId,
        filters: parsed.data,
      });

      void reply.header('Content-Type', 'text/csv; charset=utf-8');
      void reply.header('Content-Disposition', 'attachment; filename="attempts.csv"');
      void reply.header('X-Export-Row-Cap', String(EXPORT_ROW_CAP));
      return reply.send(stream);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/exports/attempts.jsonl
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/exports/attempts.jsonl',
    { preHandler },
    async (req, reply) => {
      const parsed = ExportFilterSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('invalid query parameters', {
          details: { validation: parsed.error.errors },
        });
      }
      const { tenantId, userId } = sess(req);

      await audit({
        tenantId,
        actorUserId: userId,
        actorKind: 'user',
        action: 'attempt.exported',
        entityType: 'attempts',
        after: { format: 'jsonl', filters: parsed.data as Record<string, unknown> },
      });

      const stream = await exportAttemptsJsonl({
        tenantId,
        filters: parsed.data,
      });

      void reply.header('Content-Type', 'application/x-ndjson');
      void reply.header('Content-Disposition', 'attachment; filename="attempts.jsonl"');
      void reply.header('X-Export-Row-Cap', String(EXPORT_ROW_CAP));
      return reply.send(stream);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/exports/topic-heatmap.csv
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/reports/exports/topic-heatmap.csv',
    { preHandler },
    async (req, reply) => {
      const parsed = TopicHeatmapQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('invalid query parameters', {
          details: { validation: parsed.error.errors },
        });
      }
      const { tenantId, userId } = sess(req);
      const { packId, from, to } = parsed.data;

      await audit({
        tenantId,
        actorUserId: userId,
        actorKind: 'user',
        action: 'attempt.exported',
        entityType: 'topic_heatmap',
        after: { format: 'csv', packId, ...(from !== undefined && { from }), ...(to !== undefined && { to }) },
      });

      const stream = await exportTopicHeatmapCsv({
        tenantId,
        packId,
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
      });

      void reply.header('Content-Type', 'text/csv; charset=utf-8');
      void reply.header('Content-Disposition', 'attachment; filename="topic-heatmap.csv"');
      return reply.send(stream);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/cycles/:cycleId/cohort-report
  //
  // "cycle" in the URL is the assessment_id — AssessIQ uses "assessment" in
  // the DB but the API surface uses "cycle" to match the Phase 3 plan spec.
  //
  // Auth: any tenant admin (admin role, scoped to their tenant via withTenant).
  // Query: ?archetype=<label> (optional, filters attempts[] only — stats cover
  //   the full cohort regardless of the filter).
  // Response 200: AdminCohortReport (see modules/15-analytics/src/types.ts)
  // Response 400: cycleId is not a valid UUID
  // Response 403: caller is not an admin (authChain throws AuthzError → 403)
  // Response 404: not emitted from this handler — an unknown assessmentId
  //   returns a valid response with total_attempts=0 and empty arrays.
  //
  // RLS: the MV has no RLS. The WHERE tenant_id = current_setting(...)
  // clause in queryAdminCohortReport enforces tenant isolation.
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/cycles/:cycleId/cohort-report',
    { preHandler },
    async (req, reply) => {
      const { cycleId } = req.params as { cycleId: string };
      if (!/^[0-9a-f-]{36}$/i.test(cycleId)) {
        throw new ValidationError('cycleId must be a valid UUID');
      }
      const query = req.query as Record<string, string | undefined>;
      const archetypeFilter = query['archetype'];
      const { tenantId } = sess(req);

      const report = await getAdminCohortReport(tenantId, cycleId, {
        ...(archetypeFilter !== undefined && { archetype: archetypeFilter }),
      });

      return reply.send(report);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/analytics/refresh
  //
  // Triggers REFRESH MATERIALIZED VIEW CONCURRENTLY attempt_summary_mv.
  // Restricted to super_admin: the refresh acquires a non-exclusive table lock
  // and is a platform-operator action (not a per-tenant operation).
  //
  // MVP manual-only policy: the nightly BullMQ job handles scheduled refresh.
  // This endpoint allows platform ops to force a refresh after a bulk import
  // or a grading run without waiting for the next nightly window.
  //
  // Auto-refresh on every attempt write is explicitly deferred (Phase 3.D
  // follow-up) — see modules/15-analytics/SKILL.md for rationale.
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/analytics/refresh',
    { preHandler: superAdminHandler },
    async (_req, reply) => {
      const result = await processRefreshMvJob();
      return reply.code(200).send({ ok: true, duration_ms: result.duration_ms });
    },
  );
}
