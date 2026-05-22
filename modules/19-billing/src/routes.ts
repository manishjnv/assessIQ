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
import { getUsage, getCompanyEntitlements, listAvailableSetsForTenant } from './service.js';

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

  // GET /api/billing/entitlements
  // Returns the active entitlements for the authenticated admin's own tenant.
  // Company-admin path: RLS-scoped via withTenant, activeOnly=true.
  // Response 200: { entitlements: TenantEntitlement[] }
  app.get(
    '/api/billing/entitlements',
    { preHandler: companyAdmin },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const entitlements = await getCompanyEntitlements(tenantId);
      return { entitlements };
    },
  );

  // GET /api/billing/available-sets
  // Step 2 — the "Available sets" catalog: published platform-library sets this
  // tenant is licensed for (domain or pack scope). Metadata only; no question
  // content. Drives the company-admin "assess from a set" picker (clone-on-use).
  // Response 200: { sets: AvailableSet[] }
  app.get(
    '/api/billing/available-sets',
    { preHandler: companyAdmin },
    async (req) => {
      const tenantId = req.session!.tenantId;
      const sets = await listAvailableSetsForTenant(tenantId);
      return { sets };
    },
  );
}
