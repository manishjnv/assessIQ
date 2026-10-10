// AssessIQ — the ONE browser HTTP client. apps/web, modules/10 and modules/11
// all build their API entrypoints from createApiClient; no other fetch layer.

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
    this.name = 'ApiCallError';
  }
}

export type ApiErrorCtor = new (status: number, apiError: ApiError) => ApiCallError;
export type ApiInit = RequestInit & { base?: string };

/**
 * Returns the raw Response (throws on !ok). Use when a caller needs headers;
 * otherwise use createApiClient.
 *
 * Cookie-based auth: credentials:'include' sends the httpOnly aiq_sess cookie.
 *
 * Content-Type is set only when the request actually has a body. Fastify's
 * JSON body parser fires on `Content-Type: application/json` and tries to
 * parse the payload — even when the body is empty. Empty + JSON parse =
 * FST_ERR_CTP_EMPTY_JSON_BODY → 400 BEFORE the preHandler chain runs.
 * Body-less POSTs (logout, totp/enroll/start, etc.) MUST NOT carry a JSON
 * content-type. Discovered when the post-SSO MFA enrollment loop showed
 * the "Verify" UI instead of the QR — 400 from the body parser made the
 * SPA's catch fall through to its default error path.
 */
export function createApiRequest(
  defaultBase: string,
  ErrorClass: ApiErrorCtor = ApiCallError,
): (path: string, init?: ApiInit) => Promise<Response> {
  return async (path, init = {}) => {
    const { base = defaultBase, ...rest } = init;
    const hasBody = rest.body !== undefined && rest.body !== null;
    const res = await fetch(`${base}${path}`, {
      credentials: 'include',
      ...rest,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
    });

    if (!res.ok) {
      let body: { error?: ApiError };
      try { body = (await res.json()) as { error?: ApiError }; } catch { body = {}; }
      const apiErr: ApiError = body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
      throw new ErrorClass(res.status, apiErr);
    }
    return res;
  };
}

export function createApiClient(
  defaultBase: string,
  ErrorClass: ApiErrorCtor = ApiCallError,
): <T = unknown>(path: string, init?: ApiInit) => Promise<T> {
  const request = createApiRequest(defaultBase, ErrorClass);
  return async <T>(path: string, init?: ApiInit): Promise<T> => {
    const res = await request(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}

/**
 * Like createApiRequest, but never throws on a non-2xx status. For endpoints
 * where the error body is data (for example /api/ready answers 503 with checks).
 * Network failures still reject.
 */
export function createApiRawRequest(defaultBase: string): (path: string, init?: ApiInit) => Promise<Response> {
  return async (path, init = {}) => {
    const { base = defaultBase, ...rest } = init;
    return fetch(`${base}${path}`, { credentials: 'include', ...rest });
  };
}
