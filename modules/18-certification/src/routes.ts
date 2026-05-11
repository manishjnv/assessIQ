// AssessIQ — modules/18-certification/src/routes.ts
//
// Phase 5 Session 1 — Fastify route stubs for the certification module.
//
// Planned routes (all return 501 Not Implemented in this session):
//
//   CANDIDATE-FACING (authenticated, candidate scope):
//     GET  /api/certificates                          → list my certificates
//     GET  /api/certificates/:credentialId/pdf        → download PDF (410 if revoked)
//     POST /api/certificates/:credentialId/share-linkedin → increment counter, 204
//
//   ADMIN-FACING (authenticated, admin scope, tenant-context middleware required):
//     GET  /api/admin/certificates                    → list all (paginated, filterable)
//     POST /api/admin/certificates/:id/revoke         → revoke with reason
//     POST /api/admin/certificates/:id/reissue        → re-snapshot display_name + re-sign
//
//   PUBLIC (no auth — recruiter verify page served by frontend, not here):
//     (verify page is a frontend route; its data endpoint is Phase 5 Session 3)
//
// CLAUDE.md multi-tenancy rule #4: all admin endpoints MUST register
//   tenant-context middleware. The preHandler hook below enforces this.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@assessiq/core';
import {
  issueCertificate,
  getByCredentialId,
  listForUser,
  adminListCertificates,
  revoke,
  reissue,
} from './service.js';
import {
  CredentialIdSchema,
  ListCertificatesQuerySchema,
  RevokeCertificateInputSchema,
} from './types.js';

export interface RegisterCertificationRoutesOptions {
  /**
   * Fastify preHandler hook that sets the tenant GUC on the DB connection
   * (app.current_tenant) and attaches req.tenantId. Required for all admin
   * routes. Provided by 02-tenancy. CLAUDE.md rule #4: no admin endpoint
   * without this middleware.
   */
  requireTenantContext: preHandlerHookHandler;

  /**
   * Fastify preHandler hook that validates the session and attaches
   * req.session (userId, role). Required for all authenticated routes.
   * Provided by 01-auth.
   */
  requireAuth: preHandlerHookHandler;
}

/**
 * Register all certification routes on the Fastify instance.
 * All routes return 501 Not Implemented until Phase 5 Session 2+.
 */
export async function registerCertificationRoutes(
  app: FastifyInstance,
  opts: RegisterCertificationRoutesOptions,
): Promise<void> {
  const { requireAuth, requireTenantContext } = opts;

  // -------------------------------------------------------------------------
  // Candidate-facing routes (authenticated)
  // -------------------------------------------------------------------------

  /**
   * GET /api/certificates
   * List certificates belonging to the authenticated candidate.
   * Phase 5 Session 5 target.
   */
  app.get(
    '/api/certificates',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      void listForUser; // TODO(Phase5-S5): call service
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'GET /api/certificates — Phase 5 Session 5',
      });
    },
  );

  /**
   * GET /api/certificates/:credentialId/pdf
   * Download the PDF for the given credential.
   * 410 Gone if revoked. 404 if not found or not owned by caller.
   * Phase 5 Session 3 target.
   */
  app.get(
    '/api/certificates/:credentialId/pdf',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = CredentialIdSchema.safeParse(
        (req.params as { credentialId: string }).credentialId?.toUpperCase(),
      );
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0]?.message ?? 'invalid credential_id');
      }
      void getByCredentialId; // TODO(Phase5-S3): fetch + stream PDF
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'GET /api/certificates/:credentialId/pdf — Phase 5 Session 3',
      });
    },
  );

  /**
   * POST /api/certificates/:credentialId/share-linkedin
   * Increment linkedin_shares counter. Returns 204 No Content.
   * Fire-and-forget from the frontend before opening LinkedIn share URL.
   * Phase 5 Session 8 target.
   */
  app.post(
    '/api/certificates/:credentialId/share-linkedin',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = CredentialIdSchema.safeParse(
        (req.params as { credentialId: string }).credentialId?.toUpperCase(),
      );
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0]?.message ?? 'invalid credential_id');
      }
      void issueCertificate; // placeholder reference
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'POST /api/certificates/:credentialId/share-linkedin — Phase 5 Session 8',
      });
    },
  );

  // -------------------------------------------------------------------------
  // Admin routes (authenticated + tenant-context middleware — CLAUDE.md rule #4)
  // -------------------------------------------------------------------------

  /**
   * GET /api/admin/certificates
   * List all certificates for the calling tenant (paginated, filterable).
   * Query params: candidate_id?, tier?, revoked?, limit, offset.
   * Phase 5 Session 2 target.
   */
  app.get(
    '/api/admin/certificates',
    { preHandler: [requireAuth, requireTenantContext] },
    async (req, reply) => {
      const queryParsed = ListCertificatesQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new ValidationError(queryParsed.error.errors[0]?.message ?? 'invalid query');
      }
      void adminListCertificates; // TODO(Phase5-S2): call service
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'GET /api/admin/certificates — Phase 5 Session 2',
      });
    },
  );

  /**
   * POST /api/admin/certificates/:id/revoke
   * Revoke a certificate. Body: { reason: string }.
   * Phase 5 Session 2 target.
   */
  app.post(
    '/api/admin/certificates/:id/revoke',
    { preHandler: [requireAuth, requireTenantContext] },
    async (req, reply) => {
      const bodyParsed = RevokeCertificateInputSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new ValidationError(bodyParsed.error.errors[0]?.message ?? 'invalid body');
      }
      void revoke; // TODO(Phase5-S2): call service
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'POST /api/admin/certificates/:id/revoke — Phase 5 Session 2',
      });
    },
  );

  /**
   * POST /api/admin/certificates/:id/reissue
   * Re-snapshot display_name + re-sign. Does NOT rotate credential_id or
   * issued_at (would break shared LinkedIn URLs).
   * Phase 5 Session 6 target.
   */
  app.post(
    '/api/admin/certificates/:id/reissue',
    { preHandler: [requireAuth, requireTenantContext] },
    async (req, reply) => {
      void reissue; // TODO(Phase5-S6): call service
      return reply.status(501).send({
        statusCode: 501,
        error: 'Not Implemented',
        message: 'POST /api/admin/certificates/:id/reissue — Phase 5 Session 6',
      });
    },
  );
}
