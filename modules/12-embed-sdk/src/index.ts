// modules/12-embed-sdk/src/index.ts
//
// Public barrel for @assessiq/embed-sdk.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

export { getEmbedOrigins, verifyEmbedOrigin } from "./origin-verifier.js";
export { buildEmbedCsp } from "./csp-builder.js";
export { mintEmbedSession, EMBED_COOKIE_NAME } from "./session-mint.js";
export type { MintEmbedSessionInput, MintEmbedSessionResult } from "./session-mint.js";
export { resolveJitUser } from "./jit-user.js";
export type { JitUserInput, JitUserResult } from "./jit-user.js";
export {
  listEmbedOrigins,
  addEmbedOrigin,
  removeEmbedOrigin,
} from "./embed-origins-service.js";
export type { EmbedOriginRow } from "./embed-origins-service.js";
export { rotateWebhookSecret } from "./webhook-secret-service.js";
export type { RotateWebhookSecretResult } from "./webhook-secret-service.js";
