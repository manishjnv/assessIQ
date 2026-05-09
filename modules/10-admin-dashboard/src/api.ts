// AssessIQ — @assessiq/admin-dashboard API client.
//
// Thin typed wrapper around fetch for admin endpoints.
// Mirrors apps/web/src/lib/api.ts in pattern (cookie-trust + ApiCallError
// envelope) but lives in the package so no circular dep to apps/web.

const API_BASE = "/api";

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class AdminApiError extends Error {
  status: number;
  apiError: ApiError;
  constructor(status: number, apiError: ApiError) {
    super(apiError.message);
    this.status = status;
    this.apiError = apiError;
    this.name = "AdminApiError";
  }
}

export async function adminApi<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { error?: ApiError };
    try {
      body = (await res.json()) as { error?: ApiError };
    } catch {
      body = {};
    }
    const apiErr: ApiError =
      body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw new AdminApiError(res.status, apiErr);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Typed helpers — generate endpoint
// ---------------------------------------------------------------------------

export type GenerateQuestionType = "mcq" | "log_analysis" | "scenario" | "kql" | "subjective";

export interface GenerateQuestionsRequest {
  count: number;
  topic_focus?: string;
  type_counts?: Partial<Record<GenerateQuestionType, number>>;
}

export interface GenerateQuestionsResponse {
  questionIds: string[];
  generated: number;
  skillSha: string;
}

export async function generateQuestionsApi(
  packId: string,
  levelId: string,
  body: GenerateQuestionsRequest,
): Promise<GenerateQuestionsResponse> {
  return adminApi<GenerateQuestionsResponse>(
    `/admin/packs/${packId}/levels/${levelId}/generate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
