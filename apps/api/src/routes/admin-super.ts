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
//
// C4 additions (super-admin-onboarding contract, 2026-05-17):
//   POST /api/admin/super/companies  — create company tenant + seed + invite admin
//   GET  /api/admin/super/tenants    — list all tenants (system-role, visibility only)


import type { FastifyInstance } from 'fastify';
import { registerAdminSuperTenantRoutes } from './admin-super/tenants.js';
import { registerAdminSuperBillingRoutes } from './admin-super/billing-entitlements.js';
import { registerAdminSuperDomainRoutes } from './admin-super/domains.js';
import { registerAdminSuperUserRoutes } from './admin-super/users.js';
import { registerAdminSuperEntitlementRevokeRoute } from './admin-super/entitlement-revoke.js';

// Registration order is unchanged from the pre-split file (Fastify plugin order).
export async function registerAdminSuperRoutes(app: FastifyInstance): Promise<void> {
  await registerAdminSuperTenantRoutes(app);
  await registerAdminSuperBillingRoutes(app);
  await registerAdminSuperDomainRoutes(app);
  await registerAdminSuperUserRoutes(app);
  await registerAdminSuperEntitlementRevokeRoute(app);
}
