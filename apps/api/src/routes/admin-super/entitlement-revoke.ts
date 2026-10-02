// AssessIQ — apps/api/src/routes/admin-super/entitlement-revoke.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import { assertTenantActive } from '@assessiq/tenancy';
import { revokeEntitlement, type EntitlementScopeType } from '@assessiq/billing';
import { superAdminOnly } from './_shared.js';

export async function registerAdminSuperEntitlementRevokeRoute(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/admin/super/tenants/:tenantId/entitlements
  //
  // Revoke an active scope entitlement from a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Decision: DELETE-with-body. There is no direct precedent for DELETE-with-
  // body in this codebase (other DELETEs use path params for identity, e.g.
  // DELETE /api/admin/embed-origins uses body). Since entitlements are
  // identified by (tenant_id, scope_type, scope_id) — a composite key, not a
  // single UUID — encoding all three in the URL path would produce an unwieldy
  // URL and/or require URL-encoding of arbitrary scope_id strings. Body is the
  // more ergonomic approach. Fastify supports DELETE-with-body natively (no
  // configuration needed). Query params are an acceptable alternative but body
  // is more consistent with the POST (grant) shape above and avoids encoding
  // issues with scope_id values that contain slashes or special characters.
  //
  // Body: { scopeType: 'domain'|'pack', scopeId: string }
  //
  // Response 200: { tenant_id, scope_type, scope_id, status: 'revoked', auditId }
  // Response 400: invalid scope (INVALID_SCOPE)
  // Response 403: not super_admin
  // Response 404: ENTITLEMENT_NOT_FOUND — nothing active to revoke
  // ──────────────────────────────────────────────────────────────────────────
  app.delete(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      const body = (req.body ?? {}) as { scopeType?: unknown; scopeId?: unknown };

      // Light type-guard — domain validation is delegated to revokeEntitlement.
      if (typeof body.scopeType !== 'string' || body.scopeType.trim().length === 0) {
        throw new ValidationError('scopeType must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeType },
        });
      }
      if (typeof body.scopeId !== 'string' || body.scopeId.trim().length === 0) {
        throw new ValidationError('scopeId must be a non-empty string', {
          details: { code: 'INVALID_SCOPE', received: body.scopeId },
        });
      }

      const result = await revokeEntitlement(req.session!.userId, tenantId, {
        scopeType: body.scopeType as EntitlementScopeType,
        scopeId: body.scopeId,
      });
      return reply.code(200).send({ revoked: true, ...result });
    },
  );
}
