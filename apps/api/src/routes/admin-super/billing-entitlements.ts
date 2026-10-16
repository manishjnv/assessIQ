// AssessIQ — apps/api/src/routes/admin-super/billing-entitlements.ts
// Moved verbatim from routes/admin-super.ts (E9 split; no behaviour change).

import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, tenantIdParams } from '../_validate.js';
import { updatePlanBody, entitlementScopeBody } from '../_schemas.js';
import { assertTenantActive } from '@assessiq/tenancy';
import { config } from '@assessiq/core';
import {
  getTenantBillingDetail,
  getTenantBillingEventsCsv,
  updateTenantPlan,
  assertTierLimit,
  listTenantEntitlements,
  listTenantContentScopes,
  grantEntitlement,
  type PlanTier,
  type UpdateTenantPlanPatch,
  type EntitlementScopeType,
} from '@assessiq/billing';
import { superAdminOnly } from './_shared.js';

export async function registerAdminSuperBillingRoutes(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/billing
  //
  // Full billing detail for a single tenant (super-admin billing drawer).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: TenantBillingDetail
  // Response 404: no billing plan for this tenant (NotFoundError → 404)
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/billing',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      const detail = await getTenantBillingDetail(tenantId);
      return reply.code(200).send(detail);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/billing/export.csv
  //
  // CSV export of all billing events for a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: text/csv attachment
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/billing/export.csv',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      const csv = await getTenantBillingEventsCsv(tenantId);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="billing-${tenantId}.csv"`,
        )
        .code(200)
        .send(csv);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/super/tenants/:tenantId/plan
  //
  // Update a tenant's billing plan (tier + includedCredits).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Response 200: { tenant_id, tier, included_credits, previous, updatedAt, auditId }
  // Response 400: validation error (INVALID_TIER / INTERNAL_REQUIRES_NULL_CREDITS /
  //               FINITE_TIER_REQUIRES_CREDITS / INVALID_CREDITS)
  // Response 403: not super_admin
  // Response 404: tenant has no billing plan row
  //
  // Audit guarantee: the UPDATE and the audit_log INSERT are in the same
  // Postgres transaction via updateTenantPlan → auditInTx. If the audit
  // INSERT fails, the UPDATE rolls back. Atomicity is non-negotiable per
  // project CLAUDE.md hard rule (same pattern as ai-generate-mode).
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/super/tenants/:tenantId/plan',
    // Gate parity: superAdminOnly (session-MFA), intentionally the SAME gate
    // as PATCH .../ai-generate-mode above — both are super-admin per-tenant
    // config mutations (soft, reversible, auditInTx-atomic). Fresh-MFA
    // (superAdminFreshMfa) is reserved for tenant CREATION (POST /companies),
    // not config edits. Do not "upgrade" this to fresh-MFA without changing
    // ai-generate-mode too — they must stay consistent.
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      // Guard against a missing/null PATCH body (empty PATCH → no-op revalidate,
      // never a TypeError 500). Mirrors the ai-generate-mode `body?.` idiom.
      const body = parseBody(updatePlanBody, req.body, {
        code: { tier: 'INVALID_TIER', includedCredits: 'INVALID_CREDITS', aiAnswersIncludedOverride: 'INVALID_AI_ANSWERS_OVERRIDE' },
      });

      // Domain validation is fully delegated to updateTenantPlan.
      const patch: UpdateTenantPlanPatch = {};
      if (body.tier !== undefined) patch.tier = body.tier as PlanTier;
      if (body.includedCredits !== undefined) patch.includedCredits = body.includedCredits;
      if (body.aiAnswersIncludedOverride !== undefined) patch.aiAnswersIncludedOverride = body.aiAnswersIncludedOverride;

      const result = await updateTenantPlan(req.session!.userId, tenantId, patch);
      return reply.code(200).send(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/entitlements
  //
  // List all entitlements (active + revoked) for a tenant (super-admin view).
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Runs under assessiq_system (BYPASSRLS) via listTenantEntitlements which
  // internally uses withSystemTx — no app.current_tenant required.
  //
  // Response 200: { entitlements: TenantEntitlement[] }
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      const entitlements = await listTenantEntitlements(tenantId);
      return reply.code(200).send({ entitlements });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants/:tenantId/content-scopes
  //
  // Return the distinct domain labels and pack list for a tenant so the
  // billing drawer can offer a dropdown instead of a free-text scope_id input.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Runs under assessiq_system (BYPASSRLS) via listTenantContentScopes which
  // internally uses withSystemTx — no app.current_tenant required.
  //
  // Response 200: { domains: string[]; packs: Array<{ id, name, domain }> }
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants/:tenantId/content-scopes',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      const scopes = await listTenantContentScopes(tenantId);
      return reply.code(200).send(scopes);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/tenants/:tenantId/entitlements
  //
  // Grant a scope entitlement to a tenant.
  //
  // Gate: super_admin + totpVerified (superAdminOnly).
  //
  // Body: { scopeType: 'domain'|'pack', scopeId: string }
  //
  // Idempotent: re-granting an active entitlement updates granted_at/by;
  // re-granting a revoked row reactivates it.
  //
  // Audit guarantee: the INSERT/UPDATE and the audit_log INSERT are in the
  // same Postgres transaction via grantEntitlement → auditInTx. Atomicity
  // matches the A2 updateTenantPlan pattern.
  //
  // Response 200: { tenant_id, scope_type, scope_id, status: 'active', auditId }
  // Response 400: invalid scope (INVALID_SCOPE)
  // Response 403: not super_admin
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/super/tenants/:tenantId/entitlements',
    { preHandler: superAdminOnly },
    async (req, reply) => {
      const { tenantId } = parseParams(tenantIdParams, req.params);
      // Write-block guard: reject mutations on suspended/archived tenants.
      await assertTenantActive(tenantId);
      // Domain validation of the scope itself is delegated to grantEntitlement.
      const body = parseBody(entitlementScopeBody, req.body, { code: 'INVALID_SCOPE' });

      // PT-4: Starter licensed-pack cap. A re-grant of an already-active scope adds nothing.
      if (config.PLAN_TIERS_ENFORCED) {
        const active = (await listTenantEntitlements(tenantId)).filter((e) => e.status === 'active');
        if (!active.some((e) => e.scope_type === body.scopeType && e.scope_id === body.scopeId)) {
          await assertTierLimit(tenantId, 'licensed_packs', active.length);
        }
      }

      const result = await grantEntitlement(req.session!.userId, tenantId, {
        scopeType: body.scopeType as EntitlementScopeType,
        scopeId: body.scopeId,
      });
      return reply.code(200).send(result);
    },
  );

}
