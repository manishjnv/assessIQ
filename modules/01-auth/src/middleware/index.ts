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
// 02-tenancy.tenantContextMiddleware sits between (5) and (6) — it reads
// req.session?.tenantId ?? req.apiKey?.tenantId to set the Postgres GUC.

export { requestIdMiddleware } from "./request-id.js";
export { cookieParserMiddleware, parseCookieHeader } from "./cookie-parser.js";
export { rateLimitMiddleware, extractClientIp } from "./rate-limit.js";
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
