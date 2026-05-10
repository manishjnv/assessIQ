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

// ---------------------------------------------------------------------------
// Typed helpers — bulk question status update endpoint
// ---------------------------------------------------------------------------

export interface BulkUpdateStatusRequest {
  ids: string[];
  status: "active" | "archived";
}

export interface BulkUpdateStatusResponse {
  updated: string[];
  notFound: string[];
}

export async function bulkUpdateQuestionStatus(
  body: BulkUpdateStatusRequest,
): Promise<BulkUpdateStatusResponse> {
  return adminApi<BulkUpdateStatusResponse>(
    "/admin/questions/bulk-update-status",
    { method: "POST", body: JSON.stringify(body) },
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — score generation attempt endpoint
// ---------------------------------------------------------------------------

export interface ScoreAttemptRuntimeMetric {
  name: string;
  /** Numeric value; null when not derivable from the attempt row (e.g. peak_rss). */
  value: number | null;
  /** Threshold expression, e.g. "≥0.60" or "≤1000". */
  threshold: string;
  verdict: "pass" | "fail" | "n/a";
}

export interface ScoreAttemptPerTypeEntry {
  type: string;
  total: number;
  passed: number;
  failed: number;
  /** Top 3 failure reasons (truncated). */
  failures: string[];
}

export interface ScoreAttemptBaselineDiffEntry {
  level: string;
  type: string;
  was_passed: number;
  now_passed: number;
}

export interface ScoreAttemptResponse {
  attempt: {
    id: string;
    status: string;
    count_requested: number;
    count_inserted: number;
    duration_ms: number | null;
    chunks_planned: number | null;
    chunks_failed: number | null;
    dedupe_dropped: number | null;
    citation_dropped: number | null;
    model: string | null;
    skill_sha: string | null;
    error_code: string | null;
    error_message: string | null;
    stderr_tail: string | null;
    started_at: string;
    finished_at: string | null;
  };
  structural: {
    per_type: ScoreAttemptPerTypeEntry[];
    total: number;
    passed: number;
    failed: number;
    baseline_diff: {
      regressions: ScoreAttemptBaselineDiffEntry[];
      improvements: ScoreAttemptBaselineDiffEntry[];
    };
  };
  runtime: {
    metrics: ScoreAttemptRuntimeMetric[];
  };
  overall: "pass" | "regression" | "warning" | "n/a";
}

export async function scoreGenerationAttempt(id: string): Promise<ScoreAttemptResponse> {
  return adminApi<ScoreAttemptResponse>(
    `/admin/generation-attempts/${encodeURIComponent(id)}/score`,
    { method: "POST" },
  );
}
