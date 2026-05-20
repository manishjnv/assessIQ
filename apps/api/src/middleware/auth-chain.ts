// AssessIQ — auth route preHandler chain.
//
// Composes the @assessiq/auth middleware stack into a Fastify-shaped array
// the auth route layer drops into `{ preHandler: [...] }`. Each route owns
// its chain. The route definitions also carry `config: { skipAuth: true }`
// — that flag is preserved for future global-hook opt-outs (e.g. legacy
// audit hooks that want to ignore /api/auth/*). The per-route chain is
// authoritative for /api/auth/* and /embed.
//
// Stack order:
//   1. sessionLoader     (sets req.session if cookie present — MUST run first
//                         so rateLimit can read it for role-based IP bucket
//                         resolution; short-circuits in <1ms when no aiq_sess
//                         cookie is present — no Redis hit on anonymous requests)
//   2. apiKeyAuth        (sets req.apiKey if Bearer present and no session — MUST
//                         run before rateLimit so resolveIpBucketMax can read
//                         req.apiKey for the 600/min API key tier)
//   3. rateLimit         (role-aware per-IP for ALL routes; reads both
//                         req.session.role and req.apiKey for IP tier selection;
//                         per-user/tenant for authenticated routes; single
//                         instance — no bypass)
//   4. syncCtx           (mirrors session/apiKey into req.assessiqCtx for ALS)
//   5. requireAuth       (role / TOTP / freshMfa gates — only when requested)
//   6. extendOnPass      (sliding-refresh; runs on session-backed pass)
//
// Chain order: sessionLoader and apiKeyAuth BEFORE rateLimit so resolveIpBucketMax
// can read both req.session.role and req.apiKey for IP tier selection
// (admin=100, candidate=30, anon=30, apikey=600).
// @fastify/cookie runs as an onRequest hook BEFORE all preHandlers, so
// req.cookies is always populated when sessionLoader runs.
//
// The 02-tenancy.tenantContextMiddleware already runs as a global preHandler
// gated on req.session?.tenantId. When this auth chain populates req.session,
// the global hook fires AFTER per-route preHandlers complete — except Fastify
// runs global preHandlers first. So tenant context is NOT set by the global
// hook for these auth routes; the route handlers and library functions use
// withTenant(...) to scope DB queries explicitly.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@assessiq/core';
import {
  rateLimitMiddleware,
  sessionLoaderMiddleware,
  apiKeyAuthMiddleware,
  requireAuth,
  extendOnPassMiddleware,
  type Role,
} from '@assessiq/auth';

type FastifyHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

// Cast helper — the library hooks are structurally typed against AuthRequest /
// AuthReply (Phase 0 deliberately avoids hard fastify dep in the library), so
// at the route boundary we narrow to FastifyRequest/FastifyReply. The shapes
// overlap on every field the library reads (headers, cookies, session, apiKey,
// log) — same pattern as 02-tenancy.tenantContextMiddleware.
const cast = <H>(hook: H): FastifyHook => hook as unknown as FastifyHook;

// In dev/test the `users` table may not exist (00-core / 02-tenancy bootstrap
// without 03-users in some test scaffolds). The library's session-loader
// honors a skip flag for that case; production NEVER skips — the library
// constructor itself throws if asked to skip in production.
const skipUserStatusCheck = config.NODE_ENV !== 'production';

// Standard rate-limit middleware instance — role-aware IP bucket, no bypass.
// IP bucket max is resolved per-request from req.session.role / req.apiKey.
// Both instances share the same Redis connection (via getRedis() singleton).
const _rateLimit = rateLimitMiddleware();
// Credential-endpoint rate-limit instance — same as above but additionally
// enforces a per-route per-IP credential cap (RATE_LIMIT_CREDENTIAL=20/min).
// Always applies regardless of session tier to protect TOTP brute-force surface.
const _rateLimitCredential = rateLimitMiddleware({ credentialEndpoint: true });
const _sessionLoader = sessionLoaderMiddleware({ skipUserStatusCheck });
const _extendOnPass = extendOnPassMiddleware(config.SESSION_COOKIE_NAME);

