// apps/api/src/routes/admin-tenant-settings.ts
//
// Tenant-admin routes for per-tenant settings the admin (DPDP data fiduciary)
// may change on their OWN tenant. Cross-tenant changes for a super-admin are
// handled separately under /api/admin/super/tenants/:tenantId/* via
// admin-super.ts.
//
// Currently exposes the Module 20 S5 surface only:
//   PATCH /api/admin/tenant-settings/retention-days   — body { retention_days }
//   POST  /api/admin/retention/run-now                — query ?dryRun=true
//
// Both gated on { roles: ['admin'], freshMfaWithinMinutes: 15 }. Super-admins
// hit /api/admin/super/* instead (this route file does NOT accept super_admin
// because a super-admin does not have a single tenantId to act on — they must
// target one explicitly via the /super/ prefix).
//
// Audit guarantees (mirror admin-super.ts):
//   - retention_days UPDATE + audit row commit in the same withTenant tx
//     (via 02-tenancy updateRetentionDays + auditInTx).
//   - retention run emits 'system.dsr.retention.run' (per-tenant summary) and,
//     for each erased candidate, the existing 'user.pii.erased'. The forensic
//     chain joins on tenantId + at.

import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@assessiq/core';
import { updateRetentionDays } from '@assessiq/tenancy';
import { runRetentionPurgeForTenant } from '@assessiq/data-rights';
import { authChain } from '../middleware/auth-chain.js';

// ---------------------------------------------------------------------------
// Auth chain — tenant admin only, fresh MFA within 15 minutes.
// ---------------------------------------------------------------------------
//
// `roles: ['admin']` deliberately excludes super_admin. Super-admins acting
// on a specific tenant route through /api/admin/super/tenants/:tenantId/* so
// the cross-tenant intent is explicit in the URL + access logs.
//
// Two MFA-freshness windows (Sonnet-takeover adversarial review V6,
// 2026-05-30): config-only mutations get 15 minutes; immediately-destructive
// bulk-PII operations get 5 minutes. A stolen session token that authenticated
// MFA 14 minutes ago should NOT be able to trigger mass irreversible erasure.
const adminFreshMfa = authChain({
  roles: ['admin'],
  freshMfaWithinMinutes: 15,
});
const adminFreshMfaStrict = authChain({
  roles: ['admin'],
  freshMfaWithinMinutes: 5,
});

const MAX_PER_TENANT_HARD_CAP = 5000;

export async function registerAdminTenantSettingsRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/tenant-settings/retention-days
  //
  // Set the per-tenant DPDP / GDPR candidate-data retention window in DAYS.
  // The next nightly retention cron tick (dsr-retention-cron at 03:00 UTC)
  // uses the new value. Range 1–3650 enforced both at the SQL level and in
  // the service.
  //
  // 200: { tenantId, retention_days, previous, updatedAt, auditId }
  // 400: INVALID_RETENTION_DAYS | RETENTION_DAYS_OUT_OF_RANGE
  // 403: caller not 'admin' OR fresh MFA expired (authChain → 403)
  // 404: tenant has no tenant_settings row
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/tenant-settings/retention-days',
    { preHandler: adminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const body = (req.body ?? {}) as { retention_days?: unknown };
      if (typeof body.retention_days !== 'number') {
        throw new ValidationError('retention_days is required', {
          details: { code: 'MISSING_RETENTION_DAYS' },
        });
      }
      const result = await updateRetentionDays(
        session.userId,
        session.tenantId,
        body.retention_days,
      );
      return reply.code(200).send({
        tenantId: result.tenantId,
        retention_days: result.retention_days,
        previous: result.previous,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/retention/run-now
  //
  // Manual retention purge for the caller's tenant. The nightly cron at 03:00
  // UTC runs this automatically across every active tenant; this endpoint
  // exists for ad-hoc admin triggers (e.g. after lowering retention_days, to
  // immediately tombstone the newly-expired candidates without waiting).
  //
  // Query:
  //   ?dryRun=true   — scan and report; do NOT erase. The forensic chain still
  //                    records a 'system.dsr.retention.run' row with
  //                    dryRun:true so the intent is observable.
  //   ?maxPerTenant=N — override the default 500 hard cap. Hard-capped at
  //                    5000 in this route regardless of input.
  //
  // 200: { tenantId, retentionDays, candidatesScanned, candidatesErased,
  //        candidatesSkipped, errors: [], dryRun, durationMs }
  // 403: caller not 'admin' OR fresh MFA expired
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/retention/run-now',
    { preHandler: adminFreshMfaStrict },
    async (req, reply) => {
      const session = req.session!;
      const q = (req.query ?? {}) as { dryRun?: string; maxPerTenant?: string };
      const dryRun = q.dryRun === 'true' || q.dryRun === '1';

      let maxPerTenant: number | undefined;
      if (q.maxPerTenant !== undefined) {
        // Sonnet-takeover adversarial review V4 (2026-05-30): the service
        // treats maxPerTenant=0 as UNLIMITED (no LIMIT clause). Accepting `0`
        // at the route would bypass the MAX_PER_TENANT_HARD_CAP since
        // Math.min(0, 5000) = 0. Require strictly positive integers here so
        // the route cap is unbypassable. The 0-as-unlimited semantic remains
        // available for internal ops callers that invoke
        // runRetentionPurgeForTenant directly.
        const parsed = Number.parseInt(q.maxPerTenant, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new ValidationError('maxPerTenant must be a positive integer', {
            details: { code: 'INVALID_MAX_PER_TENANT', received: q.maxPerTenant },
          });
        }
        maxPerTenant = Math.min(parsed, MAX_PER_TENANT_HARD_CAP);
      }

      const report = await runRetentionPurgeForTenant(session.tenantId, {
        dryRun,
        ...(maxPerTenant !== undefined ? { maxPerTenant } : {}),
      });

      return reply.code(200).send(report);
    },
  );
}
