// AssessIQ — apps/api/src/routes/admin-super/users.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { ValidationError, NotFoundError, ConflictError } from '@assessiq/core';
import { logLifecycleEvent } from '@assessiq/auth';
import {
  inviteUser,
  cancelInvitation,
  sweepUserSessions,
  listTenantUsersForSuperAdmin,
  resolveUserTenant,
  resolvePendingInvitationTenant,
  disableUserAsSuperAdmin,
  reenableUserAsSuperAdmin,
  softDeleteUserAsSuperAdmin,
  restoreUserAsSuperAdmin,
  updateUserProfileAsSuperAdmin,
} from '@assessiq/users';
import { parseLifecycleBody, log, superAdminOnly, superAdminFreshMfa } from './_shared.js';
import {
  parseBody,
  parseParams,
  parseQuery,
  tenantIdParams,
  userIdParams,
  invitationIdParams,
  lifecycleBody,
} from '../_validate.js';
import { editUserBody, listTenantUsersQuery } from '../_schemas.js';


export async function registerAdminSuperUserRoutes(app: FastifyInstance): Promise<void> {
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
      const { tenantId } = parseParams(tenantIdParams, req.params);
      const qs = parseQuery(listTenantUsersQuery, req.query) as Record<string, string | undefined>;
      const includeDisabled =
        qs['include_disabled'] === '1' || qs['include_disabled']?.toLowerCase() === 'true';
      const includeDeleted =
        qs['include_deleted'] === '1' || qs['include_deleted']?.toLowerCase() === 'true';

      const { users, pending_invitations } = await listTenantUsersForSuperAdmin(tenantId, {
        includeDisabled,
        includeDeleted,
      });

      return reply.code(200).send({ users, pending_invitations });
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
   * Parse super-admin lifecycle body: reason + confirm_last_admin override flag.
   */
  function parseSuperLifecycleBody(body: unknown): {
    reason: string | undefined;
    confirm_last_admin: boolean;
  } {
    const b = parseBody(lifecycleBody, body) as Record<string, unknown>;
    // Reason content is validated by parseLifecycleBody (INVALID_REASON).
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
      const { userId } = parseParams(userIdParams, req.params);
      const { reason, confirm_last_admin } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      // Disable with optional last-admin bypass (service: withTenant + auditInTx).
      const updated = await disableUserAsSuperAdmin({
        target,
        userId,
        actorUserId: session.userId,
        reason,
        confirmLastAdmin: confirm_last_admin,
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
      const { userId } = parseParams(userIdParams, req.params);
      const { reason } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      const updated = await reenableUserAsSuperAdmin({
        target,
        userId,
        actorUserId: session.userId,
        reason,
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
  //   - role ∈ {admin} (reviewer role removed 2026-10-02). candidate / super_admin are rejected — the
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
  // 200: { userId, email, name, role, previousEmail, emailChanged, status,
  //        sessionsSwept, reinvited, auditId }
  // 400: INVALID_ROLE (bad body role, or target is not an admin) / INVALID_EMAIL / MISSING_NAME / NAME_TOO_LONG / NO_CHANGES
  //      / CANNOT_EDIT_SUPER_ADMIN
  // 404: user not found
  // 409: USER_DELETED / EMAIL_IDENTITY_CONFIRM_REQUIRED / USER_EMAIL_EXISTS
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/users/:userId',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = parseParams(userIdParams, req.params);
      const body = parseBody(editUserBody, req.body, {
        code: { name: 'MISSING_NAME', role: 'INVALID_ROLE', email: 'INVALID_EMAIL' },
      });

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
      if (target.role !== 'admin') {
        throw new ValidationError('Only admin accounts can be edited here.', {
          details: { code: 'INVALID_ROLE', role: target.role },
        });
      }
      const targetTenantId = target.tenantId;
      const reason =
        typeof body.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim()
          : undefined;

      // ---- Validate + normalize requested changes ----
      const newName: string | undefined = body.name?.trim();
      const newRole: 'admin' | undefined = body.role;

      // normalizeEmail parity with 01-auth/03-users: trim + lowercase only.
      let newEmail: string | undefined;
      if (body.email !== undefined) {
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

      const effectiveRole = newRole ?? target.role;
      const wasPending = target.status === 'pending';

      // ---- Transaction: apply name/role/email + audit; clean up oauth link ----
      // (service: withTenant + auditInTx; maps pg 23505 to USER_EMAIL_EXISTS)
      const auditId = await updateUserProfileAsSuperAdmin({
        target,
        userId,
        actorUserId: session.userId,
        reason,
        newName,
        newRole,
        newEmail,
        nameChanged,
        roleChanged,
        emailChanged,
        wasPending,
        currentEmail,
      });

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
      const { invitationId } = parseParams(invitationIdParams, req.params);
      const { reason } = parseSuperLifecycleBody(req.body);

      // Resolve the invitation's tenantId via system-role lookup.
      const targetTenantId = await resolvePendingInvitationTenant(invitationId);

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
      const { userId } = parseParams(userIdParams, req.params);
      const { reason, confirm_last_admin } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      await softDeleteUserAsSuperAdmin({
        target,
        userId,
        actorUserId: session.userId,
        reason,
        confirmLastAdmin: confirm_last_admin,
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
      const { userId } = parseParams(userIdParams, req.params);
      const { reason } = parseSuperLifecycleBody(req.body);

      const target = await resolveUserTenant(userId);
      if (target === null) {
        throw new NotFoundError(`User not found: ${userId}`);
      }

      const restored = await restoreUserAsSuperAdmin({
        target,
        userId,
        actorUserId: session.userId,
        reason,
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

}
