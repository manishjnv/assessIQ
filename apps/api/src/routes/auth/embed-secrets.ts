import type { FastifyInstance } from 'fastify';
import {
  createEmbedSecret,
  rotateEmbedSecret,
  listEmbedSecrets,
} from '@assessiq/auth';
import { audit } from '@assessiq/audit-log';
import { withTenant } from '@assessiq/tenancy';
import { AppError } from '@assessiq/core';
import { authChain } from '../../middleware/auth-chain.js';

// Embed-secret admin endpoints. Library handles AES-256-GCM envelope under
// ASSESSIQ_MASTER_KEY; plaintext secret shown ONCE on POST. GET never decrypts
// the envelope — listEmbedSecrets returns metadata only.
//
// Spec: docs/03-api-contract.md § Embed; modules/01-auth/SKILL.md § Decisions §5.
// Mutations require fresh MFA — these are tenant-scoped signing keys.
//
// Privacy gate (D13): POST create → 403 unless tenant.privacy_disclosed = TRUE.
// Audit writes: every mutation writes an audit_log row.

const createBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

const FRESH_MFA_MINUTES = 15;

interface TenantPrivacyRow {
  privacy_disclosed: boolean;
}

export async function registerEmbedSecretsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/embed-secrets — list metadata; envelope is never decrypted.
  app.get(
    '/api/admin/embed-secrets',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'] }),
    },
    async (req) => {
      const sess = req.session!;
      const items = await listEmbedSecrets(sess.tenantId);
      return { items };
    },
  );

  // POST /api/admin/embed-secrets
  // Privacy gate: tenant.privacy_disclosed must be TRUE (D13).
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

      // D13: block creation if tenant has not disclosed privacy terms.
      const privacyRow = await withTenant(sess.tenantId, async (client) => {
        const result = await client.query<TenantPrivacyRow>(
          `SELECT privacy_disclosed FROM tenants WHERE id = $1 LIMIT 1`,
          [sess.tenantId],
        );
        return result.rows[0] ?? null;
      });
      if (!privacyRow?.privacy_disclosed) {
        throw new AppError(
          'Tenant must confirm privacy disclosure before creating embed secrets.',
          'EMBED_REGISTRATION_REQUIRES_PRIVACY_DISCLOSURE',
          403,
        );
      }

      const out = await createEmbedSecret(sess.tenantId, name);

      // Audit write — every secret creation is auditable.
      await audit({
        tenantId: sess.tenantId,
        actorKind: 'user',
        actorUserId: sess.userId,
        action: 'embed_secret.created',
        entityType: 'embed_secret',
        entityId: out.id,
        after: { name, id: out.id },
      });

      return reply.code(201).send({
        id: out.id,
        name,
        // Plaintext shown ONCE — caller must store it server-side immediately.
        plaintextSecret: out.plaintextSecret,
      });
    },
  );

  // POST /api/admin/embed-secrets/:id/rotate
  app.post(
    '/api/admin/embed-secrets/:id/rotate',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req) => {
      const sess = req.session!;
      const { id } = req.params as { id: string };
      const out = await rotateEmbedSecret(sess.tenantId);

      // Audit write.
      await audit({
        tenantId: sess.tenantId,
        actorKind: 'user',
        actorUserId: sess.userId,
        action: 'embed_secret.rotated',
        entityType: 'embed_secret',
        entityId: id,
      });

      return {
        id: out.id,
        plaintextSecret: out.plaintextSecret,
      };
    },
  );

  // DELETE /api/admin/embed-secrets/:id — revoke a specific secret.
  // Marks the row status='revoked'. Revoked secrets are not tried during
  // JWT verification (only active + rotated-within-grace are tried).
  app.delete(
    '/api/admin/embed-secrets/:id',
    {
      config: { skipAuth: true },
      preHandler: authChain({ roles: ['admin'], freshMfaWithinMinutes: FRESH_MFA_MINUTES }),
    },
    async (req, reply) => {
      const sess = req.session!;
      const { id } = req.params as { id: string };

      await withTenant(sess.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE embed_secrets
           SET status = 'revoked'
           WHERE id = $1 AND tenant_id = $2 AND status != 'revoked'`,
          [id, sess.tenantId],
        );
        if (result.rowCount === 0) {
          throw new AppError(
            `Embed secret ${id} not found or already revoked`,
            'NOT_FOUND',
            404,
          );
        }
      });

      // Audit write.
      await audit({
        tenantId: sess.tenantId,
        actorKind: 'user',
        actorUserId: sess.userId,
        action: 'embed_secret.revoked',
        entityType: 'embed_secret',
        entityId: id,
      });

      return reply.code(204).send();
    },
  );
}
