import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { logger, AppError, uuidv7 } from '@assessiq/core';
import { tenantContextMiddleware } from '@assessiq/tenancy';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerInvitationRoutes } from './routes/invitations.js';
import { registerHealthRoutes } from './routes/health.js';
import { devAuthHook } from './middleware/dev-auth.js';

export async function buildServer() {
  const app = Fastify({
    logger: false,             // we use @assessiq/core logger via hooks below
    disableRequestLogging: true,
    trustProxy: true,          // Caddy/Cloudflare in front; CF-Connecting-IP is canonical
    genReqId: () => uuidv7(),
  });

  await app.register(cookie);

  // Request context — wraps every request in withRequestContext
  app.addHook('onRequest', async (req) => {
    // Hand off to AsyncLocalStorage so child code can call getRequestContext()
    // Note: Fastify's hook chain awaits async; we await `withRequestContext`
    // but the run-block must not return until the request completes. Pattern:
    // we set a per-request done-promise that resolves in onResponse.
    // Simpler approach: pre-populate the ALS in onRequest by stashing the
    // store on req, then inside route handlers call withRequestContext() lazily.
    // For Phase 0 we just attach the ctx to `req` and provide a small helper
    // that handlers can call. Avoids the await-around-handler trap.
    req.assessiqCtx = {
      requestId: String(req.id),
      // tenantId/userId populated by dev-auth hook below
      ip: (req.headers['cf-connecting-ip'] as string | undefined)
          ?? req.ip,
      ua: req.headers['user-agent'] ?? 'unknown',
    };
  });

  // Dev-only auth: read x-aiq-test-tenant + x-aiq-test-user-id + x-aiq-test-user-role,
  // populates req.session. Hard-fails in production (NODE_ENV === 'production').
  app.addHook('preHandler', devAuthHook);

  // Tenant context (RLS pin). Skips when req.session is absent (e.g. /health, /invitations/accept pre-auth).
  // 02-tenancy is structurally typed against minimal TenantRequest/TenantReply shapes
  // (no hard fastify dep) — bridge via Parameters<> rather than deep-import unexposed types.
  const tenancy = tenantContextMiddleware();
  type TReq = Parameters<typeof tenancy.preHandler>[0];
  type TRep = Parameters<typeof tenancy.preHandler>[1];
  app.addHook('preHandler', async (req, reply) => {
    if (req.session?.tenantId !== undefined) {
      await tenancy.preHandler(req as unknown as TReq, reply as unknown as TRep);
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.db !== undefined) {
      await tenancy.onResponse(req as unknown as TReq, reply as unknown as TRep);
    }
  });

  // Centralized error mapping
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      const status = (err.details?.['httpStatus'] as number | undefined) ?? err.status;
      reply.code(status).send({ error: err.toJson() });
      return;
    }
    // Fastify validation errors (schema fail) come with `err.validation` set and
    // statusCode=400. Map to a normalized error envelope without leaking 500.
    const fastifyErr = err as { validation?: unknown; statusCode?: number; code?: string; message?: string };
    if (Array.isArray(fastifyErr.validation)) {
      reply.code(fastifyErr.statusCode ?? 400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: fastifyErr.message ?? 'request validation failed',
          details: { validation: fastifyErr.validation },
        },
      });
      return;
    }
    // Any other Fastify-thrown error with an explicit 4xx statusCode (e.g. 415
    // Content-Type parser, 413 payload-too-large) — preserve the status.
    if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      reply.code(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? `HTTP_${fastifyErr.statusCode}`,
          message: fastifyErr.message ?? 'request error',
        },
      });
      return;
    }
    logger.error({ err }, 'unhandled error');
    reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  await registerHealthRoutes(app);
  await registerAdminUserRoutes(app);
  await registerInvitationRoutes(app);

  return app;
}

// CLI entrypoint
const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (isCliEntry) {
  const app = await buildServer();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'assessiq-api listening');
}
