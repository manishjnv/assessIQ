import type { FastifyInstance } from 'fastify';
import { AppError, ValidationError } from '@assessiq/core';
import {
  listEmbedOrigins,
  addEmbedOrigin,
  removeEmbedOrigin,
  rotateWebhookSecret,
} from '@assessiq/embed-sdk';
import { authChain } from '../middleware/auth-chain.js';

// Embed admin routes — origins CRUD + webhook secret rotation.
//
// All routes require admin role (no MFA freshness gate — these are low-risk
// config ops; embed-secrets rotation does require fresh MFA per embed-secrets.ts).
//
// Routes:
//   GET    /api/admin/embed-origins            — list current allowed origins
//   POST   /api/admin/embed-origins            — add an origin
//   DELETE /api/admin/embed-origins            — remove an origin (body: {origin})
//   POST   /api/admin/webhook-secrets/rotate   — rotate webhook HMAC-256 secret

const ADMIN_ONLY = authChain({ roles: ['admin'] });

const addOriginBodySchema = {
  type: 'object',
  required: ['origin'],
  additionalProperties: false,
  properties: { origin: { type: 'string', minLength: 1, maxLength: 2048 } },
} as const;

const removeOriginBodySchema = {
  type: 'object',
  required: ['origin'],
  additionalProperties: false,
  properties: { origin: { type: 'string', minLength: 1, maxLength: 2048 } },
} as const;

export async function registerEmbedAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  // -------------------------------------------------------------------
  // GET /api/admin/embed-origins
  // -------------------------------------------------------------------
  app.get(
    '/api/admin/embed-origins',
    {
      config: { skipAuth: true },
      preHandler: ADMIN_ONLY,
    },
    async (req) => {
      const sess = req.session!;
      const origins = await listEmbedOrigins(sess.tenantId);
      return { origins };
    },
  );

  // -------------------------------------------------------------------
  // POST /api/admin/embed-origins
  // -------------------------------------------------------------------
  app.post(
    '/api/admin/embed-origins',
    {
      config: { skipAuth: true },
      schema: { body: addOriginBodySchema },
      preHandler: ADMIN_ONLY,
    },
    async (req, reply) => {
      const sess = req.session!;
      const { origin } = req.body as { origin: string };

      // Basic URL-like validation (csp-builder will further sanitize, but
      // reject at the API surface so the caller gets a clear error).
      if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(origin)) {
        throw new ValidationError(
          'origin must be a scheme+host (e.g. https://yourapp.com or http://localhost:3000)',
          { details: { code: 'INVALID_ORIGIN_FORMAT' } },
        );
      }

      await addEmbedOrigin(sess.tenantId, origin, sess.userId);
      return reply.code(201).send({ origin });
    },
  );

  // -------------------------------------------------------------------
  // DELETE /api/admin/embed-origins  (origin in request body)
  // -------------------------------------------------------------------
  app.delete(
    '/api/admin/embed-origins',
    {
      config: { skipAuth: true },
      schema: { body: removeOriginBodySchema },
      preHandler: ADMIN_ONLY,
    },
    async (req, reply) => {
      const sess = req.session!;
      const { origin } = req.body as { origin: string };
      await removeEmbedOrigin(sess.tenantId, origin, sess.userId);
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------
  // POST /api/admin/webhook-secrets/rotate
  // Returns the new plaintext HMAC secret ONCE; caller stores it.
  // -------------------------------------------------------------------
  app.post(
    '/api/admin/webhook-secrets/rotate',
    {
      config: { skipAuth: true },
      preHandler: ADMIN_ONLY,
    },
    async (req) => {
      const sess = req.session!;
      const plaintext = await rotateWebhookSecret(sess.tenantId, sess.userId);
      return {
        plaintextSecret: plaintext,
        note: 'Store this value immediately — it will not be shown again.',
      };
    },
  );
}
