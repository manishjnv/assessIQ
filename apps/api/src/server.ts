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
import { registerQuestionBankRoutes } from '@assessiq/question-bank';
import { registerAssessmentLifecycleRoutes } from '@assessiq/assessment-lifecycle';
import { registerAttemptCandidateRoutes, registerAttemptTakeRoutes } from '@assessiq/attempt-engine';
import { registerGradingRoutes } from '@assessiq/ai-grading';
import {
  registerHelpPublicRoutes,
  registerHelpAuthRoutes,
  registerHelpAdminRoutes,
  registerHelpTrackRoutes,
} from '@assessiq/help-system';
import { registerAdminWorkerRoutes } from './routes/admin-worker.js';
import { registerNotificationsRoutes } from '@assessiq/notifications';
import { registerScoringRoutes } from '@assessiq/scoring';
import { registerAnalyticsRoutes } from '@assessiq/analytics';
import { registerEmbedAdminRoutes } from './routes/embed-admin.js';
import { EMBED_COOKIE_NAME } from '@assessiq/embed-sdk';
import { authChain } from './middleware/auth-chain.js';
import { config } from '@assessiq/core';

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

  // aiq_embed_sess bridge — promotes the embed-session cookie value into the
  // standard session-loader slot when no standard session cookie is present.
  // This allows the shared session-loader middleware in auth-chain.ts to treat
  // embed sessions transparently without any per-route changes.
  //
  // Security: embed sessions carry role='candidate', so admin routes reject
  // them via requireAuth({roles:['admin']}). No privilege escalation is possible.
  app.addHook('onRequest', async (req) => {
    const embedCookie = (req.cookies as Record<string, string | undefined> | undefined)?.[EMBED_COOKIE_NAME];
    const stdCookie = (req.cookies as Record<string, string | undefined> | undefined)?.[config.SESSION_COOKIE_NAME];
    if (embedCookie !== undefined && stdCookie === undefined) {
      (req.cookies as Record<string, string | undefined>)[config.SESSION_COOKIE_NAME] = embedCookie;
    }
  });

  // Request context — populates AsyncLocalStorage for the lifetime of this
  // request so streamLogger() / childLogger() / getRequestContext() see the
  // correct correlation fields without each handler having to opt in.
  //
  // `req.assessiqCtx` aliases the same object that lives in ALS, so per-route
  // auth hooks (sessionLoaderMiddleware via auth-chain.ts) and the global
  // tenantContextMiddleware can mutate fields via the req reference and the
  // changes are visible to log mixin callers.
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
  // sessionLoader → apiKeyAuth → syncCtx → requireAuth → extendOnPass)
  // via apps/api/src/middleware/auth-chain.ts. Routes are config:{skipAuth:true}
  // (legacy convention preserved so any future global hook can opt out
  // uniformly), but the per-route chain is authoritative.
  await registerAuthRoutes(app);
  // Question-bank admin routes — same admin-gated authChain. The module
  // accepts the chain as an injected dep so the library stays Fastify-shape-
  // compatible without a hard apps/api import.
  await registerQuestionBankRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) });

  // Assessment-lifecycle admin routes — same admin-gated authChain DI shape.
  // Registers /api/admin/assessments/* and /api/admin/invitations/:id (DELETE).
  await registerAssessmentLifecycleRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) });

  // Attempt-engine candidate routes — registers /api/me/assessments and
  // /api/me/attempts/* under the candidate authChain. Admin-side attempt
  // routes (/api/admin/attempts/*) ship with module 07 in Phase 2.
  await registerAttemptCandidateRoutes(app, { candidateOnly: authChain({ roles: ['candidate'] }) });

  // Attempt-engine take routes — bare-root /take/:token magic-link surface.
  // Pre-auth (token IS the credential), so uses the public chain. Caddy must
  // forward /take/* to assessiq-api — see RCA 2026-05-02 § Caddy /help/* fix
  // for the additive-matcher procedure.
  await registerAttemptTakeRoutes(app, { publicChain: authChain({ requireSession: false }) });

  // AI grading admin routes — mounts /api/admin/{attempts,gradings,dashboard,grading-jobs,settings}/*
  // per docs/03-api-contract.md § Admin — Grading & review. Override requires
  // fresh MFA (5min) per D8. See modules/07-ai-grading/SKILL.md.
  await registerGradingRoutes(app, {
    adminOnly: authChain({ roles: ['admin'] }),
    adminFreshMfa: authChain({ roles: ['admin'], freshMfaWithinMinutes: 5 }),
  });

  // Help-system routes. Public + track are anonymous (no preHandler chain
  // needed; the global tenancy hook auto-skips when req.session is absent).
  // Auth + admin routes use DI authChain — the help-system package stays
  // framework-agnostic (no fastify dep) so apps/api passes its own factory.
  // Worker observability routes — queue stats + failed-job inspection + retry.
  await registerAdminWorkerRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) });

  // Notifications + webhooks routes (Phase 3 G3.B):
  //   - /api/admin/webhooks/* (admin-gated)
  //   - /api/admin/webhook-failures/* (admin-gated, convenience alias)
  //   - /api/admin/notifications (any-role — admin + reviewer)
  //   - /api/admin/notifications/:id/mark-read (any-role)
  // All routes are /api/admin/* prefix → covered by @api path /api/* Caddy matcher.
  await registerNotificationsRoutes(app, {
    adminOnly: authChain({ roles: ['admin'] }),
    anyRoleAuth: authChain({ roles: ['admin', 'reviewer'] }),
  });

  // Scoring admin routes — /api/admin/attempts/:id/score, /api/admin/reports/*
  // All /api/* prefix → Caddy @api matcher already covers these.
  await registerScoringRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) });

  // Analytics admin routes (Phase 3 G3.C):
  //   - /api/admin/reports/topic-heatmap
  //   - /api/admin/reports/archetype-distribution/:assessmentId
  //   - /api/admin/reports/cost-by-month
  //   - /api/admin/reports/exports/attempts.csv
  //   - /api/admin/reports/exports/attempts.jsonl
  //   - /api/admin/reports/exports/topic-heatmap.csv
  // All /api/admin/* → covered by Caddy @api matcher.
  await registerAnalyticsRoutes(app, { adminOnly: authChain({ roles: ['admin'] }) });

  // Embed admin routes (Phase 4 — module 12):
  //   GET    /api/admin/embed-origins
  //   POST   /api/admin/embed-origins
  //   DELETE /api/admin/embed-origins
  //   POST   /api/admin/webhook-secrets/rotate
  await registerEmbedAdminRoutes(app);

  await registerHelpPublicRoutes(app);
  await registerHelpTrackRoutes(app);
  // Cast through `unknown` to satisfy strictFunctionTypes parameter
  // contravariance: apps/api's authChain returns FastifyHook[] (req:
  // FastifyRequest), but the library's DI shape uses (req: unknown) to
  // avoid coupling. Param shapes overlap exactly on the fields the chain
  // reads (headers, cookies, session, apiKey, log), so the cast is sound.
  const authChainAdapter: Parameters<typeof registerHelpAuthRoutes>[1]['authChain'] =
    authChain as unknown as Parameters<typeof registerHelpAuthRoutes>[1]['authChain'];
  await registerHelpAuthRoutes(app, { authChain: authChainAdapter });
  await registerHelpAdminRoutes(app, { authChain: authChainAdapter });

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
