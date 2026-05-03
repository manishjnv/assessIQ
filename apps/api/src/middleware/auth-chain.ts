// AssessIQ — auth route preHandler chain.
//
// Composes the @assessiq/auth middleware stack into a Fastify-shaped array
// the auth route layer drops into `{ preHandler: [...] }`. Each route owns
// its chain. The route definitions also carry `config: { skipAuth: true }`
// — that flag is preserved for future global-hook opt-outs (e.g. legacy
// audit hooks that want to ignore /api/auth/*). The per-route chain is
// authoritative for /api/auth/* and /embed.
//
// Stack order — UPDATED 2026-05-04 (admin rate-limit bypass):
//   1. sessionLoader     (sets req.session if cookie present — MUST run first
//                         so rateLimit can read it for the bypass decision;
//                         short-circuits in <1ms when no aiq_sess cookie is
//                         present — no Redis hit on anonymous requests)
//   2. rateLimit         (per-IP for /api/auth/*; per-user/tenant for authed;
//                         per-IP bucket skipped for verified admin/reviewer on
//                         opt-in endpoints when allowVerifiedAdminBypass=true)
//   3. apiKeyAuth        (sets req.apiKey if Bearer present and no session)
//   4. syncCtx           (mirrors session/apiKey into req.assessiqCtx for ALS)
//   5. requireAuth       (role / TOTP / freshMfa gates — only when requested)
//   6. extendOnPass      (sliding-refresh; runs on session-backed pass)
//
// Previous order was [rateLimit, sessionLoader, ...]. The reorder is safe
// because @fastify/cookie runs as an onRequest hook BEFORE all preHandlers,
// so req.cookies is already populated when sessionLoader runs first. See
// CLAUDE.md prompt 2026-05-04 for full rationale and safety analysis.
//
// The 02-tenancy.tenantContextMiddleware already runs as a global preHandler
// gated on req.session?.tenantId. When this auth chain populates req.session,
// the global hook fires AFTER per-route preHandlers complete — except Fastify
// runs global preHandlers first. So tenant context is NOT set by the global
// hook for these auth routes; the route handlers and library functions use
// withTenant(...) to scope DB queries explicitly. That matches the W4 design
// where every library function (totp.verify, apiKeys.list, sessions.create,
// verifyEmbedToken, etc.) wraps its DB access in withTenant.

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

// Two rate-limit middleware instances: one strict (default) and one with the
// admin/reviewer per-IP bypass enabled. The bypass is a code-set option —
// it is NEVER set from request input. Only routes that explicitly call
// authChain({ allowVerifiedAdminBypass: true }) get the bypass instance.
// Both instances share the same Redis connection (via getRedis() singleton).
const _rateLimitDefault = rateLimitMiddleware();
const _rateLimitBypass = rateLimitMiddleware({ allowVerifiedAdminBypass: true });
const _sessionLoader = sessionLoaderMiddleware({ skipUserStatusCheck });
const _extendOnPass = extendOnPassMiddleware(config.SESSION_COOKIE_NAME);

const rateLimitDefault: FastifyHook = cast(_rateLimitDefault);
const rateLimitBypass: FastifyHook = cast(_rateLimitBypass);
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

  // When true, a verified admin or reviewer session (role IN {admin,reviewer}
  // AND totpVerified === true) bypasses the per-IP rate-limit bucket. The
  // per-user (60/min) and per-tenant (600/min) buckets still apply.
  //
  // This flag is CODE-ONLY — it is set here in route definitions, never from
  // request headers, query strings, or body. A reviewer cannot smuggle this
  // flag into a request to bypass the IP limiter.
  //
  // Opt-in whitelist (the only routes where this should be true):
  //   - /api/auth/google/start  (admin re-clicking SSO during testing)
  //   - /api/auth/logout        (admin aborting a session)
  //   - /api/auth/whoami        (frequent polling by admin SPA)
  //
  // NEVER set on:
  //   - /api/auth/totp/verify   (TOTP brute-force class — always strict)
  //   - /api/auth/totp/recovery (recovery-code brute-force class)
  //   - /api/auth/totp/enroll/* (enrollment confirm is also brute-forceable)
  //   - /api/auth/google/cb     (OAuth callback — no session yet)
  //   - /api/take/start         (magic-link redemption — no session yet)
  allowVerifiedAdminBypass?: boolean;
}

export function authChain(opts: AuthChainOpts = {}): FastifyHook[] {
  // Chain order: sessionLoader FIRST so rateLimit can read req.session for the
  // admin bypass decision. See header comment for full safety rationale.
  const rateLimit = opts.allowVerifiedAdminBypass === true ? rateLimitBypass : rateLimitDefault;
  const chain: FastifyHook[] = [sessionLoader, rateLimit, apiKeyAuth, syncCtx];
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
// Still runs rateLimit (the IP-bucket hits /api/auth/* by prefix; /embed has
// no IP bucket since no /api prefix, but the chain shape stays uniform).
export const publicAuthChain: FastifyHook[] = authChain({ requireSession: false });
