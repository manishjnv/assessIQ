import type { FastifyInstance } from 'fastify';
import { AppError, AuthnError, ValidationError } from '@assessiq/core';
import { config } from '@assessiq/core';
import { verifyEmbedToken, mintEmbedToken } from '@assessiq/auth';
import {
  getEmbedOrigins,
  buildEmbedCsp,
  mintEmbedSession,
  resolveJitUser,
  EMBED_COOKIE_NAME,
} from '@assessiq/embed-sdk';
import { startAttempt } from '@assessiq/attempt-engine';
import { publicAuthChain, authChain } from '../../middleware/auth-chain.js';

// GET /embed?token=<JWT> — host-app iframe entry point (Phase 4).
//
// Frozen decisions (modules/12-embed-sdk/SKILL.md § Decisions captured 2026-05-03):
//   D1  — redirects to /take/a/<attemptId>?embed=true
//   D5  — algorithms: ["HS256"], exp - iat ≤ 600s (enforced by verifyEmbedToken)
//   D6  — aiq_embed_sess cookie; session_type='embed' in Postgres
//   D7  — SameSite=None; Secure; HttpOnly; Path=/
//   D8  — CSP frame-ancestors per-tenant; X-Frame-Options removed
//   D11 — sdk-mint gated: ENABLE_EMBED_TEST_MINTER + NODE_ENV ≠ 'production' + admin session
//
// Replay cache (aiq:embed:jti:<jti>) and exp-cap enforcement are inside
// verifyEmbedToken — callers have zero involvement.
//
// The aiq_embed_sess bridge in apps/api/src/server.ts promotes the embed cookie
// value into the standard session-loader slot for subsequent API calls from the iframe.

