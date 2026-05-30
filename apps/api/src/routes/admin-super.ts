// AssessIQ — apps/api/src/routes/admin-super.ts
//
// Super-admin-only routes. These endpoints operate across tenant boundaries
// and require role = 'super_admin'. No tenant admin or reviewer can reach them.
//
// Route prefix: /api/admin/super
// Rationale for the prefix: per project CLAUDE.md, admin routes live under
// /api/admin/*. The "super" sub-prefix distinguishes cross-tenant platform
// operations from per-tenant admin operations. It makes it explicit in Caddy
// logs and nginx access logs when a super-admin is acting.
//
// INVARIANTS:
//   - Every handler verifies req.session is present (enforced by preHandler chain).
//   - Every handler verifies req.session.role === 'super_admin' (enforced by authChain).
//   - No handler widens the updateTenantSettingsRow patch surface — ai_generate_mode
//     changes use the isolated updateAiGenerateMode service method.
//
// C4 additions (super-admin-onboarding contract, 2026-05-17):
//   POST /api/admin/super/companies  — create company tenant + seed + invite admin
//   GET  /api/admin/super/tenants    — list all tenants (system-role, visibility only)

import type { FastifyInstance } from 'fastify';
import { ValidationError, NotFoundError, ConflictError, streamLogger } from '@assessiq/core';
import {
  updateAiGenerateMode,
  createTenant,
  activateTenant,
  getPool,
  assertTenantActive,
  suspendTenant,
  resumeTenant,
  archiveTenant,
  unarchiveTenant,
  withTenant,
} from '@assessiq/tenancy';
import { sessions, logLifecycleEvent } from '@assessiq/auth';
import { inviteUser, cancelInvitation, sweepUserSessions } from '@assessiq/users';
import { audit, auditInTx } from '@assessiq/audit-log';
import {
  provisionDefaultPlan,
  getAllTenantUsage,
  getTenantBillingDetail,
  getTenantBillingEventsCsv,
  updateTenantPlan,
  listTenantEntitlements,
  listTenantContentScopes,
  grantEntitlement,
  revokeEntitlement,
  type PlanTier,
  type UpdateTenantPlanPatch,
  type EntitlementScopeType,
} from '@assessiq/billing';
import {
  seedTenantTaxonomy,
  listPlatformDomains,
  createPlatformDomain,
  setPlatformDomainStatus,
} from '@assessiq/question-bank';
import { authChain } from '../middleware/auth-chain.js';

const log = streamLogger('app');

// ---------------------------------------------------------------------------
// Auth chains
// ---------------------------------------------------------------------------

// Gate: session must exist AND role must be 'super_admin'.
// requireAuth in require-auth.ts enforces totpVerified=true for super_admin
// unconditionally (MFA_REQUIRED override — see require-auth.ts).
const superAdminOnly = authChain({ roles: ['super_admin'] });

