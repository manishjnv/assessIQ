// apps/api/src/routes/admin-tenant-settings.ts
//
// Tenant-admin routes for per-tenant settings the admin (DPDP data fiduciary)
// may change on their OWN tenant. Cross-tenant changes for a super-admin are
// handled separately under /api/admin/super/tenants/:tenantId/* via
// admin-super.ts.
//
// Exposes:
//   GET   /api/admin/tenant-settings                  — { result_release_mode, result_release_auto_since,
//                                                         retention_days, company_name }
//   PATCH /api/admin/tenant-settings/result-release-mode — body { mode: 'manual'|'auto' }  (SP2)
//   PATCH /api/admin/tenant-settings/result-feedback-level — body { level }  (RW-80)
//   PATCH /api/admin/tenant-settings/retention-days   — body { retention_days }
//   PATCH /api/admin/tenant                           — body { name }  (rename own company)
//   PUT   /api/admin/tenant-settings/logo             — multipart `file` or JSON { content_base64 }  (Logo L1)
//   DELETE /api/admin/tenant-settings/logo            — 204, also when no logo
//   POST  /api/admin/retention/run-now                — query ?dryRun=true
//
// Mutations gated on { roles: ['admin'], freshMfaWithinMinutes: 15 }. Super-admins
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
import { AuthzError, NotFoundError, ValidationError } from '@assessiq/core';
import {
  updateRetentionDays,
  updateResultReleaseMode,
  updateResultFeedbackLevel,
  updateCertificateShowDistinction,
  renameTenant,
  assertTenantActive,
  findTenantSettings,
  getTenantById,
  withTenant,
  setTenantLogo,
  removeTenantLogo,
  getTenantLogoMeta,
  tenantLogoUrl,
} from '@assessiq/tenancy';
import { readLogoUpload } from './_logo-upload.js';
import { runRetentionPurgeForTenant, listErasedCandidates } from '@assessiq/data-rights';
import { parseBody, parseQuery } from './_validate.js';
import { authChain } from '../middleware/auth-chain.js';
import { erasedCandidatesQuery, renameOwnTenantBody, resultReleaseModeBody, resultFeedbackLevelBody, certificateShowDistinctionBody, retentionDaysBody, runNowQuery } from './_schemas.js';

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
// Read-only admin chain — no freshMfa requirement. Used by GET endpoints
// that return existing audit-recorded state (no mutation, no irreversible
// action) such as the erased-candidates compliance list.
const adminReadOnly = authChain({
  roles: ['admin'],
});

// Plain admin gate (no fresh-MFA): renaming the display name is low-risk,
// audited, and does not touch slug / login / routing.
const adminOnly = authChain({ roles: ['admin'] });

const MAX_PER_TENANT_HARD_CAP = 5000;

