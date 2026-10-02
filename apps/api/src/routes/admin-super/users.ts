// AssessIQ — apps/api/src/routes/admin-super/users.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { ValidationError, NotFoundError, ConflictError } from '@assessiq/core';
import { getPool, withTenant } from '@assessiq/tenancy';
import { logLifecycleEvent } from '@assessiq/auth';
import { inviteUser, cancelInvitation, sweepUserSessions } from '@assessiq/users';
import { auditInTx } from '@assessiq/audit-log';
import { parseLifecycleBody, log, superAdminOnly, superAdminFreshMfa } from './_shared.js';

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

}
