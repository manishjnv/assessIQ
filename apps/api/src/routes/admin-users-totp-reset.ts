// AssessIQ — apps/api/src/routes/admin-users-totp-reset.ts
// RW-91: a tenant admin resets another user's TOTP (lost authenticator, no recovery codes).

import type { FastifyInstance } from 'fastify';
import { AuthnError, AuthzError, ConflictError, streamLogger } from '@assessiq/core';
import { totp } from '@assessiq/auth';
import { getUser } from '@assessiq/users';
import { sendTotpResetNoticeEmail } from '@assessiq/notifications';
import { authChain } from '../middleware/auth-chain.js';
import { parseBody, parseParams, requiredString, userIdParams, z } from './_validate.js';

const log = streamLogger('app');

// Tenant admin + TOTP within the last 15 min (same step-up window as superAdminFreshMfa).
const adminFreshMfa = authChain({ roles: ['admin'], freshMfaWithinMinutes: 15 });
const resetBody = z.object({ reason: requiredString('reason is required', { max: 500, code: 'INVALID_REASON' }) });

/**
 * Tell the user their two-factor was reset. Call AFTER adminResetTotp returned (its
 * transaction has committed). A send failure is logged and never fails the reset.
 */
export async function notifyTotpReset(
  tenantId: string,
  target: { id: string; email: string; name: string },
  actorRole: 'admin' | 'super_admin',
): Promise<void> {
  try {
    await sendTotpResetNoticeEmail({
      to: target.email,
      recipientName: target.name.length > 0 ? target.name : target.email,
      actorRole,
      tenantId,
    });
  } catch (err: unknown) {
    log.error({ err, tenantId, userId: target.id }, 'totp reset notice email failed');
  }
}

export async function registerAdminUserTotpResetRoute(app: FastifyInstance): Promise<void> {
  // POST /api/admin/users/:userId/totp/reset
  // Gate: admin + fresh TOTP (15 min). Body { reason } required (<=500).
  // 400 bad body; 403 not admin / stale TOTP / target is super_admin; 404 user not in tenant;
  // 409 SELF_RESET_FORBIDDEN. 204 on success; auth.totp.reset audited in the reset tx.
  app.post(
    '/api/admin/users/:userId/totp/reset',
    { preHandler: adminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      // The middleware skips freshMfaWithinMinutes for non-super roles when MFA_REQUIRED=false,
      // so enforce the step-up here for every config. Same error text as the middleware, so the
      // UI step-up (useMfaGuard) handles it; a caller with no TOTP must enrol first (account security page).
      if (!(session.totpVerified && session.lastTotpAt !== null && Date.now() - Date.parse(session.lastTotpAt) <= 15 * 60 * 1000)) {
        throw new AuthnError('fresh totp required', { details: { code: 'FRESH_TOTP_REQUIRED' } });
      }
      const { userId } = parseParams(userIdParams, req.params);
      const { reason } = parseBody(resetBody, req.body);
      if (userId === session.userId) {
        throw new ConflictError('cannot reset your own TOTP', { details: { code: 'SELF_RESET_FORBIDDEN' } });
      }
      const target = await getUser(session.tenantId, userId); // NotFoundError -> 404 (RLS scopes the tenant)
      if ((target.role as string) === 'super_admin') {
        throw new AuthzError('cannot reset a super admin', { details: { code: 'SUPER_ADMIN_TARGET' } });
      }
      await totp.adminResetTotp(session.userId, session.tenantId, userId, reason.trim());
      await notifyTotpReset(session.tenantId, target, 'admin');
      return reply.code(204).send();
    },
  );
}
