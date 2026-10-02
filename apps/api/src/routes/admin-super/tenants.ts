// AssessIQ — apps/api/src/routes/admin-super/tenants.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { ValidationError, NotFoundError, ConflictError } from '@assessiq/core';
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
import { inviteUser } from '@assessiq/users';
import { audit, auditInTx } from '@assessiq/audit-log';
import { provisionDefaultPlan, getAllTenantUsage } from '@assessiq/billing';
import { seedTenantTaxonomy } from '@assessiq/question-bank';
import { parseLifecycleBody, log, superAdminOnly, superAdminFreshMfa } from './_shared.js';

export async function registerAdminSuperTenantRoutes(app: FastifyInstance): Promise<void> {
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

}
