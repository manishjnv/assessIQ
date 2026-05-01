import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  AppError,
  enterWithRequestContext,
  streamLogger,
  uuidv7,
} from '@assessiq/core';
import { tenantContextMiddleware } from '@assessiq/tenancy';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerInvitationRoutes } from './routes/invitations.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLogIngestRoutes } from './routes/_log.js';
import { registerAuthRoutes } from './routes/auth/index.js';
import { devAuthHook } from './middleware/dev-auth.js';

const requestLog = streamLogger('request');
const appLog = streamLogger('app');

export async function buildServer() {
  const app = Fastify({
    logger: false,             // we use @assessiq/core logger via hooks below
    disableRequestLogging: true,
    trustProxy: true,          // Caddy/Cloudflare in front; CF-Connecting-IP is canonical
    genReqId: () => uuidv7(),
  });

  await app.register(cookie);

  // Request context — populates AsyncLocalStorage for the lifetime of this
  // request so streamLogger() / childLogger() / getRequestContext() see the
  // correct correlation fields without each handler having to opt in.
  //
  // `req.assessiqCtx` aliases the same object that lives in ALS, so existing
  // hooks (devAuthHook, tenantContextMiddleware) can still mutate fields via
  // the req reference and the changes are visible to log mixin callers.
  app.addHook('onRequest', async (req) => {
    const ctx = {
      requestId: String(req.id),
      // tenantId/userId populated by dev-auth + tenant hooks below
      ip: (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip,
      ua: req.headers['user-agent'] ?? 'unknown',
    };
    req.assessiqCtx = ctx;
    enterWithRequestContext(ctx);
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
    appLog.error({ err }, 'unhandled error');
    reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  // One structured line per HTTP response → request.log.
  // Mixin auto-attaches requestId/tenantId/userId from ALS.
  app.addHook('onResponse', async (req, reply) => {
    requestLog.info(
      {
        method: req.method,
        url: req.url,
        route: req.routeOptions?.url,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        ip: (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip,
        ua: req.headers['user-agent'] ?? 'unknown',
      },
      'http.request',
    );
  });

  await registerHealthRoutes(app);
  await registerLogIngestRoutes(app);
  await registerAdminUserRoutes(app);
  await registerInvitationRoutes(app);
  // Auth routes install their own per-route preHandler chain (rateLimit →
  // sessionLoader → apiKeyAuth → syncCtx → requireAuth → extendOnPass).
  // All auth routes are config:{skipAuth:true} so the legacy global
  // devAuthHook short-circuits — Commit B (the dev-auth shim deletion +
  // global chain swap) is a follow-on refactor.
  await registerAuthRoutes(app);

  return app;
}

// CLI entrypoint
const isCliEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (isCliEntry) {
  const app = await buildServer();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ host: '0.0.0.0', port });
  appLog.info({ port }, 'assessiq-api listening');
}
