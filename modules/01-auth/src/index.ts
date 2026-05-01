// 01-auth public surface (Window 4 — G0.C-4).
// Phase 0 ships: sessions, totp, api-keys, embed-jwt, google-sso (library funcs).
// Magic-link route + middleware/* are added during Phase D.

export { sessions } from "./sessions.js";
export type { Session, CreateSessionInput, CreateSessionOutput, Role } from "./sessions.js";

// Test escape hatches — mirrors @assessiq/tenancy's setPoolForTesting export.
// Cross-module tests (e.g. 03-users.acceptInvitation) need to swap the
// singleton against the local testcontainer's URL. NOT for production code.
export { setRedisForTesting, closeRedis } from "./redis.js";

export { totp } from "./totp.js";
export type { EnrollStartOutput } from "./totp.js";

export { apiKeys } from "./api-keys.js";
export type { ApiKeyRecord, ApiKeyScope } from "./api-keys.js";

export {
  mintEmbedToken,
  verifyEmbedToken,
  createEmbedSecret,
  rotateEmbedSecret,
} from "./embed-jwt.js";
export type { EmbedTokenPayload, VerifiedEmbedToken } from "./embed-jwt.js";

export {
  startGoogleSso,
  handleGoogleCallback,
  normalizeEmail,
} from "./google-sso.js";
export type {
  OidcStartOutput,
  OidcCallbackOutput,
  CookieOpts,
} from "./google-sso.js";

export { mintCandidateSession } from "./magic-link.js";
export type { MintCandidateSessionInput } from "./magic-link.js";

export {
  requestIdMiddleware,
  cookieParserMiddleware,
  parseCookieHeader,
  rateLimitMiddleware,
  extractClientIp,
  sessionLoaderMiddleware,
  apiKeyAuthMiddleware,
  requireAuth,
  requireRole,
  requireFreshMfa,
  requireScope,
  extendOnPassMiddleware,
} from "./middleware/index.js";
export type { AuthRequest, AuthReply, AuthHook } from "./middleware/index.js";
