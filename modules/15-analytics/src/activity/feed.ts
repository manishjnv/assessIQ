// AssessIQ — modules/15-analytics/src/activity/feed.ts
//
// Phase 9 (extension) — GET /api/admin/activity/feed
//
// Unified activity feed that merges admin/reviewer actions (from audit_log)
// with candidate actions (from attempt_events) into one chronological,
// role-filterable feed for the admin Activity page.
//
// Data sources:
//   - audit_log     — RLS-scoped live table (tenant_id = GUC)
//   - attempt_events — RLS-scoped via JOIN attempts (attempts has tenant RLS)
//     NOTE: attempt_events has NO tenant_id column. Tenancy boundary is the
//     mandatory JOIN attempts a ON a.id = ae.attempt_id.
//
// The two legs are UNION ALL'd into a single CTE, ordered at DESC, with
// COUNT(*) OVER() for the total count, then paged via LIMIT/OFFSET.
//
// Role filter:
//   all       → both legs UNION ALL'd
//   admin     → audit leg only, actor role IN ('admin','super_admin')
//   reviewer  → audit leg only, actor role = 'reviewer'
//   candidate → attempt leg only
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.
//
// INVARIANT: READ-ONLY. Never INSERT/UPDATE/DELETE audit_log (append-only,
// load-bearing). Never INSERT/UPDATE/DELETE attempt_events.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string;                        // 'audit:<id>' | 'attempt:<id>'
  source: 'audit' | 'attempt';
  at: string;                        // ISO 8601 timestamp
  actorRole: 'admin' | 'reviewer' | 'candidate' | 'system';
  actorLabel: string;                // user name or email or actor_kind
  action: string;                    // raw action / event_type value
  actionLabel: string;               // human-readable verb phrase
  targetType: string | null;         // entity_type (audit) | 'attempt' (attempt leg)
  targetId: string | null;           // entity_id (audit) | attempt_id (attempt leg)
  targetLabel: string | null;        // assessment name for attempt leg; null for audit
}

