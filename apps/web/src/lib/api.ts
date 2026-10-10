import { createApiClient, createApiRequest } from '@assessiq/http-client';

export { ApiCallError } from '@assessiq/http-client';
export type { ApiError } from '@assessiq/http-client';

// Cookie-based auth via @assessiq/auth's sessionLoader. The aiq_sess cookie
// is set httpOnly+Secure+SameSite=Lax by /api/auth/google/cb (and the
// invitation accept path); credentials:'include' sends it on every request.
// The legacy dev-auth-headers shim was removed in Phase 0 closure (Commit B).
//
// Content-Type is set only when the request actually has a body. Fastify's
// JSON body parser fires on `Content-Type: application/json` and tries to
// parse the payload — even when the body is empty. Empty + JSON parse =
// FST_ERR_CTP_EMPTY_JSON_BODY → 400 BEFORE the preHandler chain runs.
// Body-less POSTs (logout, totp/enroll/start, etc.) MUST NOT carry a JSON
// content-type. Discovered when the post-SSO MFA enrollment loop showed
// the "Verify" UI instead of the QR — 400 from the body parser made the
// SPA's catch fall through to its default error path.
//
// The implementation lives in @assessiq/http-client (single fetch layer).
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export const api = createApiClient(API_BASE);
/** Like `api` but resolves to the raw Response (for callers that need headers/status only). */
export const apiRequest = createApiRequest(API_BASE);
