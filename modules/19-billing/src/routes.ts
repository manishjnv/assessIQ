// AssessIQ — modules/19-billing/src/routes.ts
//
// Fastify route layer for the billing module.
// DI shape mirrors modules/05-assessment-lifecycle/src/routes.ts:
// the preHandler chain is injected by apps/api/src/server.ts rather than
// deep-imported, so this module has no hard dep on apps/api internals.
//
// Endpoint: GET /api/billing/usage
//   Auth:   company admin (role = 'admin'), own tenant, read-only.
//   Returns: BillingUsage JSON.
//
// RLS: getUsage calls withTenant internally, scoping the query to the
// session's tenantId. Cross-tenant reads are impossible at the DB layer.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { getUsage } from './service.js';

// ---------------------------------------------------------------------------
// DI shape — mirrors the RegisterAssessmentLifecycleRoutesOptions pattern
// ---------------------------------------------------------------------------

export interface BillingRouteDeps {
  /**
   * Admin auth-chain: rateLimit → sessionLoader → apiKeyAuth → syncCtx
   * → requireAuth({roles:['admin']}) → extendOnPass.
   * Injected from apps/api/src/middleware/auth-chain.ts via server.ts.
   */
  companyAdmin:
    | preHandlerHookHandler[]
    | preHandlerHookHandler;
}

// ---------------------------------------------------------------------------
// Plugin registrar
// ---------------------------------------------------------------------------

export async function registerBillingRoutes(
  app: FastifyInstance,
  deps: BillingRouteDeps,
): Promise<void> {
  const { companyAdmin } = deps;

  // GET /api/billing/usage
  // Returns the current credit usage picture for the authenticated admin's tenant.
  app.get(
    '/api/billing/usage',
    { preHandler: companyAdmin },
    async (req) => {
      const tenantId = req.session!.tenantId;
      return getUsage(tenantId);
    },
  );
}
