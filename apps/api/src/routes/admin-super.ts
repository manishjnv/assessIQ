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
import { ValidationError, streamLogger } from '@assessiq/core';
import { updateAiGenerateMode, createTenant, activateTenant, getPool } from '@assessiq/tenancy';
import { inviteUser } from '@assessiq/users';
import { audit } from '@assessiq/audit-log';
import { seedTenantTaxonomy } from '@assessiq/question-bank';
import { authChain } from '../middleware/auth-chain.js';

const log = streamLogger('app');

// ---------------------------------------------------------------------------
// Auth chains
// ---------------------------------------------------------------------------

// Gate: session must exist AND role must be 'super_admin'.
// requireAuth in require-auth.ts enforces totpVerified=true for super_admin
// unconditionally (MFA_REQUIRED override — see require-auth.ts).
const superAdminOnly = authChain({ roles: ['super_admin'] });

// Fresh-MFA gate for mutating operations: TOTP must have occurred within 15min.
// This is in addition to the always-on totpVerified=true check above.
const superAdminFreshMfa = authChain({
  roles: ['super_admin'],
  freshMfaWithinMinutes: 15,
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminSuperRoutes(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
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
  // ──────────────────────────────────────────────────────────────────────────
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

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/admin/super/companies
  //
  // Create a new company tenant, seed its taxonomy, and invite the first admin.
  //
  // Gate: super_admin + fresh MFA (15-minute window).
  //
  // Orchestration (soft-create pattern):
  //   1. createTenant (C2) → status='provisioning'
  //   2. seedTenantTaxonomy (C5) — idempotent, withTenant(newTenantId)
  //   3. inviteUser (03-users) — withTenant(newTenantId)
  //   4. activateTenant → status='active'
  //   5. audit tenant.created
  //
  // Failure: any step after #1 fails → tenant stays 'provisioning';
  // audit tenant.create_incomplete is written; actionable error returned.
  // No half-live 'active' tenant ever exists.
  //
  // Cross-tenant safety: steps 2 + 3 use explicit withTenant(newTenantId)
  // — NEVER the super-admin's platform tenantId. activateTenant uses the
  // system-role path (same as createTenant) so no app.current_tenant confusion.
  //
  // Response 201: { tenantId, slug, name, status, invitation }
  // Response 409: slug collision (TENANT_SLUG_CONFLICT)
  // Response 400: validation error
  // Response 403: not super_admin / MFA too old
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/admin/super/companies',
    { preHandler: superAdminFreshMfa },
    async (req, reply) => {
      const session = req.session!;
      const body = req.body as {
        name?: unknown;
        slug?: unknown;
        domain?: unknown;
        adminEmail?: unknown;
        adminName?: unknown;
      };

      // Validate required fields.
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('name is required', { details: { code: 'MISSING_NAME' } });
      }
      if (typeof body.slug !== 'string' || !/^[a-z0-9-]+$/.test(body.slug.trim())) {
        throw new ValidationError(
          'slug is required and must be lowercase alphanumeric with hyphens',
          { details: { code: 'INVALID_SLUG' } },
        );
      }
      if (typeof body.adminEmail !== 'string' || !body.adminEmail.includes('@')) {
        throw new ValidationError('adminEmail is required', { details: { code: 'MISSING_ADMIN_EMAIL' } });
      }

      const name = body.name.trim();
      const slug = body.slug.trim();
      const domain = typeof body.domain === 'string' && body.domain.trim().length > 0
        ? body.domain.trim()
        : undefined;
      const adminEmail = body.adminEmail.trim();
      const adminName = typeof body.adminName === 'string' ? body.adminName.trim() : undefined;

      log.info({ slug, name, adminEmail }, 'createCompany: starting');

      // Step 1: createTenant — status='provisioning'. Slug collision → 409.
      const tenantInput: import('@assessiq/tenancy').CreateTenantInput = { name, slug };
      if (domain !== undefined) tenantInput.domain = domain;
      const { tenantId } = await createTenant(tenantInput, session.userId);

      log.info({ tenantId, slug }, 'createCompany: tenant provisioned');

      // Steps 2–3 may fail; catch and leave tenant 'provisioning' with audit.
      let invitation: { id: string; email: string; role: string; expires_at: Date } | null = null;
      try {
        // Step 2: seedTenantTaxonomy — idempotent; withTenant(newTenantId) inside.
        // Cross-tenant safety: seed function scopes all writes to newTenantId.
        await seedTenantTaxonomy(tenantId);
        log.info({ tenantId }, 'createCompany: taxonomy seeded');

        // Step 3: inviteUser — withTenant(newTenantId) inside invitations.ts.
        // Cross-tenant safety: inviteUser scopes all writes to newTenantId.
        const inviteResult = await inviteUser(tenantId, {
          email: adminEmail,
          role: 'admin',
          invited_by: session.userId,
          // adminName is not part of InviteUserInput but invitations.ts sets
          // name=email as placeholder; Phase 1 admin updates after accept.
        });
        invitation = inviteResult.invitation;

        log.info({ tenantId, adminEmail }, 'createCompany: admin invited');
      } catch (err) {
        // Failure after provisioning: leave 'provisioning', audit, surface error.
        log.warn({ tenantId, err }, 'createCompany: post-provisioning step failed; tenant stays provisioning');

        // Write audit event — use platform tenant context for the super-admin's audit row.
        // The new tenant's audit is not yet writable (it hasn't been activated).
        await audit({
          tenantId: session.tenantId,
          actorKind: 'user',
          actorUserId: session.userId,
          action: 'tenant.create_incomplete',
          entityType: 'tenant',
          entityId: tenantId,
          after: {
            slug,
            name,
            status: 'provisioning',
            reason: err instanceof Error ? err.message : String(err),
          },
        });

        // Rethrow so Fastify converts to the appropriate HTTP error.
        throw err;
      }

      // Step 4: flip tenant to 'active' — only reached when steps 2+3 both succeeded.
      await activateTenant(tenantId);
      log.info({ tenantId }, 'createCompany: tenant activated');

      // Step 5: audit tenant.created in the platform tenant context.
      await audit({
        tenantId: session.tenantId,
        actorKind: 'user',
        actorUserId: session.userId,
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenantId,
        after: {
          slug,
          name,
          domain: domain ?? null,
          status: 'active',
          adminEmail,
          invitationId: invitation?.id ?? null,
        },
      });

      return reply.code(201).send({
        tenantId,
        slug,
        name,
        status: 'active',
        invitation,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/admin/super/tenants
  //
  // List all tenants (system-role read). Returns slug/name/status/created_at.
  // Provides operational visibility for the super-admin without exposing
  // tenant-internal data.
  //
  // Gate: super_admin + totpVerified (enforced by superAdminOnly chain).
  //
  // Response 200: { tenants: Array<{ id, slug, name, status, created_at }> }
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/super/tenants',
    { preHandler: superAdminOnly },
    async (_req, reply) => {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE assessiq_system');
        const result = await client.query<{
          id: string;
          slug: string;
          name: string;
          status: string;
          created_at: Date;
        }>(
          `SELECT id, slug, name, status, created_at
           FROM tenants
           ORDER BY created_at ASC`,
        );
        await client.query('COMMIT');

        return reply.code(200).send({ tenants: result.rows });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
