import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  softDelete,
  restore,
} from '@assessiq/users';
import { authChain } from '../middleware/auth-chain.js';

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
      const body = req.body as {
        email: string;
        name: string;
        role: 'admin' | 'reviewer' | 'candidate';
        metadata?: Record<string, unknown>;
      };
      const user = await createUser(tenantId, body);
      return reply.code(201).send(user);
    },
  );

  // PATCH /api/admin/users/:id
  app.patch(
    '/api/admin/users/:id',
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      const patch = req.body as {
        name?: string;
        role?: 'admin' | 'reviewer' | 'candidate';
        status?: 'active' | 'disabled' | 'pending';
        metadata?: Record<string, unknown>;
      };
      return updateUser(tenantId, id, patch);
    },
  );

  // DELETE /api/admin/users/:id
  app.delete(
    '/api/admin/users/:id',
    { preHandler: adminOnly },
    async (req, reply) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      await softDelete(tenantId, id);
      return reply.code(204).send();
    },
  );

  // POST /api/admin/users/:id/restore
  app.post(
    '/api/admin/users/:id/restore',
    { preHandler: adminOnly },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const { id } = req.params as { id: string };
      return restore(tenantId, id);
    },
  );

  // POST /api/admin/users/import — Phase 0 stub, 501 always
  // NOTE: route registered BEFORE /:id to avoid Fastify treating "import" as an id param.
  // Fastify matches static segments before parameterized ones, so order is a safety net.
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
}
