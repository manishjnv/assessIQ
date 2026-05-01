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
      // FIXME(post-01-auth): swap dev-auth headers for cookie-only auth via 01-auth sessionLoader.
      // Phase 0 dev mode pulls dev-auth values from sessionStorage so the mock
      // login flow can populate them.
      ...devAuthHeaders(),
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

function devAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const raw = window.sessionStorage.getItem('aiq:dev-auth');
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as { tenantId?: string; userId?: string; role?: string };
    if (!v.tenantId || !v.userId || !v.role) return {};
    return {
      'x-aiq-test-tenant': v.tenantId,
      'x-aiq-test-user-id': v.userId,
      'x-aiq-test-user-role': v.role,
    };
  } catch { return {}; }
}
