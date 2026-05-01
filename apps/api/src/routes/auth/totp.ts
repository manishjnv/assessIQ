import type { FastifyInstance } from 'fastify';
import { AppError, AuthnError, config, ValidationError } from '@assessiq/core';
import { totp, sessions } from '@assessiq/auth';
import { getUser } from '@assessiq/users';
import { authChain } from '../../middleware/auth-chain.js';

// TOTP routes — enrollment, verify, recovery. Library handles RFC 6238
// crypto, lockout, recovery codes; route layer wires HTTP shape + session
// promotion on success.
//
// Spec sources:
//   - docs/03-api-contract.md:22-25 (TOTP endpoints)
//   - docs/04-auth-flows.md Flow 1a (TOTP enroll), 1b (step-up MFA)
//   - modules/01-auth/SKILL.md § Decisions captured §§ 3, 4

const codeBodySchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' } },
} as const;

const recoveryBodySchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  // Crockford base32 minus I/L/O/U → 8 chars per addendum §2.
  properties: { code: { type: 'string', minLength: 8, maxLength: 8, pattern: '^[0-9A-HJKMNP-TV-Z]{8}$' } },
} as const;

// Map the library's lockout signal — AuthnError("account locked") — to a
// dedicated 423 Locked response so the SPA can render a distinct UX from
// "wrong code". String-match is brittle but cheap; the library uses a stable
// message and tests pin it.
function mapLockout(err: unknown): never {
  if (err instanceof AuthnError && /locked/.test(err.message)) {
    throw new AppError('Too many failed attempts. Try again in 15 minutes.', 'ACCOUNT_LOCKED', 423, {
      details: { retryAfterSeconds: 900 },
    });
  }
  throw err as Error;
}

async function promoteSessionToVerified(
  cookieToken: string | undefined,
): Promise<void> {
  if (typeof cookieToken !== 'string' || cookieToken.length === 0) return;
  await sessions.markTotpVerified(cookieToken);
}

export async function registerTotpRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/totp/enroll/start
  // Pre-MFA session expected — admin/reviewer who has Google-SSO'd but not yet
  // enrolled TOTP. Returns the otpauth URI + secretBase32 for client-side QR render.
  app.post(
    '/api/auth/totp/enroll/start',
    {
      config: { skipAuth: true },
      preHandler: authChain({
        roles: ['admin', 'reviewer'],
        requireTotpVerified: false,
      }),
    },
    async (req) => {
      const sess = req.session!;
      const user = await getUser(sess.tenantId, sess.userId);
      const out = await totp.enrollStart(sess.userId, sess.tenantId, user.email);
      return out;
    },
  );

  // POST /api/auth/totp/enroll/confirm
  // Confirms first-time enrollment. Returns the 10 plaintext recovery codes ONCE.
  // On success: promote the pre-MFA session to TOTP-verified.
  app.post(
    '/api/auth/totp/enroll/confirm',
    {
      config: { skipAuth: true },
      schema: { body: codeBodySchema },
      preHandler: authChain({
        roles: ['admin', 'reviewer'],
        requireTotpVerified: false,
      }),
    },
    async (req) => {
      const sess = req.session!;
      const { code } = req.body as { code: string };
      try {
        const out = await totp.enrollConfirm(sess.userId, sess.tenantId, code);
        await promoteSessionToVerified(req.cookies?.[config.SESSION_COOKIE_NAME]);
        return out;
      } catch (err) {
        // ValidationError "invalid totp code" is the wrong-code path (400).
        // Lockout signals get mapped to 423; other AuthnErrors propagate as 401.
        if (err instanceof ValidationError) throw err;
        mapLockout(err);
      }
    },
  );

  // POST /api/auth/totp/verify
  // Used both for first-login MFA after Google-SSO AND for step-up MFA on
  // sensitive admin actions. We don't gate on requireTotpVerified — the route
  // accepts pre-MFA sessions (the typical case) and verified sessions (step-up).
  app.post(
    '/api/auth/totp/verify',
    {
      config: { skipAuth: true },
      schema: { body: codeBodySchema },
      preHandler: authChain({
        roles: ['admin', 'reviewer'],
        requireTotpVerified: false,
      }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const { code } = req.body as { code: string };
      let ok = false;
      try {
        ok = await totp.verify(sess.userId, sess.tenantId, code);
      } catch (err) {
        mapLockout(err);
      }
      if (!ok) {
        throw new AppError('invalid totp code', 'INVALID_CODE', 401);
      }
      await promoteSessionToVerified(req.cookies?.[config.SESSION_COOKIE_NAME]);
      return reply.code(204).send();
    },
  );

  // POST /api/auth/totp/recovery
  // Recovery code path — used when the authenticator app is lost.
  app.post(
    '/api/auth/totp/recovery',
    {
      config: { skipAuth: true },
      schema: { body: recoveryBodySchema },
      preHandler: authChain({
        roles: ['admin', 'reviewer'],
        requireTotpVerified: false,
      }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const { code } = req.body as { code: string };
      let ok = false;
      try {
        ok = await totp.consumeRecovery(sess.userId, sess.tenantId, code);
      } catch (err) {
        mapLockout(err);
      }
      if (!ok) {
        throw new AppError('invalid recovery code', 'INVALID_RECOVERY_CODE', 401);
      }
      await promoteSessionToVerified(req.cookies?.[config.SESSION_COOKIE_NAME]);
      return reply.code(204).send();
    },
  );
}
