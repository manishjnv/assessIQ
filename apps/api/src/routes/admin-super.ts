// AssessIQ — apps/api/src/routes/admin-super.ts
//
// Super-admin-only routes. These endpoints operate across tenant boundaries
// and require role = 'super_admin'. No tenant admin or reviewer can reach them.
//
// Route prefix: /api/admin/super
// Rationale for the prefix: per project CLAUDE.md, admin routes live under
// /api/admin/*. The "super" sub-prefix distinguishes cross-tenant platform
// operations from per-tenant admin operations. It makes it explicit in Caddy
// logs and nginx access logs when a super-admin is acting.
//
// INVARIANTS:
//   - Every handler verifies req.session is present (enforced by preHandler chain).
//   - Every handler verifies req.session.role === 'super_admin' (enforced by authChain).
//   - No handler widens the updateTenantSettingsRow patch surface — ai_generate_mode
//     changes use the isolated updateAiGenerateMode service method.

import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import { updateAiGenerateMode } from '@assessiq/tenancy';
import { authChain } from '../middleware/auth-chain.js';

// Gate: session must exist AND role must be 'super_admin'.
// authChain's requireAuth enforces both the session check and the role check.
const superAdminOnly = authChain({ roles: ['super_admin'] });

export async function registerAdminSuperRoutes(app: FastifyInstance): Promise<void> {
  // PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode
  //
  // Flip `tenant_settings.ai_generate_mode` for the target tenant.
  //
  // Response 200: { tenantId, ai_generate_mode, previous, updatedAt, auditId }
  // Response 400: invalid mode value
  // Response 403: caller is not a super_admin (authChain throws AuthzError → 403)
  // Response 404: tenant has no tenant_settings row
  //
  // Audit guarantee: the UPDATE and the audit_log INSERT are in the same
  // Postgres transaction via updateAiGenerateMode → auditInTx. If the audit
  // INSERT fails, the UPDATE rolls back. Atomicity is non-negotiable per
  // project CLAUDE.md hard rule.
  app.patch(
    '/api/admin/super/tenants/:tenantId/ai-generate-mode',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const body = req.body as { mode?: unknown };

      // Validate mode: must be exactly one of the three allowed values.
      // Anything else (undefined, empty string, typos) is a 400.
      const mode = body?.mode;
      if (mode !== 'omnibus' && mode !== 'sharded' && mode !== null) {
        throw new ValidationError(
          'mode must be "omnibus", "sharded", or null',
          { details: { code: 'INVALID_MODE', received: mode } },
        );
      }
      const newMode = mode as 'omnibus' | 'sharded' | null;

      // req.session is guaranteed non-null by the preHandler chain.
      const result = await updateAiGenerateMode(
        req.session!.userId,
        tenantId,
        newMode,
      );

      return reply.code(200).send({
        tenantId: result.tenantId,
        ai_generate_mode: result.ai_generate_mode,
        previous: result.previous,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );
}