export async function registerAdminTenantSettingsRoutes(
  app: FastifyInstance,
): Promise<void> {
  // PATCH /api/admin/tenant — tenant admin renames THEIR OWN company
  // (tenants.name, display only). Tenant is always session.tenantId; any
  // tenantId/slug in the body is ignored. Slug/id/status never touched.
  // UPDATE + one 'tenant.renamed' audit row commit in one tx (renameTenant).
  //
  // 200: { tenantId, name, previousName, auditId, noOp }
  // 400: MISSING_NAME | INVALID_NAME_CHARS | INVALID_NAME_LENGTH (2-120)
  // 403: caller not 'admin' (reviewer/candidate/super_admin)
  // 409: TENANT_NOT_ACTIVE (suspended/archived)
  app.patch('/api/admin/tenant', { preHandler: adminOnly }, async (req, reply) => {
    const session = req.session!;
    const body = parseBody(renameOwnTenantBody, req.body, { code: 'MISSING_NAME' });
    await assertTenantActive(session.tenantId);
    const result = await renameTenant(session.userId, session.tenantId, body.name);
    return reply.code(200).send(result);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/tenant-settings
  //
  // The caller's OWN tenant settings the admin settings page edits (tenant is
  // always session.tenantId). Read-only: no fresh-MFA gate.
  //
  // 200: { result_release_mode: 'manual'|'auto',
  //        result_release_auto_since: ISO | null,   // when it was switched to auto
  //        retention_days: number, company_name: string }
  // 403: caller not 'admin'   404: tenant has no tenant_settings row
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/tenant-settings', { preHandler: adminReadOnly }, async (req, reply) => {
    const session = req.session!;
    const settings = await withTenant(session.tenantId, (client) => findTenantSettings(client));
    if (settings === null) {
      throw new NotFoundError('Organisation settings not found for this organisation.');
    }
    const tenant = await getTenantById(session.tenantId);
    const logo = await getTenantLogoMeta(session.tenantId);
    return reply.code(200).send({
      result_release_mode: settings.result_release_mode,
      result_release_auto_since: settings.result_release_auto_since,
      result_feedback_level: settings.result_feedback_level,
      certificate_show_distinction: settings.certificate_show_distinction,
      retention_days: settings.retention_days,
      company_name: tenant.name,
      logo: logo === null ? null : { ...logo, url: tenantLogoUrl(session.tenantId, logo.sha256) },
    });
  });

  // PUT /api/admin/tenant-settings/logo - replace the caller's OWN tenant logo (Logo L1).
  // PNG/JPEG, 32-2048 px, max 512 KB. Tenant + actor come from the session only.
  // 200: { logo: { mime, width, height, byte_size, sha256, updated_at, url } }
  // 400: LOGO_BAD_FORMAT | LOGO_BAD_DIMENSIONS | LOGO_FILE_REQUIRED   413: LOGO_TOO_LARGE
  // 403: caller not 'admin' or fresh MFA expired   409: TENANT_NOT_ACTIVE
  app.put('/api/admin/tenant-settings/logo', { preHandler: adminFreshMfa }, async (req, reply) => {
    const session = req.session!;
    const data = await readLogoUpload(req);
    await assertTenantActive(session.tenantId);
    const meta = await setTenantLogo(session.tenantId, data, session.userId);
    return reply.code(200).send({ logo: { ...meta, url: tenantLogoUrl(session.tenantId, meta.sha256) } });
  });

  // DELETE /api/admin/tenant-settings/logo - 204 whether or not a logo existed.
  app.delete('/api/admin/tenant-settings/logo', { preHandler: adminFreshMfa }, async (req, reply) => {
    const session = req.session!;
    await assertTenantActive(session.tenantId);
    await removeTenantLogo(session.tenantId, session.userId);
    return reply.code(204).send();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PATCH /api/admin/tenant-settings/result-release-mode      (SP2, 2026-10-01)
  //
  // Choose how a finished result reaches the candidate:
  //   manual — hidden until an admin publishes it (default);
  //   auto   — published as soon as it is complete (worker sweep).
  // Only results that become ready AFTER switching to auto are released by the
  // sweep; switching never releases the results already waiting (the admin uses
  // "release all ready" for those). Same-mode request is a no-op (no audit).
  // Tenant + actor come from the session; the body only carries { mode }.
  //
  // 200: { tenantId, result_release_mode, previous, result_release_auto_since,
  //        updatedAt, auditId | null }
  // 400: INVALID_RESULT_RELEASE_MODE   409: TENANT_NOT_ACTIVE
  // 401: fresh TOTP required (requireAuth throws AuthnError "fresh totp required")
  // 403: caller not 'admin'
  // ──────────────────────────────────────────────────────────────────────────
  app.patch(
    '/api/admin/tenant-settings/result-release-mode',
    { preHandler: adminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const body = parseBody(resultReleaseModeBody, req.body, { code: 'INVALID_RESULT_RELEASE_MODE' });
      await assertTenantActive(session.tenantId);
      const result = await updateResultReleaseMode(session.userId, session.tenantId, body.mode);
      return reply.code(200).send({
        tenantId: result.tenantId,
        result_release_mode: result.result_release_mode,
        previous: result.previous,
        result_release_auto_since: result.result_release_auto_since,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );

  // PATCH /api/admin/tenant-settings/result-feedback-level   (RW-80)
  // How much per-question detail a candidate sees on a released result.
  // Body { level: 'none'|'right_wrong'|'with_expected_answer'|'with_ai_justification' }.
  // 200: { tenantId, result_feedback_level, previous, updatedAt, auditId | null }
  // 400: INVALID_RESULT_FEEDBACK_LEVEL   409: TENANT_NOT_ACTIVE   403: not admin / stale MFA
  app.patch(
    '/api/admin/tenant-settings/result-feedback-level',
    { preHandler: adminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const body = parseBody(resultFeedbackLevelBody, req.body, { code: 'INVALID_RESULT_FEEDBACK_LEVEL' });
      await assertTenantActive(session.tenantId);
      const result = await updateResultFeedbackLevel(session.userId, session.tenantId, body.level);
      return reply.code(200).send({
        tenantId: result.tenantId,
        result_feedback_level: result.result_feedback_level,
        previous: result.previous,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );

  // PATCH /api/admin/tenant-settings/certificate-show-distinction   (Z-50)
  // Show the word "Distinction" on certificates (stored tier is never changed).
  // Body { enabled: boolean }. Tenant + actor come from the session only.
  // 200: { tenantId, certificate_show_distinction, previous, updatedAt, auditId | null }
  // 400: INVALID_CERTIFICATE_SHOW_DISTINCTION   409: TENANT_NOT_ACTIVE
  // 403: not admin   401: fresh TOTP required
  app.patch(
    '/api/admin/tenant-settings/certificate-show-distinction',
    { preHandler: adminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      // Second check inside the handler: the chain already limits this route to admin.
      if (session.role !== 'admin') {
        throw new AuthzError('admin role required', { details: { code: 'ADMIN_REQUIRED' } });
      }
      const body = parseBody(certificateShowDistinctionBody, req.body, { code: 'INVALID_CERTIFICATE_SHOW_DISTINCTION' });
      await assertTenantActive(session.tenantId);
      const result = await updateCertificateShowDistinction(session.userId, session.tenantId, body.enabled);
      return reply.code(200).send({
        tenantId: result.tenantId,
        certificate_show_distinction: result.certificate_show_distinction,
        previous: result.previous,
        updatedAt: result.updatedAt,
        auditId: result.auditId,
      });
    },
  );

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
      const body = parseBody(retentionDaysBody, req.body, { code: 'MISSING_RETENTION_DAYS' });
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
      const q = parseQuery(runNowQuery, req.query) as { dryRun?: string; maxPerTenant?: string };
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

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/erased-candidates
  //
  // Compliance / operational visibility list of candidates in the caller's
  // tenant whose PII has been tombstoned (S3-display follow-up, 2026-05-30).
  // After S3-display hides erased candidates from /admin/users, this is the
  // single place an admin (DPDP data fiduciary) can see WHO has been erased,
  // WHEN, by WHICH admin, with what REASON, and the COUNT of preserved
  // attempts + certificates that survive the tombstone per D5 invariant.
  //
  // Read-only. No freshMfa. RLS-confined to caller's tenant via withTenant.
  //
  // Query:
  //   ?since=<iso>     — default: 365 days ago
  //   ?adminId=<uuid>  — filter to erasures performed by this admin
  //   ?limit=N         — 1..500, default 100
  //
  // 200: { items: ErasedCandidateRow[], total: number }
  // 400: INVALID_SINCE | INVALID_ADMIN_ID | INVALID_LIMIT
  // 403: caller not 'admin'
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/erased-candidates',
    { preHandler: adminReadOnly },
    async (req, reply) => {
      const session = req.session!;
      const q = parseQuery(erasedCandidatesQuery, req.query) as {
        since?: string;
        adminId?: string;
        limit?: string;
      };

      let since: string | undefined;
      if (q.since !== undefined && q.since !== '') {
        const t = Date.parse(q.since);
        if (Number.isNaN(t)) {
          throw new ValidationError('since must be a valid ISO-8601 timestamp', {
            details: { code: 'INVALID_SINCE', received: q.since },
          });
        }
        since = new Date(t).toISOString();
      }

      let adminId: string | null | undefined;
      if (q.adminId !== undefined && q.adminId !== '') {
        // Cheap UUID v4-ish guard. Service layer also takes uuid via $::uuid cast.
        if (!/^[0-9a-fA-F-]{36}$/.test(q.adminId)) {
          throw new ValidationError('adminId must be a UUID', {
            details: { code: 'INVALID_ADMIN_ID', received: q.adminId },
          });
        }
        adminId = q.adminId;
      }

      let limit: number | undefined;
      if (q.limit !== undefined && q.limit !== '') {
        const parsed = Number.parseInt(q.limit, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
          throw new ValidationError('limit must be an integer 1..500', {
            details: { code: 'INVALID_LIMIT', received: q.limit },
          });
        }
        limit = parsed;
      }

      const result = await listErasedCandidates(session.tenantId, {
        ...(since !== undefined ? { since } : {}),
        ...(adminId !== undefined ? { adminId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      return reply.code(200).send(result);
    },
  );
}
