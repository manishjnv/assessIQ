import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  softDelete,
  restore,
  cancelInvitation,
} from '@assessiq/users';
import { logLifecycleEvent } from '@assessiq/auth';
import { audit } from '@assessiq/audit-log';
import { eraseCandidatePii, exportCandidateData } from '@assessiq/data-rights';
import { authChain } from '../middleware/auth-chain.js';

// ---------------------------------------------------------------------------
// Shared body parser for lifecycle reason field (mirrors admin-super.ts).
// Strips NUL + ASCII control chars that are valid in jsonb but crash SIEM tools.
// ---------------------------------------------------------------------------

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
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(reason)) {
    throw new ValidationError('reason contains disallowed control characters', {
      details: { code: 'INVALID_REASON', cause: 'control_chars' },
    });
  }
  return { reason: reason.trim() };
}

// Admin gate: full @assessiq/auth chain (rateLimit → sessionLoader →
// apiKeyAuth → syncCtx → requireAuth({roles:['admin']}) → extendOnPass).
// Replaces the pre-W4 dev-auth shim that read x-aiq-test-tenant headers.
const adminOnly = authChain({ roles: ['admin'] });

export async function registerAdminUserRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/users
  app.get(
    '/api/admin/users',
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const q = req.query as Record<string, string | undefined>;

      const pageRaw = q['page'] ?? '1';
      const pageSizeRaw = q['pageSize'] ?? '20';
      const page = parseInt(pageRaw, 10);
      const pageSize = parseInt(pageSizeRaw, 10);

      if (isNaN(page) || page < 1) {
        throw new ValidationError('page must be a positive integer', {
          details: { code: 'INVALID_PARAM', param: 'page' },
        });
      }
      if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
        throw new ValidationError('pageSize must be between 1 and 100', {
          details: { code: 'INVALID_PARAM', param: 'pageSize' },
        });
      }

      const role = q['role'] as 'admin' | 'reviewer' | 'candidate' | undefined;
      const status = q['status'] as 'active' | 'disabled' | 'pending' | undefined;
      const search = q['search'];
      const includeDeleted = q['includeDeleted'] === 'true';

      // Conditional spread to satisfy exactOptionalPropertyTypes — never pass
      // an explicit `undefined` to an optional field on ListUsersInput.
      const filters: import('@assessiq/users').ListUsersInput = { page, pageSize, includeDeleted };
      if (role !== undefined) filters.role = role;
      if (status !== undefined) filters.status = status;
      if (typeof search === 'string' && search.length > 0) filters.search = search;
      return listUsers(tenantId, filters);
    },
  );

  // GET /api/admin/users/:id
  app.get(
    '/api/admin/users/:id',
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return getUser(tenantId, id);
    },
  );

  // POST /api/admin/users
  app.post(
    '/api/admin/users',
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const body = req.body as {
        email: string;
        name: string;
        role: 'admin' | 'reviewer' | 'candidate';
        metadata?: Record<string, unknown>;
      };
      const user = await createUser(tenantId, body, userId);
      return reply.code(201).send(user);
    },
  );

  // PATCH /api/admin/users/:id
  app.patch(
    '/api/admin/users/:id',
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const userId = req.session!.userId;
      const { id } = req.params as { id: string };
      const patch = req.body as {
        name?: string;
        role?: 'admin' | 'reviewer' | 'candidate';
        status?: 'active' | 'disabled' | 'pending';
        metadata?: Record<string, unknown>;
      };
      return updateUser(tenantId, id, patch, userId);
    },
  );

  // POST /api/admin/users/import — Phase 0 stub, 501 always.
  // NOTE: registered BEFORE /:id/* so Fastify's static-segment-first matching
  // never confuses "import" with a userId. Same ordering principle applies to
  // the Phase C lifecycle sub-paths below.
  app.post(
    '/api/admin/users/import',
    { preHandler: adminOnly },
    async (_req, reply) => {
      return reply.code(501).send({
        error: {
          code: 'BULK_IMPORT_PHASE_1',
          message:
            'CSV import not implemented in Phase 0 — see modules/03-users/SKILL.md § 1',
        },
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Phase C — tenant-admin user lifecycle endpoints
  //
  // POST   /api/admin/users/:userId/disable
  // POST   /api/admin/users/:userId/reenable
  // DELETE /api/admin/users/:userId              (soft-delete, with self-guard + log)
  // POST   /api/admin/users/:userId/restore
  // DELETE /api/admin/users/invitations/:invitationId
  //
  // All gated by adminOnly. Body: { reason?: string } via parseLifecycleBody().
  // RLS enforces tenant scoping — a cross-tenant userId returns 404 from the
  // service layer (findUserById under withTenant finds nothing).
  // ──────────────────────────────────────────────────────────────────────────

  // POST /api/admin/users/:userId/disable
  app.post(
    '/api/admin/users/:userId/disable',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseLifecycleBody(req.body);

      // Self-disable guard: admins cannot disable their own account.
      if (session.userId === userId) {
        throw new ValidationError('You cannot disable your own account.', {
          details: { code: 'CANNOT_DISABLE_SELF' },
        });
      }

      // updateUser throws ConflictError with code LAST_ADMIN when the
      // last active admin is disabled. Let it propagate as-is (→ 409).
      const updated = await updateUser(
        session.tenantId,
        userId,
        { status: 'disabled' },
        session.userId,
      );

      logLifecycleEvent({
        action: 'user.disabled',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { status: 'active' },
        after: { status: 'disabled', reason: reason ?? null },
      });

      return reply.code(200).send({
        userId: updated.id,
        status: updated.status,
        previousStatus: 'active',
      });
    },
  );

  // POST /api/admin/users/:userId/reenable
  app.post(
    '/api/admin/users/:userId/reenable',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseLifecycleBody(req.body);

      const updated = await updateUser(
        session.tenantId,
        userId,
        { status: 'active' },
        session.userId,
      );

      logLifecycleEvent({
        action: 'user.reenabled',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { status: 'disabled' },
        after: { status: 'active', reason: reason ?? null },
      });

      return reply.code(200).send({
        userId: updated.id,
        status: updated.status,
        previousStatus: 'disabled',
      });
    },
  );

  // POST /api/admin/users/:userId/restore
  app.post(
    '/api/admin/users/:userId/restore',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseLifecycleBody(req.body);

      const restored = await restore(session.tenantId, userId, session.userId);

      logLifecycleEvent({
        action: 'user.restored',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        before: { deleted_at: 'non-null' },
        after: { deleted_at: null, reason: reason ?? null },
      });

      return reply.code(200).send({ userId: restored.id, status: restored.status });
    },
  );

  // DELETE /api/admin/users/invitations/:invitationId
  // NOTE: static "invitations" segment is registered BEFORE the parameterized
  // DELETE /:userId below; Fastify resolves static paths first so this wins.
  app.delete(
    '/api/admin/users/invitations/:invitationId',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { invitationId } = req.params as { invitationId: string };
      const { reason } = parseLifecycleBody(req.body);

      const result = await cancelInvitation(
        session.tenantId,
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

  // DELETE /api/admin/users/:userId — soft-delete (Phase C: adds self-guard + lifecycle log).
  app.delete(
    '/api/admin/users/:userId',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseLifecycleBody(req.body);

      // Self-delete guard: admins cannot soft-delete their own account.
      if (session.userId === userId) {
        throw new ValidationError('You cannot delete your own account.', {
          details: { code: 'CANNOT_DELETE_SELF' },
        });
      }

      await softDelete(session.tenantId, userId, session.userId);

      logLifecycleEvent({
        action: 'user.soft_deleted',
        actor: { userId: session.userId, role: session.role },
        target: { entityType: 'user', entityId: userId },
        after: { deleted: true, reason: reason ?? null },
      });

      return reply.code(200).send({ userId, deleted: true });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Module 20 — DPDP data-rights endpoints (S2, 2026-05-29)
  //
  // GET  /api/admin/users/:userId/data-export  — full DSAR bundle (read-only)
  // POST /api/admin/users/:userId/erase        — candidate PII tombstone
  //
  // Both are /:userId sub-paths, same shape as /:userId/disable above.
  // Static-segment routes (import, invitations) are registered earlier and
  // are never confused by Fastify's static-segment-first matching.
  // ──────────────────────────────────────────────────────────────────────────

  // GET /api/admin/users/:userId/data-export
  app.get(
    '/api/admin/users/:userId/data-export',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };

      const bundle = await exportCandidateData(session.tenantId, userId);

      // Emit audit AFTER the export is assembled — if the DB read fails the
      // audit is never written, keeping the trail accurate.
      await audit({
        tenantId: session.tenantId,
        actorUserId: session.userId,
        actorKind: 'user',
        action: 'user.data.exported',
        entityType: 'user',
        entityId: userId,
      });

      return reply.code(200).send(bundle);
    },
  );

  // POST /api/admin/users/:userId/erase
  app.post(
    '/api/admin/users/:userId/erase',
    { preHandler: adminOnly },
    async (req, reply) => {
      const session = req.session!;
      const { userId } = req.params as { userId: string };
      const { reason } = parseLifecycleBody(req.body);

      // reason is required for erasure (differs from other lifecycle routes
      // where it is optional). Throw early so the error code is precise.
      if (reason === undefined) {
        throw new ValidationError('reason is required for PII erasure', {
          details: { code: 'REASON_REQUIRED' },
        });
      }

      // ValidationError codes ERASE_NOT_CANDIDATE and USER_NOT_FOUND propagate
      // as-is; the global Fastify error handler maps them to 400/404.
      const receipt = await eraseCandidatePii(
        session.tenantId,
        userId,
        reason,
        session.userId,
      );

      return reply.code(200).send(receipt);
    },
  );
}
