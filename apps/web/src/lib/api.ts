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
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
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
