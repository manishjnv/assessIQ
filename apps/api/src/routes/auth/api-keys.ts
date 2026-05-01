import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import { apiKeys } from '@assessiq/auth';
import { authChain } from '../../middleware/auth-chain.js';

// API key admin endpoints — list / create / revoke. Library owns the storage
// + sha256 hashing + system-role lookup. Plaintext key returned ONCE on POST.
//
// Spec: docs/03-api-contract.md:128-131; modules/01-auth/SKILL.md § Decisions §6.
// Mutations require fresh MFA per Flow 1b (step-up before secret-bearing actions).

const VALID_SCOPES = [
  'assessments:read',
  'assessments:write',
  'users:read',
  'users:write',
  'attempts:read',
  'attempts:write',
  'results:read',
  'webhooks:manage',
  'admin:*',
] as const;

const createBodySchema = {
  type: 'object',
  required: ['name', 'scopes'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    scopes: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: { type: 'string', enum: VALID_SCOPES },
      uniqueItems: true,
    },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const FRESH_MFA_MINUTES = 15;

export async function registerApiKeysRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/api-keys — list, no plaintext.
  app.get(
    '/api/admin/api-keys',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'] }),
    },
    async (req) => {
      const sess = req.session!;
      const items = await apiKeys.list(sess.tenantId);
      return { items };
    },
  );

  // POST /api/admin/api-keys — create, returns plaintext ONCE.
  app.post(
    '/api/admin/api-keys',
    {
      config: { skipAuth: true },
      schema: { body: createBodySchema },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const body = req.body as {
        name: string;
        scopes: typeof VALID_SCOPES[number][];
        expiresAt?: string | null;
      };

      const input: Parameters<typeof apiKeys.create>[1] = {
        name: body.name,
        scopes: body.scopes,
        createdBy: sess.userId,
      };
      if (body.expiresAt !== undefined) input.expiresAt = body.expiresAt;

      const result = await apiKeys.create(sess.tenantId, input);
      return reply.code(201).send({
        id: result.record.id,
        keyPrefix: result.record.keyPrefix,
        name: result.record.name,
        scopes: result.record.scopes,
        createdAt: result.record.createdAt,
        expiresAt: result.record.expiresAt,
        // Plaintext key — shown ONCE. Caller must persist immediately.
        plaintextKey: result.plaintextKey,
      });
    },
  );

  // DELETE /api/admin/api-keys/:id — revoke.
  app.delete(
    '/api/admin/api-keys/:id',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new ValidationError('id must be a uuid', { details: { code: 'INVALID_ID' } });
      }
      await apiKeys.revoke(sess.tenantId, id);
      return reply.code(204).send();
    },
  );
}
