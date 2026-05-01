import type { FastifyInstance } from 'fastify';
import { config } from '@assessiq/core';
import { sessions } from '@assessiq/auth';
import { authChain } from '../../middleware/auth-chain.js';

// POST /api/auth/logout — destroys the current session and clears the cookie.
// Spec: docs/03-api-contract.md:26 — POST /auth/logout.
// Available to any session-backed request (admin, reviewer, candidate).
// API-key requests see 401 — there is no "logout" for a server-to-server token;
// admins revoke API keys via DELETE /api/admin/api-keys/:id instead.

export async function registerLogoutRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/logout',
    {
      config: { skipAuth: true },
      preHandler: authChain(),
    },
    async (req, reply) => {
      const token = req.cookies?.[config.SESSION_COOKIE_NAME];
      if (typeof token === 'string' && token.length > 0) {
        await sessions.destroy(token);
      }
      reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
      return reply.code(204).send();
    },
  );
}
