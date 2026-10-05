// 01-auth middleware barrel.
//
// Stack order — addendum § 9, docs/04-auth-flows.md lines 91-97:
//   1. requestId
//   2. rateLimit             (rate-limit headers; rejects on 429)
//   3. cookieParser
//   4. sessionLoader         (sets req.session if cookie present and session valid)
//   5. apiKeyAuth            (sets req.apiKey if Authorization: Bearer present and session absent)
//   6. <route handler chain> with requireAuth/requireRole/requireScope/requireFreshMfa
//   7. extendOnPass          (sliding-refresh on session-backed pass)
//
// FU-D6 (2026-10-06): the line below was stale. 02-tenancy.tenantContextMiddleware
// is NOT registered in the request chain (removed 2026-10, campus-scale fix —
// see modules/02-tenancy/src/middleware.ts header). Tenant context is set by
// withTenant(tenantId, fn) at each route/service call site, which reads
// req.session?.tenantId ?? req.apiKey?.tenantId itself. See
// apps/api/src/middleware/auth-chain.ts for the real, current chain.

export { requestIdMiddleware } from "./request-id.js";
export { cookieParserMiddleware, parseCookieHeader } from "./cookie-parser.js";
export { rateLimitMiddleware, consumeRateLimit, isRateLimited } from "./rate-limit.js";
export { extractClientIp } from "../client-ip.js";
export { sessionLoaderMiddleware } from "./session-loader.js";
export { apiKeyAuthMiddleware } from "./api-key-auth.js";
export {
  requireAuth,
  requireRole,
  requireFreshMfa,
  requireScope,
  extendOnPassMiddleware,
} from "./require-auth.js";
export type { AuthRequest, AuthReply, AuthHook } from "./types.js";
