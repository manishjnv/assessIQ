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

// ---------------------------------------------------------------------------
// Typed helpers — super-admin AI generation mode endpoint
// ---------------------------------------------------------------------------

export type AiGenerateMode = "omnibus" | "sharded" | null;

export interface UpdateAiGenerateModeRequest {
  mode: AiGenerateMode;
}

export interface UpdateAiGenerateModeResponse {
  tenantId: string;
  ai_generate_mode: AiGenerateMode;
  previous: AiGenerateMode;
  updatedAt: string; // ISO 8601
  auditId: string;
}

/**
 * PATCH /api/admin/super/tenants/:tenantId/ai-generate-mode
 *
 * Super-admin only. Flips the per-tenant AI generation mode.
 * Returns the new state + the audit log row id for the toast message.
 */
export async function updateTenantAiGenerateMode(
  tenantId: string,
  mode: AiGenerateMode,
): Promise<UpdateAiGenerateModeResponse> {
  return adminApi<UpdateAiGenerateModeResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/ai-generate-mode`,
    { method: "PATCH", body: JSON.stringify({ mode }) },
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — domains + categories (Slice 2)
// ---------------------------------------------------------------------------

export interface DomainItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  display_order: number;
}

export interface CategoryItem {
  id: string;
  domain_id: string;
  slug: string;
  name: string;
  description: string | null;
  relevance_score: number;
  default_selected: boolean;
  /** Array of question type strings (e.g. ["mcq", "scenario"]). Stored as jsonb. */
  supported_types: string[];
  default_question_count: number;
  status: string;
}

export async function listDomainsApi(): Promise<{ items: DomainItem[]; total: number }> {
  return adminApi<{ items: DomainItem[]; total: number }>("/admin/domains");
}

export async function listCategoriesApi(
  domainId: string,
): Promise<{ items: CategoryItem[]; total: number }> {
  return adminApi<{ items: CategoryItem[]; total: number }>(
    `/admin/categories?domain_id=${encodeURIComponent(domainId)}`,
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — create domain + category (Slice 2.1b)
// ---------------------------------------------------------------------------

export interface CreateDomainRequest {
  name: string;
  description?: string;
}

export async function createDomainApi(body: CreateDomainRequest): Promise<DomainItem> {
  return adminApi<DomainItem>("/admin/domains", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface CreateCategoryRequest {
  domain_id: string;
  name: string;
  description?: string;
  supported_types?: string[];
  default_question_count?: number;
}

export async function createCategoryApi(body: CreateCategoryRequest): Promise<CategoryItem> {
  return adminApi<CategoryItem>("/admin/categories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface GenerateWithTagRequest {
  count: number;
  type_counts?: Partial<Record<GenerateQuestionType, number>>;
  domain_id?: string;
  category_id?: string;
}

/**
 * POST /api/admin/packs/:packId/levels/:levelId/generate
 *
 * Extended variant that supports domain_id + category_id tagging (Slice 2).
 * The server validates cross-tenant FK ownership before generating.
 */
export async function generateQuestionsWithTagApi(
  packId: string,
  levelId: string,
  body: GenerateWithTagRequest,
): Promise<GenerateQuestionsResponse> {
  return adminApi<GenerateQuestionsResponse>(
    `/admin/packs/${packId}/levels/${levelId}/generate`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
