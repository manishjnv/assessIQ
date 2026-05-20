// AssessIQ — modules/18-certification/src/routes.ts
//
// Fastify route layer for the certification module.
//
// Routes:
//   CANDIDATE-FACING (authenticated, any role):
//     GET  /api/certificates/:credentialId/pdf        → download PDF
//     GET  /api/certificates                          → list my certs (Session 5)
//     POST /api/certificates/:credentialId/share-linkedin → counter (Session 8)
//
//   ADMIN-FACING (authenticated, admin scope + tenant-context middleware):
//     GET  /api/admin/certificates                    → list all (Session 2)
//     POST /api/admin/certificates/:id/revoke         → revoke (Session 2)
//     POST /api/admin/certificates/:id/reissue        → re-snapshot (Session 6)
//
// CLAUDE.md multi-tenancy rule #4: all admin endpoints MUST register
//   tenant-context middleware. The adminAuth hook enforces this.
//
// INVARIANT: NEVER import from @anthropic-ai, claude, or any AI SDK.
// CLAUDE.md rule #1.

import type { FastifyInstance, FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';

import { ValidationError } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';

import { getCertSigningSecret, verifyCertificateSignature } from './crypto.js';
import { renderCertificatePdf } from './pdf/render.js';
import { findByCredentialId, incrementCounter } from './repository.js';
import {
  adminListCertificates,
  incrementShareCount,
  listForUser,
  reissue,
  revoke,
} from './service.js';
import {
  CertificateAccessDeniedError,
  CertificateAlreadyRevokedError,
  CertificateNotFoundError,
  CertificateRevokedException,
  CREDENTIAL_ID_REGEX,
  CredentialIdSchema,
  ListCertificatesQuerySchema,
  ReissueCertificateInputSchema,
  RevokeCertificateInputSchema,
} from './types.js';

// ---------------------------------------------------------------------------
// Hook type
// ---------------------------------------------------------------------------

// Structural shape shared with apps/api's authChain() return type.
// Compatible with preHandlerAsyncHookHandler at the call sites below.
type CertHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Session shape (attached by the auth chain's requireAuth hook)
// ---------------------------------------------------------------------------

interface SessionInfo {
  userId: string;
  tenantId: string;
  role: string;
  totpVerified: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Caller (apps/api/src/server.ts) supplies Fastify preHandler hook arrays.
 * Both are produced by authChain() from apps/api/src/middleware/auth-chain.ts.
 *
 * candidateAuth — any authenticated session (admin, candidate, reviewer).
 *   Use for /api/certificates/* candidate-facing endpoints.
 *
 * adminAuth — admin/super_admin role + tenant-context middleware.
 *   Use for /api/admin/certificates/* endpoints.
 *   CLAUDE.md rule #4: no admin endpoint without this.
 */
export interface RegisterCertificationRoutesOptions {
  candidateAuth: CertHook[];
  adminAuth: CertHook[];
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerCertificationRoutes(
  app: FastifyInstance,
  opts: RegisterCertificationRoutesOptions,
): Promise<void> {
  // Cast to preHandlerHookHandler[] — the hooks are structurally compatible
  // (async, same (req, reply) signature). Fastify accepts async hooks without
  // the `done` parameter when TypeScript strict-mode variance conflicts arise.
  const candidatePreHandler = opts.candidateAuth as unknown as preHandlerHookHandler[];
  const adminPreHandler = opts.adminAuth as unknown as preHandlerHookHandler[];

  // -------------------------------------------------------------------------
  // GET /api/certificates/:credentialId/pdf — download PDF (Session 4)
  // -------------------------------------------------------------------------

  app.get<{ Params: { credentialId: string } }>(
    '/api/certificates/:credentialId/pdf',
    { preHandler: candidatePreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const rawId = req.params.credentialId;
      const credentialId = rawId.toUpperCase();

      // Reject malformed IDs before touching the DB.
      if (!CREDENTIAL_ID_REGEX.test(credentialId)) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      const cert = await withTenant(session.tenantId, (client) =>
        findByCredentialId(client, credentialId, session.tenantId),
      );

      if (cert === null) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      // Owner check: candidate may only download their own cert.
      // Admin and super_admin may download any cert within their tenant.
      if (
        cert.candidate_id !== session.userId &&
        session.role !== 'admin' &&
        session.role !== 'super_admin'
      ) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      // Revoked cert: 410 Gone (not 404 — the credential existed).
      if (cert.revoked_at !== null) {
        return reply.code(410).send({ error: 'Gone' });
      }

      // HMAC integrity check — return 500 (not 200 with a broken PDF) if the
      // row has been tampered with outside the application. plan §15 trap #1.
      const secret = getCertSigningSecret();
      const valid = verifyCertificateSignature(
        {
          id: cert.id,
          tenant_id: cert.tenant_id,
          attempt_id: cert.attempt_id,
          candidate_id: cert.candidate_id,
          template_key: cert.template_key,
          credential_id: cert.credential_id,
          tier: cert.tier,
          display_name: cert.display_name,
          course_title: cert.course_title,
          level: cert.level,
          issued_at: cert.issued_at,
        },
        cert.signed_hash,
        secret,
      );
      if (!valid) {
        return reply.code(500).send({ error: 'Internal Server Error' });
      }

      const pdfBuf = await renderCertificatePdf(cert);

      // Increment pdf_downloads. Non-critical analytics; errors are caught and
      // swallowed so a counter failure never breaks a successful download.
      await withTenant(session.tenantId, (client) =>
        incrementCounter(client, cert.id, 'pdf_downloads'),
      ).catch(() => {});

      return reply
        .code(200)
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${credentialId}.pdf"`)
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(pdfBuf);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/certificates — list my certs (Session 5)
  // -------------------------------------------------------------------------

  app.get(
    '/api/certificates',
    { preHandler: candidatePreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) return reply.code(401).send({ error: 'Unauthorized' });
      const result = await listForUser(session.tenantId, session.userId);
      return reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/certificates/:credentialId/share-linkedin (Session 8)
  // -------------------------------------------------------------------------

  app.post(
    '/api/certificates/:credentialId/share-linkedin',
    { preHandler: candidatePreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) return reply.code(401).send({ error: 'Unauthorized' });

      const parsed = CredentialIdSchema.safeParse(
        (req.params as { credentialId: string }).credentialId?.toUpperCase(),
      );
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'INVALID_CREDENTIAL_ID', message: 'Invalid credential_id format' } });
      }
      const credentialId = parsed.data;

      try {
        await incrementShareCount(session.tenantId, credentialId, session.userId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof CertificateNotFoundError) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: (err as Error).message } });
        }
        if (err instanceof CertificateAccessDeniedError) {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: (err as Error).message } });
        }
        if (err instanceof CertificateRevokedException) {
          return reply.code(410).send({ error: { code: 'REVOKED', message: (err as Error).message } });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Admin routes (admin scope + tenant context — CLAUDE.md rule #4)
  // -------------------------------------------------------------------------

  app.get(
    '/api/admin/certificates',
    { preHandler: adminPreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) return reply.code(401).send({ error: 'Unauthorized' });
      const queryParsed = ListCertificatesQuerySchema.safeParse(req.query);
      if (!queryParsed.success) {
        throw new ValidationError(queryParsed.error.errors[0]?.message ?? 'invalid query');
      }
      const result = await adminListCertificates(session.tenantId, queryParsed.data);
      return reply.send(result);
    },
  );

  app.post<{ Params: { credentialId: string } }>(
    '/api/admin/certificates/:credentialId/revoke',
    { preHandler: adminPreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) return reply.code(401).send({ error: 'Unauthorized' });
      const bodyParsed = RevokeCertificateInputSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new ValidationError(bodyParsed.error.errors[0]?.message ?? 'invalid body');
      }
      try {
        const updated = await revoke(
          session.tenantId,
          req.params.credentialId,
          bodyParsed.data.revoke_reason,
          session.userId,
        );
        return reply.send(updated);
      } catch (err) {
        if (err instanceof CertificateNotFoundError) {
          return reply.code(404).send({ error: 'Certificate not found' });
        }
        if (err instanceof CertificateAlreadyRevokedError) {
          return reply.code(409).send({ error: 'Certificate is already revoked', message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { credentialId: string } }>(
    '/api/admin/certificates/:credentialId/reissue',
    { preHandler: adminPreHandler },
    async (req, reply) => {
      const session = (req as unknown as { session?: SessionInfo }).session;
      if (!session) return reply.code(401).send({ error: 'Unauthorized' });
      const bodyParsed = ReissueCertificateInputSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        throw new ValidationError(bodyParsed.error.errors[0]?.message ?? 'invalid body');
      }
      try {
        const updated = await reissue(
          session.tenantId,
          req.params.credentialId,
          bodyParsed.data.display_name,
          session.userId,
        );
        return reply.send(updated);
      } catch (err) {
        if (err instanceof CertificateNotFoundError) {
          return reply.code(404).send({ error: 'Certificate not found' });
        }
        if (err instanceof CertificateRevokedException) {
          return reply.code(410).send({ error: 'Revoked certificate cannot be reissued' });
        }
        throw err;
      }
    },
  );
}
