// GET /api/public/tenant-logo/:tenantId - public by design (the logo is shown on
// pre-login screens, emails, certificates). Tenant id comes from the URL; an
// unknown id or a tenant without a logo is 404. Immutable cache only when the
// caller's ?v= equals the current sha prefix (see tenantLogoUrl).

import type { FastifyInstance } from 'fastify';
import { NotFoundError, isUuid } from '@assessiq/core';
import { getTenantLogoBytes } from '@assessiq/tenancy';

export async function registerPublicTenantLogoRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { tenantId: string }; Querystring: { v?: string } }>(
    '/api/public/tenant-logo/:tenantId',
    { config: { skipAuth: true } },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) throw new NotFoundError('logo not found');
      const logo = await getTenantLogoBytes(tenantId);
      if (logo === null) throw new NotFoundError('logo not found');

      const etag = `"${logo.sha256}"`;
      const immutable = req.query.v === logo.sha256.slice(0, 12);
      reply
        .header('Content-Type', logo.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('ETag', etag)
        .header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.code(200).send(logo.bytes);
    },
  );
}
