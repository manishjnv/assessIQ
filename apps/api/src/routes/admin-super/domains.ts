// AssessIQ — apps/api/src/routes/admin-super/domains.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, idParams } from '../_validate.js';
import { createDomainBody, setDomainStatusBody } from '../_schemas.js';
import { listPlatformDomains, createPlatformDomain, setPlatformDomainStatus } from '@assessiq/question-bank';
import { superAdminOnly, superAdminFreshMfa } from './_shared.js';


export async function registerAdminSuperDomainRoutes(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // Platform domain management (super-admin) — manage the canonical domain
  // library and propagate create/archive/reactivate across every tenant.
  //
  // PLATFORM-WIDE operations (no :tenantId): they read/write the platform
  // master tenant's domains and mirror changes into every company tenant.
  // Provenance (domains.source, migration 0091) ensures tenant-LOCAL domains
  // are never touched. CATALOG-ONLY: archive does not revoke entitlements.
  // See modules/04-question-bank/src/platform-domains.ts.
  // ──────────────────────────────────────────────────────────────────────────

  // GET /api/admin/super/domains
  // List the platform domain library (all statuses) for the management UI.
  // Gate: super_admin + totpVerified (superAdminOnly) — read-only.
  // Response 200: { domains: PlatformDomainRow[] }
  app.get(
    '/api/admin/super/domains',
    { preHandler: superAdminOnly },
    async (_req, reply) => {
      const domains = await listPlatformDomains();
      return reply.code(200).send({ domains });
    },
  );

  // POST /api/admin/super/domains
  // Create a platform domain and propagate it to every company tenant.
  // Gate: super_admin + fresh MFA (15-min) — platform-affecting cross-tenant write.
  // Body: { name: string, description?: string }
  // Response 201: PlatformDomainRow & { propagatedTenants }
  // Response 400: MISSING_REQUIRED | INVALID_PARAM · 409: DOMAIN_SLUG_EXISTS
  app.post(
    '/api/admin/super/domains',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const body = parseBody(createDomainBody, req.body, { code: 'MISSING_REQUIRED' });
      const result = await createPlatformDomain(req.session!.userId, {
        name: body.name,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      });
      return reply.code(201).send(result);
    },
  );

  // PATCH /api/admin/super/domains/:id
  // Archive (status='archived') or reactivate (status='active') a platform
  // domain; propagates the status to every platform-origin copy across tenants.
  // CATALOG-ONLY: does not revoke entitlements or untag content.
  // Gate: super_admin + fresh MFA (15-min).
  // Body: { status: 'active' | 'archived' }
  // Response 200: PlatformDomainRow & { affectedRows } · 404: DOMAIN_NOT_FOUND
  app.patch(
    '/api/admin/super/domains/:id',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const { id } = parseParams(idParams, req.params);
      const body = parseBody(setDomainStatusBody, req.body, { code: 'INVALID_STATUS' });
      const result = await setPlatformDomainStatus(req.session!.userId, id, body.status);
      return reply.code(200).send(result);
    },
  );

}