// Fresh-MFA gate for mutating operations: TOTP must have occurred within 15min.
// This is in addition to the always-on totpVerified=true check above.
const superAdminFreshMfa = authChain({
  roles: ['super_admin'],
  freshMfaWithinMinutes: 15,
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminSuperRoutes(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode
  //
  // Flip `tenant_settings.ai_generate_mode` for the target tenant.
  //
  // Response 200: { tenantId, ai_generate_mode, previous, updatedAt, auditId }
  // Response 400: invalid mode value
  // Response 403: caller is not a super_admin (authChain throws AuthzError → 403)
  // Response 404: tenant has no tenant_settings row
  //
  // Audit guarantee: the UPDATE and the audit_log INSERT are in the same
  // Postgres transaction via updateAiGenerateMode → auditInTx. If the audit
  // INSERT fails, the UPDATE rolls back. Atomicity is non-negotiable per
  // project CLAUDE.md hard rule.
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/tenants/:tenantId/ai-generate-mode',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      const body = req.body as { mode?: unknown };

      // Validate mode: must be exactly one of the three allowed values.
      // Anything else (undefined, empty string, typos) is a 400.
      const mode = body?.mode;
      if (mode !== 'omnibus' && mode !== 'sharded' && mode !== null) {
        throw new ValidationError(
          'mode must be "omnibus", "sharded", or null',
          { details: { code: 'INVALID_MODE', received: mode } },
        );
      }
      const newMode = mode as 'omnibus' | 'sharded' | null;

      // req.session is guaranteed non-null by the preHandler chain.
      const result = await updateAiGenerateMode(
        req.session!.userId,
        tenantId,
        newMode,
      );

      return reply.code(200).send({
        tenantId: result.tenantId,
        ai_generate_mode: result.ai_generate_mode,
        previous: result.previous,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/super/tenants/:tenantId
  //
  // Rename a tenant's display name (the `tenants.name` column) — surfaced from
  // the Platform page "Edit company" modal. Display-only: the slug is permanent
  // and is NOT touched here, and there is no isolation/RLS impact.
  //
  // Gate: super_admin + fresh MFA. Body: { name }.
  // Mirrors the suspendTenant audited pattern: withTenant(tenantId) UPDATE +
  // auditInTx('tenant.renamed') in one transaction.
  //
  // 200: { tenantId, name, previousName, auditId, noOp }
  // 400: MISSING_NAME / NAME_TOO_LONG
  // 404: tenant not found
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/tenants/:tenantId',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      const body = (req.body ?? {}) as { name?: unknown };

      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('name is required', { details: { code: 'MISSING_NAME' } });
      }
      if (body.name.length > 200) {
        throw new ValidationError('name must not exceed 200 characters', {
          details: { code: 'NAME_TOO_LONG' },
        });
      }
      const newName = body.name.trim();

      const result = await withTenant(tenantId, async (client) => {
        // FOR UPDATE row-locks the tenant (matches the suspendTenant lifecycle
        // pattern) so two concurrent renames can't both pass the no-op check and
        // double-write / double-audit.
        const cur = await client.query<{ name: string }>(
          `SELECT name FROM tenants WHERE id = $1 FOR UPDATE`,
          [tenantId],
        );
        const row = cur.rows[0];
        if (row === undefined) {
          throw new NotFoundError(`Tenant not found: ${tenantId}`);
        }
        const previousName = row.name;
        if (previousName === newName) {
          return { tenantId, name: newName, previousName, auditId: null, noOp: true };
        }

        await client.query(
          `UPDATE tenants SET name = $1, updated_at = now() WHERE id = $2`,
          [newName, tenantId],
        );

        const auditRow = await auditInTx(client, {
          tenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'tenant.renamed',
          entityType: 'tenant',
          entityId: tenantId,
          before: { name: previousName },
          after: { name: newName },
        });

        return { tenantId, name: newName, previousName, auditId: auditRow.id, noOp: false };
      });

      return reply.code(200).send(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/companies
  //
  // Create a new company tenant, seed its taxonomy, and invite the first admin.
  //
  // Gate: super_admin + fresh MFA (15-minute window).
  //
  // Orchestration (soft-create pattern):
  //   1. createTenant (C2) → status='provisioning'
  //   2. seedTenantTaxonomy (C5) — idempotent, withTenant(newTenantId)
  //   3. inviteUser (03-users) — withTenant(newTenantId)
  //   4. activateTenant → status='active'
  //   5. audit tenant.created
  //
  // Failure: any step after #1 fails → tenant stays 'provisioning';
  // audit tenant.create_incomplete is written; actionable error returned.
  // No half-live 'active' tenant ever exists.
  //
  // Cross-tenant safety: steps 2 + 3 use explicit withTenant(newTenantId)
  // — NEVER the super-admin's platform tenantId. activateTenant uses the
  // system-role path (same as createTenant) so no app.current_tenant confusion.
  //
  // Response 201: { tenantId, slug, name, status, invitation }
  // Response 409: slug collision (TENANT_SLUG_CONFLICT)
  // Response 400: validation error
  // Response 403: not super_admin / MFA too old
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/super/companies',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const body = req.body as {
        name?: unknown;
        slug?: unknown;
        domain?: unknown;
        adminEmail?: unknown;
        adminName?: unknown;
      };

      // Validate required fields.
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('name is required', { details: { code: 'MISSING_NAME' } });
      }
      if (typeof body.slug !== 'string' || !/^[a-z0-9-]+$/.test(body.slug.trim())) {
        throw new ValidationError(
          'slug is required and must be lowercase alphanumeric with hyphens',
          { details: { code: 'INVALID_SLUG' } },
        );
      }
      if (typeof body.adminEmail !== 'string' || !body.adminEmail.includes('@')) {
        throw new ValidationError('adminEmail is required', { details: { code: 'MISSING_ADMIN_EMAIL' } });
      }

      const name = body.name.trim();
      const slug = body.slug.trim();
      const domain = typeof body.domain === 'string' && body.domain.trim().length > 0
        ? body.domain.trim()
        : undefined;
      const adminEmail = body.adminEmail.trim();
      const _adminName = typeof body.adminName === 'string' ? body.adminName.trim() : undefined;

      log.info({ slug, name, adminEmail }, 'createCompany: starting');

      // Step 1: createTenant — status='provisioning'. Slug collision → 409.
      const tenantInput: import('@assessiq/tenancy').CreateTenantInput = { name, slug };
      if (domain !== undefined) tenantInput.domain = domain;
      const { tenantId } = await createTenant(tenantInput, session.userId);

      log.info({ tenantId, slug }, 'createCompany: tenant provisioned');

      // Steps 2–3 may fail; catch and leave tenant 'provisioning' with audit.
      let invitation: { id: string; email: string; role: string; expires_at: Date } | null = null;
      try {
        // Step 2: seedTenantTaxonomy — idempotent; withTenant(newTenantId) inside.
        // Cross-tenant safety: seed function scopes all writes to newTenantId.
        await seedTenantTaxonomy(tenantId);
        log.info({ tenantId }, 'createCompany: taxonomy seeded');

        // Step 3: inviteUser — withTenant(newTenantId) inside invitations.ts.
        // Cross-tenant safety: inviteUser scopes all writes to newTenantId.
        const inviteResult = await inviteUser(tenantId, {
          email: adminEmail,
          role: 'admin',
          invited_by: session.userId,
          // adminName is not part of InviteUserInput but invitations.ts sets
          // name=email as placeholder; Phase 1 admin updates after accept.
        });
        invitation = inviteResult.invitation;

        log.info({ tenantId, adminEmail }, 'createCompany: admin invited');
      } catch (err) {
        // Failure after provisioning: leave 'provisioning', audit, surface error.
        log.warn({ tenantId, err }, 'createCompany: post-provisioning step failed; tenant stays provisioning');

        // Write audit event — use platform tenant context for the super-admin's audit row.
        // The new tenant's audit is not yet writable (it hasn't been activated).
        await audit({
          tenantId: session.tenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'tenant.create_incomplete',
          entityType: 'tenant',
          entityId: tenantId,
          after: {
            slug,
            name,
            status: 'provisioning',
            reason: err instanceof Error ? err.message : String(err),
          },
        });

        // Rethrow so Fastify converts to the appropriate HTTP error.
        throw err;
      }

      // Step 4: flip tenant to 'active' — only reached when steps 2+3 both succeeded.
      await activateTenant(tenantId);
      log.info({ tenantId }, 'createCompany: tenant activated');

      // Step 5: audit tenant.created in the platform tenant context.
      await audit({
        tenantId: session.tenantId,
        actorKind: 'user',
        actorUserId: session.userId,
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenantId,
        after: {
          slug,
          name,
          domain: domain ?? null,
          status: 'active',
          adminEmail,
          invitationId: invitation?.id ?? null,
        },
      });

      // Step 6: provision the default free billing plan (Phase A1, module 19).
      // Ordered AFTER the tenant.created audit on purpose: createCompany is the
      // highest-risk tenant-create surface, so the creation must always be
      // audited even if plan provisioning fails. Runs in its own
      // withTenant(tenantId) tx; idempotent via ON CONFLICT (tenant_id) DO
      // NOTHING so a createCompany retry is safe. A failure here throws (500;
      // operator sees it immediately) but never leaves a planless tenant
      // silent: GET /api/billing/usage fails safe to status 'over' until the
      // idempotent provision is re-run.
      await provisionDefaultPlan(tenantId);
      log.info({ tenantId }, 'createCompany: default free plan provisioned');

      return reply.code(201).send({
        tenantId,
        slug,
        name,
        status: 'active',
        invitation,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/tenants/:tenantId/invitations/resend
  //
  // Re-issue a pending admin invitation for an existing tenant.
  //
  // Gate: super_admin + fresh MFA (15-minute window) — same as POST /companies
  // because this is a privilege-granting action (re-sends a credential-bearing
  // magic link). A stale TOTP session must not be able to blast invite emails.
  //
  // Lookup: earliest-created users row with role='admin' in this tenant
  // (same LATERAL pattern as GET /tenants). Query runs under assessiq_system
  // (BYPASSRLS) to avoid requiring app.current_tenant on the super-admin's
  // session. tenantId is taken from the URL param, never from session.tenantId.
  //
  // Cases:
  //   No admin row          → 404 NO_PENDING_ADMIN
  //   admin.status=active   → 409 ADMIN_ALREADY_ACCEPTED
  //   admin disabled/deleted→ 409 ADMIN_DISABLED_OR_DELETED
  //   admin.status=pending  → inviteUser() → 200 { invitation }
  //
  // Audit: admin.invitation.resent is written AFTER inviteUser() succeeds.
  // inviteUser() also writes user.invited (kind=reinvite) inside its own tx —
  // both records are intentional and serve different query surfaces.
  //
  // Response 200: { invitation: { id, email, role, expires_at } }
  // Response 404: NO_PENDING_ADMIN
  // Response 409: ADMIN_ALREADY_ACCEPTED | ADMIN_DISABLED_OR_DELETED
  // Response 403: not super_admin / MFA too old
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/super/tenants/:tenantId/invitations/resend',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);

      // Resolve the tenant's first admin under assessiq_system (BYPASSRLS).
      // Scoped to tenantId from the URL — never crosses to another tenant.
      const pool = getPool();
      const client = await pool.connect();
      let admin: { id: string; email: string; status: string; deleted_at: Date | null } | null = null;
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE assessiq_system');
        const res = await client.query<{
          id: string;
          email: string;
          status: string;
          deleted_at: Date | null;
        }>(
          `SELECT u.id, u.email, u.status, u.deleted_at
           FROM users u
           WHERE u.tenant_id = $1 AND u.role = 'admin'
           ORDER BY u.created_at ASC
           LIMIT 1`,
          [tenantId],
        );
        await client.query('COMMIT');
        admin = res.rows[0] ?? null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      if (admin === null) {
        throw new NotFoundError('This tenant has no admin user to resend an invitation to.', {
          details: { code: 'NO_PENDING_ADMIN' },
        });
      }

      if (admin.status === 'active') {
        throw new ConflictError('This admin has already accepted their invitation.', {
          details: { code: 'ADMIN_ALREADY_ACCEPTED' },
        });
      }

      if (admin.status === 'disabled' || admin.deleted_at !== null) {
        throw new ConflictError('This admin is disabled or deleted; cannot resend invite.', {
          details: { code: 'ADMIN_DISABLED_OR_DELETED' },
        });
      }

      // admin.status === 'pending': re-issue invitation via the canonical path.
      // inviteUser deletes old invitations, inserts a fresh one, sends email,
      // and writes user.invited (kind=reinvite) in its own auditInTx.
      const inviteResult = await inviteUser(tenantId, {
        email: admin.email,
        role: 'admin',
        invited_by: session.userId,
      });

      if (inviteResult.invitation === null) {
        // Defensive: inviteUser returns null only for active users; we already
        // gated that case above. If this branch is reached, inviteUser semantics
        // have drifted — surface immediately rather than silently succeeding.
        throw new Error('inviteUser returned null invitation for a pending user — contract drift');
      }

      const { invitation } = inviteResult;

      await audit({
        tenantId: session.tenantId,
        actorKind: 'user',
        actorUserId: session.userId,
        action: 'admin.invitation.resent',
        entityType: 'user',
        entityId: admin.id,
        after: {
          tenant_id: tenantId,
          email: admin.email,
          invitation_id: invitation.id,
        },
      });

      log.info({ tenantId, adminId: admin.id, invitationId: invitation.id }, 'resendAdminInvitation: done');

      return reply.code(200).send({ invitation });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/tenants/:tenantId/suspend
  // POST /api/admin/super/tenants/:tenantId/resume
  // POST /api/admin/super/tenants/:tenantId/archive
  // POST /api/admin/super/tenants/:tenantId/unarchive
  //
  // Tenant lifecycle transitions. All gated by superAdminFreshMfa (same gate
  // as POST /companies — these are privilege-affecting actions: suspend and
  // archive revoke all active sessions for the tenant).
  //
  // Body: { reason?: string }  — optional, max 500 chars.
  //
  // Shared handler flow:
  //   1. Parse + validate body.reason.
  //   2. Call the matching service function (suspend/resume/archive/unarchive).
  //   3. For suspend + archive (only when noOp === false): destroyAllForTenant.
  //   4. logLifecycleEvent (only when noOp === false).
  //   5. Return 200 { tenantId, slug, status, previousStatus, noOp, auditId,
  //      sessionsRevoked? }.
  //
  // No assertTenantActive guard — these endpoints manage the state themselves.
  //
  // Response 200: lifecycle result (see body above)
  // Response 400: INVALID_REASON (reason is wrong type or too long)
  // Response 409: INVALID_LIFECYCLE_TRANSITION (wrong-direction call)
  // Response 403: not super_admin / MFA too old
  // ──────────────────────────────────────────────────────────────────────────

  function parseLifecycleBody(body: unknown): { reason: string | undefined } {
    const b = (body ?? {}) as Record<string, unknown>;
    const reason = b['reason'];
    if (reason === undefined || reason === null) {
      return { reason: undefined };
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new ValidationError('reason must be a non-empty string if provided', {
        details: { code: 'INVALID_REASON', received: reason },
      });
    }
    if (reason.length > 500) {
      throw new ValidationError('reason must be 500 characters or fewer', {
        details: { code: 'INVALID_REASON', maxLength: 500, received: reason.length },
      });
    }
    // Strip ASCII control characters (including NUL \x00) — these are valid in
    // jsonb columns but can crash downstream SIEM tooling and corrupt log
    // displays. Reasons are free-form human text; control chars never belong.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(reason)) {
      throw new ValidationError('reason contains disallowed control characters', {
        details: { code: 'INVALID_REASON', cause: 'control_chars' },
      });
    }
    return { reason: reason.trim() };
  }

  app.post(
    '/api/admin/super/tenants/:tenantId/suspend',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      const { reason } = parseLifecycleBody(req.body);

      const result = await suspendTenant(tenantId, session.userId, session.tenantId, reason);

      let sessionsRevoked: { count: number; affectedUsers: string[] } | undefined;
      if (!result.noOp) {
        // Sweep all active sessions for this tenant. Note: on noOp we
        // deliberately SKIP this sweep — the Phase A session-loader's
        // tenantIsActive defense-in-depth catches any orphaned cookie on
        // its next request and clears it then. Re-sweeping on every noOp
        // would be wasted work for an idempotent operator click.
        const revoked = await sessions.destroyAllForTenant(tenantId);
        sessionsRevoked = { count: revoked.revokedCount, affectedUsers: revoked.affectedUsers };
        logLifecycleEvent({
          action: 'tenant.suspended',
          actor: { userId: session.userId, role: session.role },
          target: { entityType: 'tenant', entityId: tenantId },
          before: { status: result.previousStatus },
          after: { status: result.newStatus, reason: reason ?? null },
          sessionsRevoked: { count: revoked.revokedCount, userIds: revoked.affectedUsers },
        });
      }

      log.info({ tenantId, noOp: result.noOp }, 'POST suspend: done');
      return reply.code(200).send({
        tenantId: result.tenantId,
        slug: result.slug,
        status: result.newStatus,
        previousStatus: result.previousStatus,
        noOp: result.noOp,
        auditId: result.auditId,
        ...(sessionsRevoked !== undefined ? { sessionsRevoked } : {}),
      });
    },
  );

  app.post(
    '/api/admin/super/tenants/:tenantId/resume',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      const { reason } = parseLifecycleBody(req.body);

      const result = await resumeTenant(tenantId, session.userId, session.tenantId, reason);

      if (!result.noOp) {
        logLifecycleEvent({
          action: 'tenant.resumed',
          actor: { userId: session.userId, role: session.role },
          target: { entityType: 'tenant', entityId: tenantId },
          before: { status: result.previousStatus },
          after: { status: result.newStatus, reason: reason ?? null },
        });
      }

      log.info({ tenantId, noOp: result.noOp }, 'POST resume: done');
      return reply.code(200).send({
        tenantId: result.tenantId,
        slug: result.slug,
        status: result.newStatus,
        previousStatus: result.previousStatus,
        noOp: result.noOp,
        auditId: result.auditId,
      });
    },
  );

  app.post(
    '/api/admin/super/tenants/:tenantId/archive',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      const { reason } = parseLifecycleBody(req.body);

      const result = await archiveTenant(tenantId, session.userId, session.tenantId, reason);

      let sessionsRevoked: { count: number; affectedUsers: string[] } | undefined;
      if (!result.noOp) {
        // Sweep all active sessions for this tenant. Note: on noOp we
        // deliberately SKIP this sweep — the Phase A session-loader's
        // tenantIsActive defense-in-depth catches any orphaned cookie on
        // its next request and clears it then. Re-sweeping on every noOp
        // would be wasted work for an idempotent operator click.
        const revoked = await sessions.destroyAllForTenant(tenantId);
        sessionsRevoked = { count: revoked.revokedCount, affectedUsers: revoked.affectedUsers };
        logLifecycleEvent({
          action: 'tenant.archived',
          actor: { userId: session.userId, role: session.role },
          target: { entityType: 'tenant', entityId: tenantId },
          before: { status: result.previousStatus },
          after: { status: result.newStatus, reason: reason ?? null },
          sessionsRevoked: { count: revoked.revokedCount, userIds: revoked.affectedUsers },
        });
      }

      log.info({ tenantId, noOp: result.noOp }, 'POST archive: done');
      return reply.code(200).send({
        tenantId: result.tenantId,
        slug: result.slug,
        status: result.newStatus,
        previousStatus: result.previousStatus,
        noOp: result.noOp,
        auditId: result.auditId,
        ...(sessionsRevoked !== undefined ? { sessionsRevoked } : {}),
      });
    },
  );

  app.post(
    '/api/admin/super/tenants/:tenantId/unarchive',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { tenantId } = req.params as { tenantId: string };
      const { reason } = parseLifecycleBody(req.body);

      const result = await unarchiveTenant(tenantId, session.userId, session.tenantId, reason);

      if (!result.noOp) {
        logLifecycleEvent({
          action: 'tenant.unarchived',
          actor: { userId: session.userId, role: session.role },
          target: { entityType: 'tenant', entityId: tenantId },
          before: { status: result.previousStatus },
          after: { status: result.newStatus, reason: reason ?? null },
        });
      }

      log.info({ tenantId, noOp: result.noOp }, 'POST unarchive: done');
      return reply.code(200).send({
        tenantId: result.tenantId,
        slug: result.slug,
        status: result.newStatus,
        previousStatus: result.previousStatus,
        noOp: result.noOp,
        auditId: result.auditId,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants
  //
  // List all tenants (system-role read). Returns slug/name/status/created_at
  // plus the tenant's FIRST admin (email/name/status) — the person invited at
  // company-creation time — so the Platform UI can show who owns each company.
  // The first admin is the earliest-created users row with role='admin' in
  // that tenant (status is 'pending' until they accept the invite, then
  // 'active'). NULL for tenants with no admin user (e.g. the platform tenant,
  // whose operator is role='super_admin', not 'admin'). Read-only; no
  // tenant-internal data beyond the admin contact is exposed.
  //
  // A2 addition: also calls getAllTenantUsage() (from @assessiq/billing) and
  // attaches a 'usage' field to each tenant row for the Platform UI usage column.
  // getAllTenantUsage runs its own withSystemTx internally.
  //
  // Phase B addition:
  //   - ?include_archived=true|1 (default: false) — when false, WHERE t.status
  //     <> 'archived' is applied (existing behaviour). When true, the filter is
  //     dropped and archived tenants appear in the list.
  //   - admin_count + reviewer_count per row: active (non-deleted) user counts
  //     by role, computed via LEFT JOIN LATERAL scalar subqueries in the same
  //     BYPASSRLS transaction. No N+1.
  //
  // The LEFT JOIN LATERAL is correct under SET LOCAL ROLE assessiq_system
  // (BYPASSRLS) — the same cross-tenant system-role pattern this endpoint
  // already uses; no N+1.
  //
  // Gate: super_admin + totpVerified (enforced by superAdminOnly chain).
  //
  // Response 200: { tenants: Array<{ id, slug, name, status, created_at,
  //   admin_email, admin_name, admin_status, admin_invitation_expires_at,
  //   usage, admin_count, reviewer_count }> } (admin_* + usage nullable).
  //
  // `admin_invitation_expires_at` is the expires_at of the FIRST admin's
  // pending invitation row (NULL if the admin already accepted or no
  // invitation exists). Used by the Platform UI to surface expired-invite
  // chips on tenant rows so operators can decide whether to call the
  // resend-invitation endpoint.
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      // Parse ?include_archived — accept '1' or 'true' (case-insensitive).
      const qs = (req.query ?? {}) as Record<string, string | undefined>;
      const includeArchived = qs['include_archived'] === '1' || qs['include_archived']?.toLowerCase() === 'true';

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE assessiq_system');
        const result = await client.query<{
          id: string;
          slug: string;
          name: string;
          status: string;
          created_at: Date;
          admin_user_id: string | null;
          admin_email: string | null;
          admin_name: string | null;
          admin_role: string | null;
          admin_status: string | null;
          admin_invitation_id: string | null;
          admin_invitation_expires_at: Date | null;
          admin_count: number;
          reviewer_count: number;
        }>(
          // admin_user_id / admin_role / admin_invitation_id let the Platform UI
          // target the primary-contact admin precisely for the inline edit modal
          // (PATCH /api/admin/super/users/:userId). The invitation id is the
          // outstanding (unaccepted) invite for that admin, used to re-address a
          // pending invite when its email is corrected.
          `SELECT t.id, t.slug, t.name, t.status, t.created_at,
                  a.id     AS admin_user_id,
                  a.email  AS admin_email,
                  a.name   AS admin_name,
                  a.role   AS admin_role,
                  a.status AS admin_status,
                  i.id         AS admin_invitation_id,
                  i.expires_at AS admin_invitation_expires_at,
                  COALESCE(ac.cnt, 0)::int AS admin_count,
                  COALESCE(rc.cnt, 0)::int AS reviewer_count
           FROM tenants t
           LEFT JOIN LATERAL (
             SELECT u.id, u.email, u.name, u.role, u.status
             FROM users u
             WHERE u.tenant_id = t.id AND u.role = 'admin'
             ORDER BY u.created_at ASC
             LIMIT 1
           ) a ON true
           LEFT JOIN LATERAL (
             SELECT ui.id, ui.expires_at
             FROM user_invitations ui
             WHERE ui.tenant_id = t.id
               AND lower(ui.email) = a.email
               AND ui.accepted_at IS NULL
             ORDER BY ui.created_at DESC
             LIMIT 1
           ) i ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS cnt
             FROM users u
             WHERE u.tenant_id = t.id
               AND u.role = 'admin'
               AND u.status = 'active'
               AND u.deleted_at IS NULL
           ) ac ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS cnt
             FROM users u
             WHERE u.tenant_id = t.id
               AND u.role = 'reviewer'
               AND u.status = 'active'
               AND u.deleted_at IS NULL
           ) rc ON true
           ${includeArchived ? '' : "WHERE t.status <> 'archived'"}
           ORDER BY t.created_at ASC`,
        );
        await client.query('COMMIT');

        // Attach usage data (A2). getAllTenantUsage uses its own withSystemTx.
        // Best-effort: billing visibility must NEVER break the core Platform
        // tenant list (soft-enforcement philosophy). On any billing error,
        // log and fall back to no usage — rows render with usage:null ("—").
        let usageMap = new Map<string, Awaited<ReturnType<typeof getAllTenantUsage>>[number]>();
        try {
          const usageRows = await getAllTenantUsage();
          usageMap = new Map(usageRows.map((u) => [u.tenant_id, u]));
        } catch (usageErr) {
          log.error({ err: usageErr }, 'admin-super: getAllTenantUsage failed; tenant list returned without usage');
        }

        const tenants = result.rows.map((row) => ({
          ...row,
          usage: usageMap.get(row.id) ?? null,
        }));

        return reply.code(200).send({ tenants });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/billing
  //
  // Full billing detail for a single tenant (super-admin billing drawer).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: TenantBillingDetail
  // Response 404: no billing plan for this tenant (NotFoundError → 404)
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/billing',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const detail = await getTenantBillingDetail(tenantId);
      return reply.code(200).send(detail);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/billing/export.csv
  //
  // CSV export of all billing events for a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: text/csv attachment
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/billing/export.csv',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const csv = await getTenantBillingEventsCsv(tenantId);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="billing-${tenantId}.csv"`,
        )
        .code(200)
        .send(csv);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/super/tenants/:tenantId/plan
  //
  // Update a tenant's billing plan (tier + includedCredits).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: { tenant_id, tier, included_credits, previous, updatedAt, auditId }
  // Response 400: validation error (INVALID_TIER / INTERNAL_REQUIRES_NULL_CREDITS /
  //               FINITE_TIER_REQUIRES_CREDITS / INVALID_CREDITS)
  // Response 403: not super_admin
  // Response 404: tenant has no billing plan row
  //
  // Audit guarantee: the UPDATE and the audit_log INSERT are in the same
  // Postgres transaction via updateTenantPlan → auditInTx. If the audit
  // INSERT fails, the UPDATE rolls back. Atomicity is non-negotiable per
  // project CLAUDE.md hard rule (same pattern as ai-generate-mode).
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/tenants/:tenantId/plan',
    // Gate parity: superAdminOnly (session-MFA), intentionally the SAME gate
    // as PATCH .../ai-generate-mode above — both are super-admin per-tenant
    // config mutations (soft, reversible, auditInTx-atomic). Fresh-MFA
    // (superAdminFreshMfa) is reserved for tenant CREATION (POST /companies),
    // not config edits. Do not "upgrade" this to fresh-MFA without changing
    // ai-generate-mode too — they must stay consistent.
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      // Guard against a missing/null PATCH body (empty PATCH → no-op revalidate,
      // never a TypeError 500). Mirrors the ai-generate-mode `body?.` idiom.
      const body = (req.body ?? {}) as { tier?: unknown; includedCredits?: unknown };

      // Light type-guard — domain validation is fully delegated to updateTenantPlan.
      const patch: UpdateTenantPlanPatch = {};
      if (body.tier !== undefined) {
        if (typeof body.tier !== 'string') {
          throw new ValidationError('tier must be a string', {
            details: { code: 'INVALID_TIER', received: body.tier },
          });
        }
        patch.tier = body.tier as PlanTier;
      }
      if ('includedCredits' in body) {
        const ic = body.includedCredits;
        if (ic !== null && ic !== undefined && typeof ic !== 'number') {
          throw new ValidationError('includedCredits must be a number or null', {
            details: { code: 'INVALID_CREDITS', received: ic },
          });
        }
        if (ic !== undefined) {
          patch.includedCredits = ic as number | null;
        }
      }

      const result = await updateTenantPlan(req.session!.userId, tenantId, patch);
      return reply.code(200).send(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/entitlements
  //
  // List all entitlements (active + revoked) for a tenant (super-admin view).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Runs under assessiq_system (BYPASSRLS) via listTenantEntitlements which
  // internally uses withSystemTx — no app.current_tenant required.
  //
  // Response 200: { entitlements: TenantEntitlement[] }
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const entitlements = await listTenantEntitlements(tenantId);
      return reply.code(200).send({ entitlements });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/content-scopes
  //
  // Return the distinct domain labels and pack list for a tenant so the
  // billing drawer can offer a dropdown instead of a free-text scope_id input.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Runs under assessiq_system (BYPASSRLS) via listTenantContentScopes which
  // internally uses withSystemTx — no app.current_tenant required.
  //
  // Response 200: { domains: string[]; packs: Array<{ id, name, domain }> }
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/content-scopes',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const scopes = await listTenantContentScopes(tenantId);
      return reply.code(200).send(scopes);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/tenants/:tenantId/entitlements
  //
  // Grant a scope entitlement to a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Body: { scopeType: 'domain'|'pack', scopeId: string }
  //
  // Idempotent: re-granting an active entitlement updates granted_at/by;
  // re-granting a revoked row reactivates it.
  //
  // Audit guarantee: the INSERT/UPDATE and the audit_log INSERT are in the
  // same Postgres transaction via grantEntitlement → auditInTx. Atomicity
  // matches the A2 updateTenantPlan pattern.
  //
  // Response 200: { tenant_id, scope_type, scope_id, status: 'active', auditId }
  // Response 400: invalid scope (INVALID_SCOPE)
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      const body = (req.body ?? {}) as { scopeType?: unknown; scopeId?: unknown };

      // Light type-guard — domain validation is delegated to grantEntitlement.
      if (typeof body.scopeType !== 'string' || body.scopeType.trim().length === 0) {
        throw new ValidationError('scopeType must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeType },
        });
      }
      if (typeof body.scopeId !== 'string' || body.scopeId.trim().length === 0) {
        throw new ValidationError('scopeId must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeId },
        });
      }

      const result = await grantEntitlement(req.session!.userId, tenantId, {
        scopeType: body.scopeType as EntitlementScopeType,
        scopeId: body.scopeId,
      });
      return reply.code(200).send(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Platform domain management (super-admin) — manage the canonical domain
  // library and propagate create/archive/reactivate across every tenant.
  //
  // PLATFORM-WIDE operations (no :tenantId): they read/write the platform
  // master tenant's domains and mirror changes into every company tenant.
  // Provenance (domains.source, migration 0091) ensures tenant-LOCAL domains
  // are never touched. CATALOG-ONLY: archive does not revoke entitlements.
  // See modules/04-question-bank/src/platform-domains.ts.
  // ──────────────────────────────────────────────────────────────────────────

  // GET /api/admin/super/domains
  // List the platform domain library (all statuses) for the management UI.
  // Gate: super_admin + totpVerified (superAdminOnly) — read-only.
  // Response 200: { domains: PlatformDomainRow[] }
  app.get(
    '/api/admin/super/domains',
    { preHandler: superAdminOnly },
    async (_req, reply) => {
      const domains = await listPlatformDomains();
      return reply.code(200).send({ domains });
    },
  );

  // POST /api/admin/super/domains
  // Create a platform domain and propagate it to every company tenant.
  // Gate: super_admin + fresh MFA (15-min) — platform-affecting cross-tenant write.
  // Body: { name: string, description?: string }
  // Response 201: PlatformDomainRow & { propagatedTenants }
  // Response 400: MISSING_REQUIRED | INVALID_PARAM · 409: DOMAIN_SLUG_EXISTS
  app.post(
    '/api/admin/super/domains',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('name is required and must be a non-empty string', {
          details: { code: 'MISSING_REQUIRED', field: 'name' },
        });
      }
      const result = await createPlatformDomain(req.session!.userId, {
        name: body.name,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      });
      return reply.code(201).send(result);
    },
  );

  // PATCH /api/admin/super/domains/:id
  // Archive (status='archived') or reactivate (status='active') a platform
  // domain; propagates the status to every platform-origin copy across tenants.
  // CATALOG-ONLY: does not revoke entitlements or untag content.
  // Gate: super_admin + fresh MFA (15-min).
  // Body: { status: 'active' | 'archived' }
  // Response 200: PlatformDomainRow & { affectedRows } · 404: DOMAIN_NOT_FOUND
  app.patch(
    '/api/admin/super/domains/:id',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { status?: unknown };
      if (body.status !== 'active' && body.status !== 'archived') {
        throw new ValidationError('status must be "active" or "archived"', {
          details: { code: 'INVALID_STATUS', received: body.status },
        });
      }
      const result = await setPlatformDomainStatus(req.session!.userId, id, body.status);
      return reply.code(200).send(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/users
  //
  // List ALL users in a target tenant (including disabled + soft-deleted when
  // requested) plus any pending invitations, for the super-admin Users page.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Query params:
  //   ?include_disabled=true  — include status='disabled' users (default: false)
  //   ?include_deleted=true   — include deleted_at IS NOT NULL users (default: false)
  //
  // Runs under assessiq_system (BYPASSRLS) to read across tenant boundaries.
  //
  // Response 200: { users: [...], pending_invitations: [...] }
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/users',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const qs = (req.query ?? {}) as Record<string, string | undefined>;
      const includeDisabled =
        qs['include_disabled'] === '1' || qs['include_disabled']?.toLowerCase() === 'true';
      const includeDeleted =
        qs['include_deleted'] === '1' || qs['include_deleted']?.toLowerCase() === 'true';

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE assessiq_system');

        // Build user WHERE conditions.
        const userConditions: string[] = ['u.tenant_id = $1'];
        if (!includeDeleted) {
          userConditions.push('u.deleted_at IS NULL');
        }
        if (!includeDisabled) {
          userConditions.push("u.status <> 'disabled'");
        }
        // DPDP erasure: always hide erased candidates from this listing surface.
        // This is an action surface (super-admin managing tenant users), so erased
        // candidates must not appear per the HIDE display rule.
        userConditions.push('u.erased_at IS NULL');
        const userWhere = userConditions.join(' AND ');

        const usersResult = await client.query<{
          id: string;
          email: string;
          name: string;
          role: string;
          status: string;
          deleted_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT u.id, u.email, u.name, u.role, u.status,
                  u.deleted_at, u.created_at, u.updated_at
           FROM users u
           WHERE ${userWhere}
           ORDER BY u.created_at DESC, u.id DESC`,
          [tenantId],
        );

        const invitationsResult = await client.query<{
          id: string;
          email: string;
          role: string;
          expires_at: Date;
          created_at: Date;
        }>(
          `SELECT ui.id, ui.email, ui.role, ui.expires_at, ui.created_at
           FROM user_invitations ui
           WHERE ui.tenant_id = $1 AND ui.accepted_at IS NULL
           ORDER BY ui.created_at DESC`,
          [tenantId],
        );

        await client.query('COMMIT');

        return reply.code(200).send({
          users: usersResult.rows,
          pending_invitations: invitationsResult.rows,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Super-admin user lifecycle overrides
  //
  // POST   /api/admin/super/users/:userId/disable
  // POST   /api/admin/super/users/:userId/reenable
  // DELETE /api/admin/super/users/:userId
  // POST   /api/admin/super/users/:userId/restore
  // DELETE /api/admin/super/users/invitations/:invitationId
  //
  // Gate: superAdminFreshMfa (MFA within 15 min).
  // Body: { reason?: string, confirm_last_admin?: boolean }
  //
  // Cross-tenant design: look up the target user's tenantId via system-role
  // query, then operate under withTenant(targetTenantId). NEVER use
  // session.tenantId (the platform tenant) for the data operation.
  //
  // Last-admin override: when the action would normally fail LAST_ADMIN,
  // AND confirm_last_admin === true AND reason is non-empty, the assertion is
  // bypassed. The audit row carries is_override=true; logLifecycleEvent fires
  // at WARN level via isOverride=true.
  //
  // Self-action: super_admins don't live in any tenant; the self-protection
  // guard that applies to tenant admins does NOT apply here.
  //
  // Option (b) from spec: super-admin handlers inline their own
  // withTenant/SQL/auditInTx flow to keep the override path isolated from the
  // shared service functions (which always enforce assertNotLastAdmin).
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the target user's tenantId via system-role (BYPASSRLS) query.
   * Returns null when the user does not exist.
   */
  async function resolveUserTenant(userId: string): Promise<{
    tenantId: string;
    email: string;
    name: string;
    role: string;
    status: string;
    deleted_at: Date | null;
  } | null> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE assessiq_system');
      const res = await client.query<{
        tenant_id: string;
        email: string;
        name: string;
        role: string;
        status: string;
        deleted_at: Date | null;
      }>(
        `SELECT tenant_id, email, name, role, status, deleted_at
         FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      await client.query('COMMIT');
      const row = res.rows[0];
      if (row === undefined) return null;
      return {
        tenantId: row.tenant_id,
        email: row.email,
        name: row.name,
        role: row.role,
        status: row.status,
        deleted_at: row.deleted_at,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Parse super-admin lifecycle body: reason + confirm_last_admin override flag.
   */
  function parseSuperLifecycleBody(body: unknown): {
    reason: string | undefined;
    confirm_last_admin: boolean;
  } {
    const b = (body ?? {}) as Record<string, unknown>;
    // Reuse the existing parseLifecycleBody closure (defined above in this scope).
    const { reason } = parseLifecycleBody(b);
    const confirm_last_admin = b['confirm_last_admin'] === true;
    return { reason, confirm_last_admin };
  }

  // POST /api/admin/super/users/:userId/disable
  app.post(
    '/api/admin/super/users/:userId/disable',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason, confirm_last_admin } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      const targetTenantId = target.tenantId;

      // Inline disable with optional last-admin bypass.
      const updated = await withTenant(targetTenantId, async (client) => {
        // Check if this would violate last-admin invariant.
        if (target.role === 'admin' && target.status === 'active' && target.deleted_at === null) {
          const countRes = await client.query<{ count: string }>(
            `SELECT count(*) FROM users
              WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
                AND id <> $1`,
            [userId],
          );
          const otherAdmins = parseInt(countRes.rows[0]?.count ?? '0', 10);
          if (otherAdmins === 0) {
            if (!confirm_last_admin || !reason) {
              throw new ConflictError(
                'This is the last active admin. Pass confirm_last_admin=true and a non-empty reason to override.',
                { details: { code: 'LAST_ADMIN' } },
              );
            }
          }
        }

        // Apply status change.
        const res = await client.query<{
          id: string; status: string;
        }>(
          `UPDATE users SET status = 'disabled', updated_at = now()
           WHERE id = $1
           RETURNING id, status`,
          [userId],
        );
        const row = res.rows[0];
        if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

        const isOverride = confirm_last_admin && !!reason;
        await auditInTx(client, {
          tenantId: targetTenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'user.disabled',
          entityType: 'user',
          entityId: userId,
          before: { status: target.status },
          after: {
            status: 'disabled',
            reason: reason ?? null,
            ...(isOverride ? { is_override: true } : {}),
          },
        });

        return { id: row.id, status: row.status, isOverride };
      });

      // Sweep Redis sessions after commit.
      await sweepUserSessions(userId);

      logLifecycleEvent({
        action: 'user.disabled',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { status: target.status },
        after: { status: 'disabled', reason: reason ?? null },
        isOverride: updated.isOverride,
      });

      return reply.code(200).send({
        userId: updated.id,
        status: updated.status,
        previousStatus: target.status,
        isOverride: updated.isOverride,
      });
    },
  );

  // POST /api/admin/super/users/:userId/reenable
  app.post(
    '/api/admin/super/users/:userId/reenable',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      const targetTenantId = target.tenantId;

      const updated = await withTenant(targetTenantId, async (client) => {
        const res = await client.query<{ id: string; status: string }>(
          `UPDATE users SET status = 'active', updated_at = now()
           WHERE id = $1
           RETURNING id, status`,
          [userId],
        );
        const row = res.rows[0];
        if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

        await auditInTx(client, {
          tenantId: targetTenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'user.reenabled',
          entityType: 'user',
          entityId: userId,
          before: { status: target.status },
          after: { status: 'active', reason: reason ?? null },
        });

        return row;
      });

      logLifecycleEvent({
        action: 'user.reenabled',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { status: target.status },
        after: { status: 'active', reason: reason ?? null },
      });

      return reply.code(200).send({
        userId: updated.id,
        status: updated.status,
        previousStatus: target.status,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/super/users/:userId
  //
  // Super-admin edit of a tenant user's profile (name / role / email). Surfaced
  // from the Platform page "Manage ▸ Edit admin" inline modal; targets the
  // primary-contact admin shown on the row (any tenant user, by id).
  //
  // Gate: superAdminFreshMfa (TOTP within 15 min) — same as create-company and
  // the lifecycle overrides. Stale TOTP → 401 "fresh totp"; the UI shows the
  // MFA step-up sub-form and retries.
  //
  // Body: { name?, role?, email?, confirmEmailIdentityChange?, reason? }
  //   - role ∈ {admin, reviewer}. candidate / super_admin are rejected — the
  //     users CHECK blocks super_admin and candidate is a different surface.
  //   - email IS the login identity. Google SSO resolves a user purely by
  //     Google-verified email (modules/01-auth/src/google-sso.ts — "the SOLE
  //     cross-tenant identity key"). Changing an ACCEPTED (status='active')
  //     admin's email therefore TRANSFERS ACCOUNT OWNERSHIP: the admin must
  //     control a Google account at the new address, and is signed out. We
  //     require confirmEmailIdentityChange=true for that case, sweep the user's
  //     sessions, and drop the now-stale Google oauth_identities link.
  //   - A PENDING admin's email is safe to correct (they never logged in): we
  //     retire the old-address invitation and re-issue a fresh one to the new
  //     address post-commit; the old link stops working.
  //
  // Cross-tenant design: resolve the target's tenantId via system-role
  // (resolveUserTenant), then operate under withTenant(targetTenantId) — NEVER
  // session.tenantId (the platform tenant).
  //
  // Last-admin guard: demoting the tenant's only active admin to reviewer is
  // blocked (409 LAST_ADMIN). No override here by design — use the Manage-users
  // drill-down for last-admin operations.
  //
  // 200: { userId, email, name, role, previousEmail, emailChanged, status,
  //        sessionsSwept, reinvited, auditId }
  // 400: INVALID_ROLE / INVALID_EMAIL / MISSING_NAME / NAME_TOO_LONG / NO_CHANGES
  //      / CANNOT_EDIT_SUPER_ADMIN
  // 404: user not found
  // 409: USER_DELETED / EMAIL_IDENTITY_CONFIRM_REQUIRED / USER_EMAIL_EXISTS / LAST_ADMIN
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/users/:userId',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const body = (req.body ?? {}) as {
        name?: unknown;
        role?: unknown;
        email?: unknown;
        confirmEmailIdentityChange?: unknown;
        reason?: unknown;
      };

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      if (target.role === 'super_admin') {
        throw new ValidationError('Super-admin accounts cannot be edited here.', {
          details: { code: 'CANNOT_EDIT_SUPER_ADMIN' },
        });
      }
      if (target.deleted_at !== null) {
        throw new ConflictError('This user has been deleted. Restore it before editing.', {
          details: { code: 'USER_DELETED' },
        });
      }
      const targetTenantId = target.tenantId;
      const reason =
        typeof body.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim()
          : undefined;

      // ---- Validate + normalize requested changes ----
      let newName: string | undefined;
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
          throw new ValidationError('Name must not be empty.', { details: { code: 'MISSING_NAME' } });
        }
        if (body.name.length > 200) {
          throw new ValidationError('Name must not exceed 200 characters.', { details: { code: 'NAME_TOO_LONG' } });
        }
        newName = body.name.trim();
      }

      let newRole: 'admin' | 'reviewer' | undefined;
      if (body.role !== undefined) {
        if (body.role !== 'admin' && body.role !== 'reviewer') {
          throw new ValidationError("Role must be 'admin' or 'reviewer'.", {
            details: { code: 'INVALID_ROLE', role: body.role },
          });
        }
        newRole = body.role;
      }

      // normalizeEmail parity with 01-auth/03-users: trim + lowercase only.
      let newEmail: string | undefined;
      if (body.email !== undefined) {
        if (typeof body.email !== 'string') {
          throw new ValidationError('Invalid email address.', { details: { code: 'INVALID_EMAIL' } });
        }
        const normalized = body.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
          throw new ValidationError(`Invalid email address: '${body.email}'`, {
            details: { code: 'INVALID_EMAIL' },
          });
        }
        newEmail = normalized;
      }

      const currentEmail = target.email.toLowerCase();
      const emailChanged = newEmail !== undefined && newEmail !== currentEmail;
      const roleChanged = newRole !== undefined && newRole !== target.role;
      const nameChanged = newName !== undefined && newName !== target.name;

      if (!emailChanged && !roleChanged && !nameChanged) {
        throw new ValidationError('No changes requested.', { details: { code: 'NO_CHANGES' } });
      }

      // Identity-transfer confirmation for any account that already exists —
      // active OR disabled. Both have (or will have, on re-enable) the new email
      // as their login identity; only a never-logged-in 'pending' invite is safe
      // to re-address freely. (Sonnet review F5.)
      if (emailChanged && target.status !== 'pending' && body.confirmEmailIdentityChange !== true) {
        throw new ConflictError(
          "Changing this account's email transfers its login identity. Re-send with confirmEmailIdentityChange=true to proceed.",
          { details: { code: 'EMAIL_IDENTITY_CONFIRM_REQUIRED' } },
        );
      }

      const effectiveRole = newRole ?? (target.role as 'admin' | 'reviewer');
      const wasPending = target.status === 'pending';

      // ---- Transaction: apply name/role/email + audit; clean up oauth link ----
      let auditId: string | null = null;
      try {
        await withTenant(targetTenantId, async (client) => {
          // Last-admin guard: block demoting the only active admin to reviewer.
          if (
            roleChanged &&
            target.role === 'admin' &&
            newRole === 'reviewer' &&
            target.status === 'active' &&
            target.deleted_at === null
          ) {
            const countRes = await client.query<{ count: string }>(
              `SELECT count(*) FROM users
                WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
                  AND id <> $1`,
              [userId],
            );
            if (parseInt(countRes.rows[0]?.count ?? '0', 10) === 0) {
              throw new ConflictError(
                "This is the tenant's last active admin and cannot be demoted. Add another admin first, or use the Manage-users page.",
                { details: { code: 'LAST_ADMIN' } },
              );
            }
          }

          const sets: string[] = [];
          const vals: unknown[] = [];
          let p = 1;
          if (newName !== undefined) { sets.push(`name = $${p++}`); vals.push(newName); }
          if (newRole !== undefined) { sets.push(`role = $${p++}`); vals.push(newRole); }
          if (newEmail !== undefined) { sets.push(`email = $${p++}`); vals.push(newEmail); }
          sets.push('updated_at = now()');
          vals.push(userId);
          await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${p}`, vals);

          if (emailChanged) {
            // Drop the stale Google identity link. Login resolves by email, so the
            // old (provider,subject)→user_id row is inert, but removing it avoids a
            // dangling mapping and lets the new address re-link JIT on next login.
            await client.query(
              `DELETE FROM oauth_identities WHERE user_id = $1 AND provider = 'google'`,
              [userId],
            );
            // Pending admin: retire the old-address invitation now; a fresh invite
            // to the new address is issued post-commit via inviteUser.
            if (wasPending) {
              await client.query(
                `DELETE FROM user_invitations WHERE lower(email) = $1 AND accepted_at IS NULL`,
                [currentEmail],
              );
            }
          }

          const changedFields = [
            ...(nameChanged ? ['name'] : []),
            ...(roleChanged ? ['role'] : []),
            ...(emailChanged ? ['email'] : []),
          ];
          const auditRes: unknown = await auditInTx(client, {
            tenantId: targetTenantId,
            actorKind: 'user',
            actorUserId: session.userId,
            action: 'user.updated',
            entityType: 'user',
            entityId: userId,
            before: {
              name: target.name,
              role: target.role,
              ...(emailChanged ? { email: target.email } : {}),
            },
            after: {
              ...(nameChanged ? { name: newName } : {}),
              ...(roleChanged ? { role: newRole } : {}),
              ...(emailChanged ? { email: newEmail } : {}),
              changed_fields: changedFields,
              kind: 'super_profile_edit',
              ...(emailChanged ? { email_identity_transfer: target.status === 'active' } : {}),
              reason: reason ?? null,
            },
          });
          if (auditRes !== null && typeof auditRes === 'object' && 'id' in auditRes) {
            auditId = String((auditRes as { id: unknown }).id);
          }
        });
      } catch (err) {
        // UNIQUE (tenant_id, email) collision → 409 (mirror createUser).
        if (
          err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === '23505'
        ) {
          throw new ConflictError('A user with this email already exists in this tenant.', {
            details: { code: 'USER_EMAIL_EXISTS', email: newEmail },
          });
        }
        throw err;
      }

      // ---- Post-commit side effects ----
      let sessionsSwept = false;
      let reinvited = false;
      if (emailChanged) {
        if (wasPending) {
          // Re-issue the invitation to the corrected address. inviteUser finds the
          // (now-renamed) pending user and replaces its invitation + resends email.
          // The rename has already committed; if the send fails we DON'T 500 (that
          // would imply the whole edit failed). We return 200 with reinvited:false —
          // the row stays pending and the operator recovers via "Resend invite".
          // (Sonnet review F2.)
          try {
            await inviteUser(targetTenantId, {
              email: newEmail!,
              role: effectiveRole,
              invited_by: session.userId,
            });
            reinvited = true;
          } catch (inviteErr) {
            log.error(
              { err: inviteErr, userId, tenantId: targetTenantId },
              'edit-admin: post-rename re-invite failed; email saved, recoverable via Resend invite',
            );
            reinvited = false;
          }
        } else {
          // ACCEPTED admin: force re-login under the new identity.
          await sweepUserSessions(userId);
          sessionsSwept = true;
        }
      } else if (roleChanged) {
        // Drop stale role claims from any live session.
        await sweepUserSessions(userId);
        sessionsSwept = true;
      }

      logLifecycleEvent({
        action: 'user.updated',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { name: target.name, role: target.role, email: target.email, status: target.status },
        after: {
          ...(nameChanged ? { name: newName } : {}),
          ...(roleChanged ? { role: newRole } : {}),
          ...(emailChanged ? { email: newEmail } : {}),
          reason: reason ?? null,
        },
      });

      return reply.code(200).send({
        userId,
        email: newEmail ?? target.email,
        name: newName ?? target.name,
        role: effectiveRole,
        previousEmail: target.email,
        emailChanged,
        status: target.status,
        sessionsSwept,
        reinvited,
        auditId,
      });
    },
  );

  // DELETE /api/admin/super/users/invitations/:invitationId
  // NOTE: static "invitations" segment registered BEFORE /:userId DELETE.
  app.delete(
    '/api/admin/super/users/invitations/:invitationId',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { invitationId } = req.params as { invitationId: string };
      const { reason } = parseSuperLifecycleBody(req.body);

      // Resolve the invitation's tenantId via system-role lookup.
      const pool = getPool();
      const sysClient = await pool.connect();
      let targetTenantId: string | null = null;
      try {
        await sysClient.query('BEGIN');
        await sysClient.query('SET LOCAL ROLE assessiq_system');
        const res = await sysClient.query<{ tenant_id: string; accepted_at: Date | null }>(
          `SELECT tenant_id, accepted_at FROM user_invitations WHERE id = $1 LIMIT 1`,
          [invitationId],
        );
        await sysClient.query('COMMIT');
        const row = res.rows[0];
        if (row === undefined) {
          throw new NotFoundError(`Invitation not found: ${invitationId}`, {
            details: { code: 'INVITATION_NOT_FOUND' },
          });
        }
        if (row.accepted_at !== null) {
          throw new ConflictError(
            'This invitation has already been accepted and cannot be cancelled.',
            { details: { code: 'INVITATION_ALREADY_ACCEPTED' } },
          );
        }
        targetTenantId = row.tenant_id;
      } catch (err) {
        await sysClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        sysClient.release();
      }

      // Delegate to the cancelInvitation service (runs withTenant(targetTenantId)).
      const result = await cancelInvitation(
        targetTenantId,
        invitationId,
        session.userId,
        reason,
      );

      logLifecycleEvent({
        action: 'user.invitation_cancelled',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'invitation', entityId: invitationId },
        after: {
          email: result.email,
          reason: reason ?? null,
          cascaded_pending_user: result.cascadedPendingUser,
          cancelled_user_id: result.userId,
          tenant_id: targetTenantId,
        },
      });

      return reply.code(200).send({
        invitationId,
        email: result.email,
        cascadedPendingUser: result.cascadedPendingUser,
        cancelledUserId: result.userId,
      });
    },
  );

  // DELETE /api/admin/super/users/:userId — super-admin soft-delete
  app.delete(
    '/api/admin/super/users/:userId',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason, confirm_last_admin } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      const targetTenantId = target.tenantId;

      await withTenant(targetTenantId, async (client) => {
        // Last-admin invariant check (with optional override).
        if (target.role === 'admin' && target.status === 'active' && target.deleted_at === null) {
          const countRes = await client.query<{ count: string }>(
            `SELECT count(*) FROM users
              WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL
                AND id <> $1`,
            [userId],
          );
          const otherAdmins = parseInt(countRes.rows[0]?.count ?? '0', 10);
          if (otherAdmins === 0) {
            if (!confirm_last_admin || !reason) {
              throw new ConflictError(
                'This is the last active admin. Pass confirm_last_admin=true and a non-empty reason to override.',
                { details: { code: 'LAST_ADMIN' } },
              );
            }
          }
        }

        await client.query(
          `UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );

        // Cascade: delete pending invitations for this email.
        await client.query(
          `DELETE FROM user_invitations WHERE lower(email) = $1 AND accepted_at IS NULL`,
          [target.email.toLowerCase()],
        );

        const isOverride = confirm_last_admin && !!reason;
        await auditInTx(client, {
          tenantId: targetTenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'user.soft_deleted',
          entityType: 'user',
          entityId: userId,
          before: { status: target.status, deleted_at: null },
          after: {
            deleted: true,
            reason: reason ?? null,
            ...(isOverride ? { is_override: true } : {}),
          },
        });
      });

      // Sweep Redis sessions after commit.
      await sweepUserSessions(userId);

      const isOverride = confirm_last_admin && !!reason;
      logLifecycleEvent({
        action: 'user.soft_deleted',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        after: { deleted: true, reason: reason ?? null },
        isOverride,
      });

      return reply.code(200).send({ userId, deleted: true, isOverride });
    },
  );

  // POST /api/admin/super/users/:userId/restore
  app.post(
    '/api/admin/super/users/:userId/restore',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }
      const targetTenantId = target.tenantId;

      const restored = await withTenant(targetTenantId, async (client) => {
        const res = await client.query<{ id: string; status: string; deleted_at: Date | null }>(
          `UPDATE users SET deleted_at = NULL, updated_at = now()
           WHERE id = $1
           RETURNING id, status, deleted_at`,
          [userId],
        );
        const row = res.rows[0];
        if (row === undefined) throw new NotFoundError(`User not found: ${userId}`);

        await auditInTx(client, {
          tenantId: targetTenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'user.restored',
          entityType: 'user',
          entityId: userId,
          before: { deleted_at: 'non-null', status: target.status },
          after: { deleted_at: null, status: row.status, reason: reason ?? null },
        });

        return row;
      });

      logLifecycleEvent({
        action: 'user.restored',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { deleted_at: 'non-null' },
        after: { deleted_at: null, reason: reason ?? null },
      });

      return reply.code(200).send({
        userId: restored.id,
        status: restored.status,
        previousDeletedAt: target.deleted_at,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/admin/super/tenants/:tenantId/entitlements
  //
  // Revoke an active scope entitlement from a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Decision: DELETE-with-body. There is no direct precedent for DELETE-with-
  // body in this codebase (other DELETEs use path params for identity, e.g.
  // DELETE /api/admin/embed-origins uses body). Since entitlements are
  // identified by (tenant_id, scope_type, scope_id) — a composite key, not a
  // single UUID — encoding all three in the URL path would produce an unwieldy
  // URL and/or require URL-encoding of arbitrary scope_id strings. Body is the
  // more ergonomic approach. Fastify supports DELETE-with-body natively (no
  // configuration needed). Query params are an acceptable alternative but body
  // is more consistent with the POST (grant) shape above and avoids encoding
  // issues with scope_id values that contain slashes or special characters.
  //
  // Body: { scopeType: 'domain'|'pack', scopeId: string }
  //
  // Response 200: { tenant_id, scope_type, scope_id, status: 'revoked', auditId }
  // Response 400: invalid scope (INVALID_SCOPE)
  // Response 403: not super_admin
  // Response 404: ENTITLEMENT_NOT_FOUND — nothing active to revoke
  // ──────────────────────────────────────────────────────────────────────────
  app.delete(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      const body = (req.body ?? {}) as { scopeType?: unknown; scopeId?: unknown };

      // Light type-guard — domain validation is delegated to revokeEntitlement.
      if (typeof body.scopeType !== 'string' || body.scopeType.trim().length === 0) {
        throw new ValidationError('scopeType must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeType },
        });
      }
      if (typeof body.scopeId !== 'string' || body.scopeId.trim().length === 0) {
        throw new ValidationError('scopeId must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeId },
        });
      }

      const result = await revokeEntitlement(req.session!.userId, tenantId, {
        scopeType: body.scopeType as EntitlementScopeType,
        scopeId: body.scopeId,
      });
      return reply.code(200).send({ revoked: true, ...result });
    },
  );
}