export interface ActivityFeedResponse {
  page: number;
  pageSize: number;
  total: number;
  items: FeedItem[];
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

export const ActivityFeedQuerySchema = z.object({
  role:        z.enum(['all', 'admin', 'reviewer', 'candidate']).optional(),
  action:      z.string().optional(),
  actorUserId: z.string().uuid().optional(),
  from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page:        z.coerce.number().int().min(1).optional(),
  pageSize:    z.coerce.number().int().min(1).max(100).optional(),
});
export type ActivityFeedQuery = z.infer<typeof ActivityFeedQuerySchema>;

// ---------------------------------------------------------------------------
// Action label maps
// ---------------------------------------------------------------------------

/**
 * Candidate event_type → human-readable verb phrase.
 * Source: modules/06-attempt-engine/EVENTS.md
 */
const ATTEMPT_EVENT_LABELS: Record<string, string> = {
  question_view:       'viewed a question',
  answer_save:         'saved an answer',
  flag:                'flagged a question',
  unflag:              'unflagged a question',
  tab_blur:            'switched away from tab',
  tab_focus:           'returned to tab',
  copy:                'copied text',
  paste:               'pasted text',
  nav_back:            'navigated back',
  time_milestone:      'reached time milestone',
  multi_tab_conflict:  'multi-tab conflict detected',
  event_volume_capped: 'event volume cap reached',
};

/**
 * Audit log action → human-readable verb phrase.
 * Sourced from ACTION_CATALOG in modules/14-audit-log/src/types.ts.
 * The fallback for unknown actions is derived by replacing dots/underscores
 * with spaces (see humanizeAction() below).
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  // Auth
  'auth.login.totp_success':              'logged in (TOTP)',
  'auth.login.totp_failed':               'login failed (TOTP)',
  'auth.login.locked':                    'account locked',
  'auth.totp.enrolled':                   'enrolled TOTP',
  'auth.totp.reset':                      'reset TOTP',
  'auth.recovery.used':                   'used recovery code',
  'auth.candidate.login_link_requested':  'requested login link',
  'auth.candidate.login_link_consumed':   'consumed login link',
  // Tenant
  'tenant.settings.updated':              'updated tenant settings',
  'tenant.branding.updated':              'updated tenant branding',
  'tenant.suspended':                     'suspended tenant',
  'tenant.resumed':                       'resumed tenant',
  'tenant.created':                       'created tenant',
  'tenant.create_incomplete':             'tenant creation incomplete',
  'tenant.archived':                      'archived tenant',
  'tenant.unarchived':                    'unarchived tenant',
  'tenant.renamed':                       'renamed tenant',
  'tenant.purged':                        'purged tenant',
  'tenant.plan_updated':                  'updated tenant plan',
  'tenant.entitlement_granted':           'granted entitlement',
  'tenant.entitlement_revoked':           'revoked entitlement',
  'tenant.pack_cloned':                   'cloned question pack',
  'tenant.pack_resynced':                 'resynced question pack',
  'tenant_settings.ai_generate_mode.updated': 'updated AI generate mode',
  // User
  'user.created':                         'created user',
  'user.updated':                         'updated user',
  'user.role.changed':                    'changed user role',
  'user.disabled':                        'disabled user',
  'user.reenabled':                       'reenabled user',
  'user.deleted':                         'deleted user',
  'user.soft_deleted':                    'soft-deleted user',
  'user.restored':                        'restored user',
  'user.invited':                         'invited user',
  'user.invitation_cancelled':            'cancelled invitation',
  'user.pii.erased':                      'erased user PII',
  'user.data.exported':                   'exported user data',
  // Question bank
  'pack.created':                         'created question pack',
  'pack.published':                       'published question pack',
  'pack.revised':                         'revised question pack',
  'pack.archived':                        'archived question pack',
  'question.created':                     'created question',
  'question.updated':                     'updated question',
  'question.imported':                    'imported questions',
  'question.ai_generated':               'generated questions with AI',
  // Assessment lifecycle
  'assessment.created':                   'created assessment',
  'assessment.updated':                   'updated assessment',
  'assessment.published':                 'published assessment',
  'assessment.closed':                    'closed assessment',
  'assessment.invite':                    'sent assessment invite',
  // Attempt
  'attempt.started':                      'started attempt',
  'attempt.submitted':                    'submitted attempt',
  'attempt.released':                     'released attempt result',
  'attempt.deleted':                      'deleted attempt',
  'attempt.exported':                     'exported attempt data',
  // Grading
  'grading.override':                     'overrode grading',
  'grading.retry':                        'retried grading',
  'grading.accepted':                     'accepted AI grading',
  'grading.claimed':                      'claimed attempt for grading',
  'grading.released':                     'released graded attempt',
  'attempt_scores.recomputed_by_admin':   'recomputed attempt scores',
  // API keys + embed
  'api_key.created':                      'created API key',
  'api_key.revoked':                      'revoked API key',
  'embed_secret.created':                 'created embed secret',
  'embed_secret.rotated':                 'rotated embed secret',
  'embed_secret.revoked':                 'revoked embed secret',
  'embed_origin.added':                   'added embed origin',
  'embed_origin.removed':                 'removed embed origin',
  // Webhooks
  'webhook.created':                      'created webhook',
  'webhook.deleted':                      'deleted webhook',
  'webhook.replayed':                     'replayed webhook',
  'webhook_secret.rotated':               'rotated webhook secret',
  // Help system
  'help.content.updated':                 'updated help content',
  'help.content.imported':                'imported help content',
  // Domain management
  'domain.created':                       'created platform domain',
  'domain.archived':                      'archived platform domain',
  'domain.reactivated':                   'reactivated platform domain',
  // Certification
  'certification.cert.issue':             'issued certificate',
  'certification.cert.upgrade':           'upgraded certificate',
  'certificates.revoked':                 'revoked certificates',
  'certificates.reissued':               'reissued certificates',
  // Admin
  'admin.invitation.resent':              'resent admin invitation',
  // Dev
  'dev.mint_session':                     'minted test session (dev)',
};

/**
 * Fallback humanizer: replace dots and underscores with spaces, trim.
 * e.g. "grading.accepted" → "grading accepted"
 *      "attempt_scores.recomputed_by_admin" → "attempt scores recomputed by admin"
 */
function humanizeAction(action: string): string {
  return action.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getAuditLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? humanizeAction(action);
}

function getAttemptLabel(eventType: string): string {
  return ATTEMPT_EVENT_LABELS[eventType] ?? humanizeAction(eventType);
}

// ---------------------------------------------------------------------------
// Raw DB row shape
// ---------------------------------------------------------------------------

interface FeedRow {
  source: 'audit' | 'attempt';
  raw_id: string;
  at: Date;
  actor_role: string;
  actor_label: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
}

// ---------------------------------------------------------------------------
// Repository — runs inside a withTenant callback (GUC already set)
// ---------------------------------------------------------------------------

export async function queryActivityFeed(
  client: PoolClient,
  _tenantId: string,
  opts: {
    role: 'all' | 'admin' | 'reviewer' | 'candidate';
    action?: string | undefined;
    actorUserId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    page: number;
    pageSize: number;
  },
): Promise<ActivityFeedResponse> {
  const { role, action, actorUserId, from, to, page, pageSize } = opts;

  // -------------------------------------------------------------------------
  // Build parameterized SQL fragments
  // -------------------------------------------------------------------------

  const params: unknown[] = [];
  function addParam(v: unknown): string {
    params.push(v);
    return `$${params.length}`;
  }

  // Optional date window — inclusive on both ends, applied as a 1-day range
  // to convert a YYYY-MM-DD date string into a timestamptz boundary.
  function dateFromClause(col: string): string {
    if (!from) return '';
    return `AND ${col} >= ${addParam(from)}::date`;
  }
  function dateToClause(col: string): string {
    if (!to) return '';
    return `AND ${col} < (${addParam(to)}::date + interval '1 day')`;
  }

  // Optional exact-match action filter
  // Use explicit ::text cast to ensure Postgres can resolve the param type inside CTEs.
  function actionClause(col: string): string {
    if (!action) return '';
    return `AND ${col} = ${addParam(action)}::text`;
  }

  // Optional actor_user_id filter
  function actorClause(col: string): string {
    if (!actorUserId) return '';
    return `AND ${col} = ${addParam(actorUserId)}::uuid`;
  }

  // -------------------------------------------------------------------------
  // Build SQL legs — only build each leg if it will appear in the final query.
  // This is CRITICAL: addParam() mutates the params array and increments $N
  // counters. Building a leg that ends up unused would assign wrong $N indices
  // to the leg that IS used, producing "bind message supplies N params but
  // statement requires M" errors or wrong type-inference errors in Postgres.
  // -------------------------------------------------------------------------

  function buildAuditLeg(): string {
    let auditRoleFilter = '';
    if (role === 'admin') {
      auditRoleFilter = `AND u.role IN ('admin', 'super_admin')`;
    } else if (role === 'reviewer') {
      auditRoleFilter = `AND u.role = 'reviewer'`;
    }

    return `
    SELECT
      'audit'::text                                                  AS source,
      al.id::text                                                    AS raw_id,
      al.at                                                          AS at,
      CASE
        WHEN al.actor_kind <> 'user' THEN 'system'
        WHEN u.role IN ('admin', 'super_admin') THEN 'admin'
        WHEN u.role = 'reviewer' THEN 'reviewer'
        WHEN u.role = 'candidate' THEN 'candidate'
        ELSE 'system'
      END                                                            AS actor_role,
      COALESCE(u.name, u.email, al.actor_kind)                      AS actor_label,
      al.action                                                      AS action,
      al.entity_type                                                 AS target_type,
      al.entity_id::text                                             AS target_id,
      NULL::text                                                     AS target_label
    FROM audit_log al
    LEFT JOIN users u ON u.id = al.actor_user_id
    WHERE TRUE
      AND (u.id IS NULL OR u.erased_at IS NULL)
      ${dateFromClause('al.at')}
      ${dateToClause('al.at')}
      ${actionClause('al.action')}
      ${actorClause('al.actor_user_id')}
      ${auditRoleFilter}`;
  }

  function buildAttemptLeg(): string {
    // Tenancy boundary: JOIN attempts a ON a.id = ae.attempt_id
    //   attempts has RLS (tenant_id = GUC) → attempt_events are transitively scoped.
    //   attempt_events has NO tenant_id column — do NOT add a WHERE tenant filter.
    //   The JOIN is the ONLY tenancy boundary here; do not remove or replace it.
    return `
    SELECT
      'attempt'::text                                                AS source,
      ae.id::text                                                    AS raw_id,
      ae.at                                                          AS at,
      'candidate'::text                                              AS actor_role,
      COALESCE(u.name, u.email, 'candidate')                        AS actor_label,
      ae.event_type                                                  AS action,
      'attempt'::text                                                AS target_type,
      ae.attempt_id::text                                            AS target_id,
      asmt.name                                                      AS target_label
    FROM attempt_events ae
    JOIN attempts a ON a.id = ae.attempt_id
    JOIN users u ON u.id = a.user_id
    LEFT JOIN assessments asmt ON asmt.id = a.assessment_id
    WHERE TRUE
      AND u.erased_at IS NULL
      ${dateFromClause('ae.at')}
      ${dateToClause('ae.at')}
      ${actionClause('ae.event_type')}
      ${actorClause('a.user_id')}`;
  }

  // -------------------------------------------------------------------------
  // Compose UNION (or single leg when role is filtered)
  // Build each leg lazily — only the legs used in the final query call addParam.
  // -------------------------------------------------------------------------

  let unionSql: string;
  if (role === 'candidate') {
    unionSql = buildAttemptLeg();
  } else if (role === 'admin' || role === 'reviewer') {
    unionSql = buildAuditLeg();
  } else {
    // 'all' — both legs. Build audit first, then attempt (audit $N comes first).
    unionSql = `${buildAuditLeg()}\n    UNION ALL\n    ${buildAttemptLeg()}`;
  }

  // -------------------------------------------------------------------------
  // Query 1 — total count (filter params only; survives empty result sets)
  // -------------------------------------------------------------------------

  // Snapshot the filter params before adding LIMIT/OFFSET
  const filterParams = [...params];

  const countSql = `
    SELECT COUNT(*)::text AS total
    FROM (
      ${unionSql}
    ) feed`;

  const countResult = await client.query<{ total: string }>(countSql, filterParams);
  const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

  // -------------------------------------------------------------------------
  // Query 2 — paged data rows
  // -------------------------------------------------------------------------

  const offset = (page - 1) * pageSize;
  const limitParam  = addParam(pageSize);
  const offsetParam = addParam(offset);

  const dataSql = `
    SELECT
      source,
      raw_id,
      at,
      actor_role,
      actor_label,
      action,
      target_type,
      target_id,
      target_label
    FROM (
      ${unionSql}
    ) feed
    ORDER BY at DESC, raw_id DESC
    LIMIT ${limitParam}
    OFFSET ${offsetParam}`;

  const dataResult = await client.query<FeedRow>(dataSql, params);

  const items: FeedItem[] = dataResult.rows.map((row) => {
    const source = row.source as 'audit' | 'attempt';
    const actorRole = row.actor_role as FeedItem['actorRole'];
    const actionLabel = source === 'audit'
      ? getAuditLabel(row.action)
      : getAttemptLabel(row.action);

    return {
      id: `${source}:${row.raw_id}`,
      source,
      at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
      actorRole,
      actorLabel: row.actor_label ?? row.action,
      action: row.action,
      actionLabel,
      targetType: row.target_type,
      targetId: row.target_id,
      targetLabel: row.target_label,
    };
  });

  return { page, pageSize, total, items };
}

// ---------------------------------------------------------------------------
// Service — resolves defaults then delegates to withTenant
// ---------------------------------------------------------------------------

export async function getActivityFeed(
  tenantId: string,
  query: ActivityFeedQuery,
): Promise<ActivityFeedResponse> {
  const role        = query.role        ?? 'all';
  const page        = query.page        ?? 1;
  const pageSize    = query.pageSize    ?? 25;
  const action      = query.action;
  const actorUserId = query.actorUserId;
  const from        = query.from;
  const to          = query.to;

  return withTenant(tenantId, (client) =>
    queryActivityFeed(client, tenantId, { role, action, actorUserId, from, to, page, pageSize }),
  );
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerActivityFeedRoute(
  app: FastifyInstance,
  preHandler: preHandlerHookHandler[],
): void {
  app.get('/api/admin/activity/feed', { preHandler }, async (req, reply) => {
    const parsed = ActivityFeedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('invalid query parameters', {
        details: { validation: parsed.error.errors },
      });
    }
    const tenantId = (req as unknown as { session: { tenantId: string } }).session.tenantId;
    const data = await getActivityFeed(tenantId, parsed.data);
    return reply.send(data);
  });
}
