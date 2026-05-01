import type { FastifyInstance } from 'fastify';
import { createEmbedSecret, rotateEmbedSecret } from '@assessiq/auth';
import { authChain } from '../../middleware/auth-chain.js';

// Embed-secret admin endpoints. Library handles AES-256-GCM envelope under
// ASSESSIQ_MASTER_KEY; plaintext secret shown ONCE on POST.
//
// Spec: docs/03-api-contract.md:132-134; modules/01-auth/SKILL.md § Decisions §5.
// All mutations require fresh MFA — these are tenant-scoped signing keys.
//
// NOTE: GET /api/admin/embed-secrets is intentionally NOT shipped this pass —
// the library has no `listEmbedSecrets` helper yet. Phase 0 closure scope is
// the route layer + closure drills; the list helper is a Phase 1 add when
// admin UI surfaces a rotation panel. (Plan §2d Open Q #6.)

const createBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

const FRESH_MFA_MINUTES = 15;

export async function registerEmbedSecretsRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/embed-secrets
  app.post(
    '/api/admin/embed-secrets',
    {
      config: { skipAuth: true },
      schema: { body: createBodySchema },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const { name } = req.body as { name: string };
      const out = await createEmbedSecret(sess.tenantId, name);
      return reply.code(201).send({
        id: out.id,
        name,
        // Plaintext shown ONCE — caller must store it server-side immediately.
        plaintextSecret: out.plaintextSecret,
      });
    },
  );

  // POST /api/admin/embed-secrets/:id/rotate
  // Library rotates the active secret for the tenant — :id in the URL is
  // surfaced for audit shape parity with the api-contract doc, but the
  // library's rotateEmbedSecret operates on the tenant's active row.
  app.post(
    '/api/admin/embed-secrets/:id/rotate',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req) => {
      const sess = req.session!;
      const out = await rotateEmbedSecret(sess.tenantId);
      return {
        id: out.id,
        plaintextSecret: out.plaintextSecret,
      };
    },
  );
}
