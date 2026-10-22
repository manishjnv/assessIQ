// AssessIQ — apps/api/src/routes/admin-super/user-totp-reset.ts
// RW-45: super admin force-resets a user's TOTP (lost authenticator, no recovery codes).

import type { FastifyInstance } from 'fastify';
import { ConflictError } from '@assessiq/core';
import { totp } from '@assessiq/auth';
import { assertTenantActive } from '@assessiq/tenancy';
import { getUser } from '@assessiq/users';
import { parseBody, parseParams, requiredString, tenantIdParams, userIdParams, z } from '../_validate.js';
import { superAdminFreshMfa } from './_shared.js';
import { notifyTotpReset } from '../admin-users-totp-reset.js';

const resetBody = z.object({ reason: requiredString('reason is required', { max: 500, code: 'INVALID_REASON' }) });
const params = tenantIdParams.merge(userIdParams);

export async function registerAdminSuperUserTotpResetRoute(app: FastifyInstance): Promise<void> {
  // POST /api/admin/super/tenants/:tenantId/users/:userId/totp/reset
  // Gate: super_admin + totpVerified (superAdminOnly). Body { reason } required (<=500).
  // 400 bad body/params; 403 not super_admin; 404 user not in tenant;
  // 409 SELF_RESET_FORBIDDEN (a super admin cannot reset their own TOTP here).
  // 204 on success. Secret, recovery codes cleared; auth.totp.reset audited in the same tx.
  app.post(
    '/api/admin/super/tenants/:tenantId/users/:userId/totp/reset',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const { tenantId, userId } = parseParams(params, req.params);
      const { reason } = parseBody(resetBody, req.body);
      if (userId === req.session!.userId) {
        throw new ConflictError('cannot reset your own TOTP', { details: { code: 'SELF_RESET_FORBIDDEN' } });
      }
      await assertTenantActive(tenantId);
      const target = await getUser(tenantId, userId); // NotFoundError -> 404 if not in this tenant
      await totp.adminResetTotp(req.session!.userId, tenantId, userId, reason.trim());
      await notifyTotpReset(tenantId, target, 'super_admin'); // RW-91: after commit, failure only logged
      return reply.code(204).send();
    },
  );
}