export async function registerEmbedRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /embed?token=<JWT>  — main embed entry point
  // -------------------------------------------------------------------------
  app.get(
    '/embed',
    {
      config: { skipAuth: true },
      preHandler: publicAuthChain,
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const token = q['token'];
      if (typeof token !== 'string' || token.length === 0) {
        throw new ValidationError('token query param required', {
          details: { code: 'MISSING_TOKEN' },
        });
      }

      let verified: Awaited<ReturnType<typeof verifyEmbedToken>>;
      try {
        verified = await verifyEmbedToken(token);
      } catch (err) {
        if (err instanceof AuthnError) {
          throw new AppError(err.message, 'INVALID_TOKEN', 401);
        }
        throw err as Error;
      }

      const { payload, tenantId } = verified;

      // Set per-tenant CSP frame-ancestors (D8).
      const origins = await getEmbedOrigins(tenantId);
      const csp = buildEmbedCsp(origins);
      reply.header('Content-Security-Policy', csp);
      // Remove X-Frame-Options so CSP is the sole authority (browsers honor CSP
      // frame-ancestors over XFO when both are set, but removing XFO avoids
      // confusion and any browser-specific fallback ambiguity).
      reply.removeHeader('X-Frame-Options');

      // Resolve or create the candidate user (JIT — D1).
      const { userId } = await resolveJitUser({
        tenantId,
        email: payload.email,
        name: payload.name,
        externalSub: payload.sub,
      });

      // Mint the embed session and set the aiq_embed_sess cookie (D6, D7).
      const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
      const ua = req.headers['user-agent'] ?? 'unknown';
      const sessionResult = await mintEmbedSession({
        userId,
        tenantId,
        jwtExp: payload.exp,
        ip,
        ua,
      });

      reply.setCookie(EMBED_COOKIE_NAME, sessionResult.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',   // CRITICAL: cross-origin iframe requires SameSite=None (D7)
        path: '/',
        maxAge: sessionResult.maxAge,
      });

      // Start (or resume) the attempt for this user+assessment (D1).
      // startAttempt is idempotent — returns existing attempt if already running.
      const attempt = await startAttempt(tenantId, {
        userId,
        assessmentId: payload.assessment_id,
        embedOrigin: true,
      });

      // Redirect to the candidate take UI in embed mode.
      return reply.redirect(`/take/a/${attempt.id}?embed=true`, 302);
    },
  );

  // -------------------------------------------------------------------------
  // GET /embed/health  — lightweight health probe for host-app integration tests
  // -------------------------------------------------------------------------
  app.get(
    '/embed/health',
    { config: { skipAuth: true } },
    async () => ({ status: 'ok' }),
  );

  // -------------------------------------------------------------------------
  // GET /embed/sdk.js  — self-contained host SDK (≤3 KB)
  // -------------------------------------------------------------------------
  app.get(
    '/embed/sdk.js',
    { config: { skipAuth: true } },
    async (_req, reply) => {
      // Served from packages/embed-sdk/dist/sdk.min.js at build time.
      // In dev, the raw SDK source is inlined here as a UMD bundle stub.
      // The production build (Vite) replaces this handler with a static-file
      // serve from apps/api/public/embed/sdk.js.
      reply.header('Content-Type', 'application/javascript; charset=utf-8');
      reply.header('Cache-Control', 'public, max-age=3600');
      // Minimal UMD stub — the real compiled SDK is injected by the build pipeline.
      // window.AssessIQ.mount(selector, opts) is the public API.
      return reply.send(`(function(w,d){"use strict";
var AssessIQ={version:"1.0.0",mount:function(sel,opts){
var el=typeof sel==="string"?d.querySelector(sel):sel;
if(!el){throw new Error("AssessIQ.mount: container element not found: "+sel);}
if(!opts||!opts.token){throw new Error("AssessIQ.mount: token required");}
var ifr=d.createElement("iframe");
ifr.style.cssText="width:100%;height:100%;border:none;display:block;";
ifr.allow="fullscreen";
var base=opts.baseUrl||(w.location.protocol+"//"+w.location.host);
ifr.src=base+"/embed?token="+encodeURIComponent(opts.token)+(opts.sdkVersion?"&sdk_version="+encodeURIComponent(opts.sdkVersion):"");
var origin=base;
var onMsg=function(e){
if(e.origin!==origin)return;
var msg=e.data;if(!msg||!msg.type)return;
if(msg.type==="aiq.ready"&&opts.onReady)opts.onReady(msg);
if(msg.type==="aiq.attempt.submitted"&&opts.onSubmit)opts.onSubmit(msg);
if(msg.type==="aiq.error"&&opts.onError)opts.onError(msg);
if(msg.type==="aiq.height"&&msg.height)ifr.style.height=msg.height+"px";
};
w.addEventListener("message",onMsg);
el.appendChild(ifr);
return{iframe:ifr,destroy:function(){el.removeChild(ifr);w.removeEventListener("message",onMsg);}};
}};
w.AssessIQ=AssessIQ;
})(window,document);`);
    },
  );

  // -------------------------------------------------------------------------
  // POST /embed/sdk-mint  — dev-only test JWT minter (D11)
  //
  // THREE-LAYER gate (all three must pass):
  //   1. ENABLE_EMBED_TEST_MINTER=1 env var (route not even registered if absent)
  //   2. NODE_ENV !== 'production' (second guard inside handler)
  //   3. Admin session required (authChain roles:['admin'])
  //
  // This route is NOT registered in production builds (the outer if blocks it).
  // -------------------------------------------------------------------------
  if (process.env['ENABLE_EMBED_TEST_MINTER'] === '1') {
    app.post(
      '/embed/sdk-mint',
      {
        config: { skipAuth: true },
        preHandler: authChain({ roles: ['admin'] }),
      },
      async (req) => {
        // Layer 2: runtime guard (belt-and-suspenders in case env leaks).
        if (config.NODE_ENV === 'production') {
          throw new AppError('not available in production', 'FORBIDDEN', 403);
        }

        const body = req.body as Record<string, unknown>;
        const assessmentId = typeof body['assessmentId'] === 'string' ? body['assessmentId'] : '';
        const tenantId = req.session!.tenantId;

        if (!assessmentId) {
          throw new ValidationError('assessmentId required', {
            details: { code: 'MISSING_PARAM' },
          });
        }

        const ip = (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;
        const ua = req.headers['user-agent'] ?? 'unknown';

        const token = await mintEmbedToken({
          iss: 'assessiq-test-minter',
          sub: `test-user-${Date.now()}`,
          tenant_id: tenantId,
          email: `test-${Date.now()}@embed-test.local`,
          name: 'Test Candidate',
          assessment_id: assessmentId,
        }, { ttlSeconds: 600 });

        return {
          token,
          embedUrl: `/embed?token=${encodeURIComponent(token)}`,
          note: 'DEV ONLY — token valid for 600s, single-use (replay cache)',
          ip,
          ua,
        };
      },
    );
  }
}

