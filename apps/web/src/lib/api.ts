const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiCallError extends Error {
  status: number;
  apiError: ApiError;
  constructor(status: number, apiError: ApiError) {
    super(apiError.message);
    this.status = status;
    this.apiError = apiError;
  }
}

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
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { error?: ApiError };
    try { body = await res.json(); } catch { body = {}; }
    const apiErr: ApiError = body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw new ApiCallError(res.status, apiErr);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
