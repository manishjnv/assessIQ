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

// ---------------------------------------------------------------------------
// Typed helpers — domain-based generate endpoint (Slice 2.1c)
// ---------------------------------------------------------------------------

export type DomainGenerateLevel = "L1" | "L2" | "L3";

export interface GenerateForDomainRequest {
  count: number;
  type_counts?: Partial<Record<GenerateQuestionType, number>>;
  category_id?: string;
}

/**
 * POST /api/admin/generate
 *
 * Domain-based generation (Slice 2.1c). The server resolves or creates the
 * auto-managed pack for (tenant, domain) and heals L1/L2/L3 levels.
 * Admin never sees pack_id or level_id — only domain + L1/L2/L3 level label.
 */
export async function generateForDomainApi(
  domainId: string,
  level: DomainGenerateLevel,
  body: GenerateForDomainRequest,
): Promise<GenerateQuestionsResponse> {
  return adminApi<GenerateQuestionsResponse>(
    "/admin/generate",
    {
      method: "POST",
      body: JSON.stringify({ domain_id: domainId, level, ...body }),
    },
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — super-admin company provisioning + tenant list (Slice 1)
// ---------------------------------------------------------------------------

export interface CreateCompanyRequest {
  name: string;
  slug: string;
  domain?: string;
  adminEmail: string;
  adminName?: string;
}

export interface CreateCompanyResponse {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  invitation: { id: string; email: string; role: string; expires_at: string } | null;
}

export interface TenantUsage {
  tier: 'free' | 'pro' | 'enterprise' | 'internal';
  included_credits: number | null;
  used: number;
  remaining: number | null;
  overage: number;
  status: 'ok' | 'warn' | 'over' | 'unlimited';
}

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
  /** First admin invited at company-creation time. Null for tenants with no
   *  role='admin' user (e.g. the platform tenant). admin_status is 'pending'
   *  until the admin accepts the invite, then 'active'. */
  admin_email: string | null;
  admin_name: string | null;
  admin_status: string | null;
  admin_invitation_expires_at: string | null;
  /** A2: billing usage for this tenant, or null if no plan row. */
  usage: TenantUsage | null;
  /** Phase B: active admin count (excluding super_admin and disabled users). */
  admin_count: number;
  /** Phase B: active reviewer count. */
  reviewer_count: number;
}

/**
 * POST /api/admin/super/companies
 *
 * Super-admin only. Provisions a new company tenant and sends an invitation
 * to the first admin email. Gate: super_admin + fresh-MFA (TOTP within 15 min).
 */
export async function createCompanyApi(
  body: CreateCompanyRequest,
): Promise<CreateCompanyResponse> {
  return adminApi<CreateCompanyResponse>("/admin/super/companies", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * GET /api/admin/super/tenants
 *
 * Super-admin only. Returns the list of all provisioned tenants.
 * Pass `includeArchived: true` to also surface archived tenants
 * (adds `?include_archived=true` to the request).
 */
export async function listTenantsApi(
  opts?: { includeArchived?: boolean },
): Promise<{ tenants: TenantListItem[] }> {
  const qs = opts?.includeArchived ? "?include_archived=true" : "";
  return adminApi<{ tenants: TenantListItem[] }>(`/admin/super/tenants${qs}`);
}

// ---------------------------------------------------------------------------
// Typed helpers — tenant lifecycle (Phase B)
// ---------------------------------------------------------------------------

export interface LifecycleResponse {
  tenantId: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
  previousStatus: 'active' | 'suspended' | 'archived';
  sessionsRevoked?: { count: number; affectedUsers: string[] };
  noOp: boolean;
  auditId: string | null;
}

/**
 * POST /api/admin/super/tenants/:tenantId/suspend
 *
 * Transitions active → suspended. Destroys all active sessions for the tenant.
 * Idempotent: already-suspended returns 200 + noOp:true.
 * Requires super_admin + fresh MFA (401 with "fresh totp" → MfaStepUp).
 */
export async function suspendTenantApi(
  tenantId: string,
  reason?: string,
): Promise<LifecycleResponse> {
  return adminApi<LifecycleResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/suspend`,
    { method: 'POST', body: JSON.stringify(reason !== undefined ? { reason } : {}) },
  );
}

/**
 * POST /api/admin/super/tenants/:tenantId/resume
 *
 * Transitions suspended → active.
 * Idempotent: already-active returns 200 + noOp:true.
 */
export async function resumeTenantApi(
  tenantId: string,
  reason?: string,
): Promise<LifecycleResponse> {
  return adminApi<LifecycleResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/resume`,
    { method: 'POST', body: JSON.stringify(reason !== undefined ? { reason } : {}) },
  );
}

/**
 * POST /api/admin/super/tenants/:tenantId/archive
 *
 * Transitions active or suspended → archived. Destroys all active sessions.
 * Idempotent: already-archived returns 200 + noOp:true.
 */
export async function archiveTenantApi(
  tenantId: string,
  reason?: string,
): Promise<LifecycleResponse> {
  return adminApi<LifecycleResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/archive`,
    { method: 'POST', body: JSON.stringify(reason !== undefined ? { reason } : {}) },
  );
}

/**
 * POST /api/admin/super/tenants/:tenantId/unarchive
 *
 * Transitions archived → active.
 * Idempotent: already-active returns 200 + noOp:true.
 */
export async function unarchiveTenantApi(
  tenantId: string,
  reason?: string,
): Promise<LifecycleResponse> {
  return adminApi<LifecycleResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/unarchive`,
    { method: 'POST', body: JSON.stringify(reason !== undefined ? { reason } : {}) },
  );
}

export interface ResendInvitationResponse {
  invitation: {
    id: string;
    email: string;
    role: 'admin' | 'reviewer';
    expires_at: string;
  };
}

export async function resendInvitationApi(
  tenantId: string,
): Promise<ResendInvitationResponse> {
  return adminApi<ResendInvitationResponse>(
    `/admin/super/tenants/${tenantId}/invitations/resend`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * POST /api/auth/totp/verify
 *
 * MFA step-up for super-admin operations requiring fresh TOTP.
 * Refreshes the session's MFA freshness on success.
 */
export async function verifyTotpApi(code: string): Promise<void> {
  return adminApi<void>("/auth/totp/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

// ---------------------------------------------------------------------------
// Typed helpers — list questions with filters (Slice 2.2/D5)
// ---------------------------------------------------------------------------

export interface ListQuestionsFilters {
  status?: string;
  domain_id?: string;
  category_id?: string;
  pageSize?: number;
  page?: number;
}

export interface QuestionListItem {
  id: string;
  type: string;
  topic: string | null;
  status: string;
  content: Record<string, unknown>;
  rubric: Record<string, unknown> | null;
  domain_id: string | null;
  category_id: string | null;
}

/**
 * GET /api/admin/questions with filters.
 * Returns items for the durable Review screen (Slice 2.2/D5).
 */
export async function listQuestionsApi(
  filters: ListQuestionsFilters = {},
): Promise<{ items: QuestionListItem[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.domain_id !== undefined) params.set("domain_id", filters.domain_id);
  if (filters.category_id !== undefined) params.set("category_id", filters.category_id);
  if (filters.pageSize !== undefined) params.set("pageSize", String(filters.pageSize));
  if (filters.page !== undefined) params.set("page", String(filters.page));
  const qs = params.toString();
  return adminApi<{ items: QuestionListItem[]; total: number }>(
    `/admin/questions${qs ? `?${qs}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — A2 billing (super-admin + company-admin)
// ---------------------------------------------------------------------------

export interface TenantBillingDetail {
  tenant_id: string;
  tier: 'free' | 'pro' | 'enterprise' | 'internal';
  included_credits: number | null;
  status: 'active' | 'suspended';
  cycle_start: string; // ISO 8601
  used: number;
  remaining: number | null;
  overage: number;
  usage_status: 'ok' | 'warn' | 'over' | 'unlimited';
  recent_events: Array<{
    id: string;
    attempt_id: string;
    event_type: string;
    occurred_at: string;
  }>;
}

export interface UpdateTenantPlanRequest {
  tier?: string;
  includedCredits?: number | null;
}

export interface UpdateTenantPlanResponse {
  tenant_id: string;
  tier: string;
  included_credits: number | null;
  previous: { tier: string; included_credits: number | null };
  updatedAt: string;
  auditId: string;
}

/**
 * GET /api/admin/super/tenants/:tenantId/billing
 *
 * Super-admin only. Returns the full billing detail for a single tenant.
 */
export async function getTenantBillingDetail(
  tenantId: string,
): Promise<TenantBillingDetail> {
  return adminApi<TenantBillingDetail>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/billing`,
  );
}

/**
 * PATCH /api/admin/super/tenants/:tenantId/plan
 *
 * Super-admin only. Update a tenant's billing plan (tier + includedCredits).
 * Returns the updated plan + previous values + the audit log row id.
 */
export async function updateTenantPlan(
  tenantId: string,
  body: UpdateTenantPlanRequest,
): Promise<UpdateTenantPlanResponse> {
  return adminApi<UpdateTenantPlanResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/plan`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

/**
 * Build the absolute URL for downloading a tenant's billing events as CSV.
 *
 * Returns a path suitable for use as an <a href download> target.
 */
export function tenantBillingCsvUrl(tenantId: string): string {
  return `${API_BASE}/admin/super/tenants/${encodeURIComponent(tenantId)}/billing/export.csv`;
}

export interface CompanyUsage {
  tier: 'free' | 'pro' | 'enterprise' | 'internal';
  included_credits: number | null;
  used: number;
  remaining: number | null;
  overage: number;
  status: 'ok' | 'warn' | 'over' | 'unlimited';
}

/**
 * GET /api/billing/usage
 *
 * Company-admin endpoint (A1). Returns the current tenant's billing usage.
 * Used by UsageBanner and the billing page "Your plan & usage" card.
 */
export async function getCompanyUsage(): Promise<CompanyUsage> {
  return adminApi<CompanyUsage>("/billing/usage");
}

// ---------------------------------------------------------------------------
// Typed helpers — B1 entitlements (super-admin + company-admin)
// ---------------------------------------------------------------------------

export interface TenantEntitlement {
  id: string;
  tenant_id: string;
  scope_type: 'domain' | 'pack';
  scope_id: string;
  status: 'active' | 'revoked';
  granted_at: string; // ISO 8601
  granted_by: string | null;
}

export interface GrantEntitlementRequest {
  scopeType: 'domain' | 'pack';
  scopeId: string;
}

/**
 * GET /api/admin/super/tenants/:tenantId/entitlements
 *
 * Super-admin only. Returns all entitlements (active + revoked) for a tenant.
 */
export async function getTenantEntitlements(
  tenantId: string,
): Promise<{ entitlements: TenantEntitlement[] }> {
  return adminApi<{ entitlements: TenantEntitlement[] }>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/entitlements`,
  );
}

/**
 * POST /api/admin/super/tenants/:tenantId/entitlements
 *
 * Super-admin only. Grant a scope entitlement to a tenant.
 * Idempotent: re-granting reactivates a revoked row.
 */
export async function grantTenantEntitlement(
  tenantId: string,
  body: GrantEntitlementRequest,
): Promise<{ tenant_id: string; scope_type: string; scope_id: string; status: 'active'; auditId: string }> {
  return adminApi<{ tenant_id: string; scope_type: string; scope_id: string; status: 'active'; auditId: string }>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/entitlements`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/**
 * DELETE /api/admin/super/tenants/:tenantId/entitlements
 *
 * Super-admin only. Revoke an active scope entitlement from a tenant.
 * Uses DELETE-with-body (scopeType + scopeId in the body).
 * Throws 404 (ENTITLEMENT_NOT_FOUND) if nothing active to revoke.
 */
export async function revokeTenantEntitlement(
  tenantId: string,
  body: GrantEntitlementRequest,
): Promise<{ revoked: true; tenant_id: string; scope_type: string; scope_id: string; status: 'revoked'; auditId: string }> {
  return adminApi<{ revoked: true; tenant_id: string; scope_type: string; scope_id: string; status: 'revoked'; auditId: string }>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/entitlements`,
    { method: 'DELETE', body: JSON.stringify(body) },
  );
}

/**
 * GET /api/billing/entitlements
 *
 * Company-admin endpoint (B1). Returns the current tenant's active entitlements.
 * RLS-scoped: only the calling tenant's own active rows are returned.
 */
export async function getCompanyEntitlements(): Promise<{ entitlements: TenantEntitlement[] }> {
  return adminApi<{ entitlements: TenantEntitlement[] }>('/billing/entitlements');
}

// ---------------------------------------------------------------------------
// Typed helpers — D1 content-scopes (super-admin billing drawer)
// ---------------------------------------------------------------------------

export interface ContentScopeItem {
  id: string;
  name: string;
  domain: string;
}

export interface TenantContentScopes {
  domains: string[];
  packs: ContentScopeItem[];
}

/**
 * GET /api/admin/super/tenants/:tenantId/content-scopes
 *
 * Super-admin only. Returns the distinct domain labels and pack list for a
 * tenant so the billing drawer grant form can use a dropdown instead of a
 * free-text scope_id input.
 */
export async function getTenantContentScopes(
  tenantId: string,
): Promise<TenantContentScopes> {
  return adminApi<TenantContentScopes>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/content-scopes`,
  );
}