const rateLimit: FastifyHook = cast(_rateLimit);
const rateLimitCredential: FastifyHook = cast(_rateLimitCredential);
const sessionLoader: FastifyHook = cast(_sessionLoader);
const apiKeyAuth: FastifyHook = cast(apiKeyAuthMiddleware);
const extendOnPass: FastifyHook = cast(_extendOnPass);

// Mirror session/apiKey identity into req.assessiqCtx so the request-log
// mixin (server.ts onResponse) and the streamLogger ALS context see the
// correct correlation fields without each route handler having to opt in.
const syncCtx: FastifyHook = async (req) => {
  if (req.session !== undefined) {
    req.assessiqCtx.tenantId = req.session.tenantId;
    req.assessiqCtx.userId = req.session.userId;
  } else if (req.apiKey !== undefined) {
    req.assessiqCtx.tenantId = req.apiKey.tenantId;
  }
};

export interface AuthChainOpts {
  // When `false`, no requireAuth is appended — pre-auth public route. The
  // earlier hooks still run so a cookie-bearing request gets req.session set
  // (used by /api/auth/google/start so a returning admin doesn't re-OIDC).
  requireSession?: false;
  roles?: readonly Role[];
  freshMfaWithinMinutes?: number;
  requireTotpVerified?: boolean;
  // When true, an additional per-route per-IP credential bucket is enforced at
  // RATE_LIMIT_CREDENTIAL (default 20/min) regardless of session auth tier.
  // Use on credential endpoints (TOTP verify, recovery, login email request/verify)
  // to maintain brute-force protection even when the verified-admin IP cap is high.
  credentialEndpoint?: boolean;
}

export function authChain(opts: AuthChainOpts = {}): FastifyHook[] {
  // Chain order: sessionLoader and apiKeyAuth BEFORE rateLimit so resolveIpBucketMax
  // can read both req.session.role and req.apiKey for IP tier selection. See header comment for full safety rationale.
  const rl = opts.credentialEndpoint === true ? rateLimitCredential : rateLimit;
  const chain: FastifyHook[] = [sessionLoader, apiKeyAuth, rl, syncCtx];
  if (opts.requireSession === false) return chain;

  // Conditional spread to satisfy exactOptionalPropertyTypes — never pass
  // an explicit `undefined` to an optional field on RequireAuthOptions.
  const reqAuthOpts: Parameters<typeof requireAuth>[0] = {};
  if (opts.roles !== undefined) reqAuthOpts.roles = [...opts.roles];
  if (opts.freshMfaWithinMinutes !== undefined) reqAuthOpts.freshMfaWithinMinutes = opts.freshMfaWithinMinutes;
  if (opts.requireTotpVerified !== undefined) reqAuthOpts.requireTotpVerified = opts.requireTotpVerified;

  chain.push(cast(requireAuth(reqAuthOpts)));
  chain.push(extendOnPass);
  return chain;
}

// Public-route chain: no requireAuth, no extendOnPass. Used by:
//   - GET  /api/auth/google/start  (pre-OIDC; cookie may or may not be present)
//   - GET  /api/auth/google/cb     (the OIDC callback completes auth)
//   - GET  /embed?token=<JWT>      (token IS the credential)
// Still runs rateLimit (role-aware IP bucket applies to ALL routes).
export const publicAuthChain: FastifyHook[] = authChain({ requireSession: false });

// Public credential chain: same as publicAuthChain but with credentialEndpoint:true.
// Used by:
//   - POST /api/auth/login/email/request  (email OTP request)
//   - POST /api/auth/login/email/verify   (email OTP verify)
// The credential bucket (20/min) applies regardless of session tier to maintain
// brute-force protection on these credential-handling endpoints.
export const publicCredentialAuthChain: FastifyHook[] = authChain({
  requireSession: false,
  credentialEndpoint: true,
});
