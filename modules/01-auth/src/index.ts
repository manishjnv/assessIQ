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
  listEmbedSecrets,
} from "./embed-jwt.js";
export type {
  EmbedTokenPayload,
  VerifiedEmbedToken,
  EmbedSecretRecord,
} from "./embed-jwt.js";

export {
  startGoogleSso,
  handleGoogleCallback,
  normalizeEmail,
  mintForIdentity,
  COOKIE_CONTINUATION_NAME,
  continuationCookieOpts,
} from "./google-sso.js";
export type {
  OidcStartOutput,
  OidcCallbackOutput,
  CookieOpts,
  GoogleIdTokenClaims,
} from "./google-sso.js";

export {
  resolveLoginIdentities,
  storeLoginContinuation,
  consumeLoginContinuation,
  peekLoginContinuation,
  selectLoginIdentity,
} from "./login-continuation.js";
export type {
  ResolvedIdentity,
  LoginContinuationPayload,
} from "./login-continuation.js";

export { mintCandidateSession } from "./magic-link.js";
export type { MintCandidateSessionInput } from "./magic-link.js";

// P2 — Email-OTP login (admin + reviewer only).
export { requestEmailOtp, verifyEmailOtp } from "./email-otp.js";

export {
  requestCandidateLoginLink,
  requestCandidateLoginLinkSystem,
  verifyCandidateLoginToken,
  verifyCandidateLoginTokenSystem,
  CANDIDATE_LOGIN_TOKEN_TTL_SEC,
  CANDIDATE_SESSION_TTL_SEC,
  checkCandidateLinkRateLimit,
} from "./candidate-login.js";
export type {
  RequestCandidateLoginLinkInput,
  RequestCandidateLoginLinkSystemInput,
  RequestCandidateLoginLinkOutput,
} from "./candidate-login.js";

export { logLifecycleEvent } from "./lifecycle-log.js";
export type { LifecycleEvent } from "./lifecycle-log.js";

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
