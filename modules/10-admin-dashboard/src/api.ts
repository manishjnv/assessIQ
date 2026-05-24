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
// Typed helpers — generation-attempts list (resume-on-return for the wizard)
// ---------------------------------------------------------------------------

export type GenerationAttemptStatus = "success" | "partial" | "failed" | "running";

/**
 * Minimal generation-attempt summary used by the generate wizard to detect and
 * resume a run that is still in flight server-side. The full row shape lives in
 * generation-attempts.tsx (the history page); this only carries what the wizard
 * needs to render an "in progress" panel and poll for completion.
 */
export interface GenerationAttemptSummary {
  id: string;
  status: GenerationAttemptStatus;
  count_requested: number;
  count_inserted: number;
  pack_id: string;
  level_id: string;
  started_at: string;
  finished_at: string | null;
}

export interface GenerationAttemptsListResponse {
  items: GenerationAttemptSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * List recent generation attempts (super_admin-only endpoint, same one the
 * Generation History page reads). Pass `status: "running"` to find an in-flight
 * run. Single-flight on the server means at most one attempt is "running" at a
 * time, so a small `limit` is sufficient.
 */
export async function listGenerationAttempts(
  opts: { status?: GenerationAttemptStatus; limit?: number } = {},
): Promise<GenerationAttemptsListResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 5));
  if (opts.status) params.set("status", opts.status);
  return adminApi<GenerationAttemptsListResponse>(
    `/admin/generation-attempts?${params.toString()}`,
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
  admin_user_id: string | null;
  admin_email: string | null;
  admin_name: string | null;
  admin_role: string | null;
  admin_status: string | null;
  /** Id of the outstanding (unaccepted) invitation for the primary admin, if any. */
  admin_invitation_id: string | null;
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

export interface SuperUpdateAdminRequest {
  name?: string;
  role?: 'admin' | 'reviewer';
  email?: string;
  /** Required when changing an ACTIVE (accepted) admin's email — confirms the
   *  operator understands this transfers the account's login identity. */
  confirmEmailIdentityChange?: boolean;
  reason?: string;
}

export interface SuperUpdateAdminResponse {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'reviewer';
  previousEmail: string;
  emailChanged: boolean;
  status: string;
  /** True when the user's sessions were swept (email or role change on an active user). */
  sessionsSwept: boolean;
  /** True when a fresh invitation was re-issued to a corrected pending-admin email. */
  reinvited: boolean;
  auditId: string | null;
}

/**
 * PATCH /api/admin/super/users/:userId
 *
 * Super-admin edit of a tenant user's profile (name / role / email). Gate:
 * super_admin + fresh MFA (401 "fresh totp" → MfaStepUp). Email IS the login
 * identity: changing an ACTIVE admin's email requires confirmEmailIdentityChange
 * and signs the admin out; a PENDING admin's email is re-addressed (fresh invite).
 */
export async function superUpdateAdminApi(
  userId: string,
  body: SuperUpdateAdminRequest,
): Promise<SuperUpdateAdminResponse> {
  return adminApi<SuperUpdateAdminResponse>(
    `/admin/super/users/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export interface SuperUpdateTenantResponse {
  tenantId: string;
  name: string;
  previousName: string;
  auditId: string | null;
  noOp: boolean;
}

/**
 * PATCH /api/admin/super/tenants/:tenantId
 *
 * Rename a tenant's display name (the `tenants.name` column). Super-admin +
 * fresh MFA (401 "fresh totp" → MfaStepUp). Slug is permanent and not editable.
 */
export async function superUpdateTenantApi(
  tenantId: string,
  body: { name: string },
): Promise<SuperUpdateTenantResponse> {
  return adminApi<SuperUpdateTenantResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
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
// Typed helpers — Step 2 "Available sets" catalog (company-admin)
// ---------------------------------------------------------------------------

/** A licensed platform-library set the company can assess from (metadata only). */
export interface AvailableSet {
  source_pack_id: string;     // platform pack id
  name: string;
  domain: string;
  source_version: number;
  question_count: number;
  level_count: number;
  cloned: boolean;
  cloned_pack_id: string | null;
  update_available: boolean;
}

/**
 * GET /api/billing/available-sets
 *
 * Company-admin endpoint (Step 2). Returns the published platform-library sets
 * this tenant is licensed for (domain or pack scope). Metadata only — the set is
 * materialised into the tenant via clone-on-use when an assessment is created
 * from it. A domain license surfaces all current AND future sets in that domain.
 */
export async function getAvailableSets(): Promise<{ sets: AvailableSet[] }> {
  return adminApi<{ sets: AvailableSet[] }>('/billing/available-sets');
}

/** Body for createAssessmentFromSet (clone-on-use). opens_at is ISO 8601. */
export interface CreateAssessmentFromSetRequest {
  source_pack_id: string;
  level_position: number;
  name: string;
  question_count: number;
  opens_at: string;
  closes_at?: string | null;
  randomize?: boolean;
  description?: string;
}

/**
 * POST /api/admin/assessments/from-set
 *
 * Company-admin: create a draft assessment from a licensed platform set. The
 * server license-checks the source, clones it into this tenant on first use,
 * and creates the assessment from the clone. Returns the created assessment
 * (201). 403 NOT_LICENSED if the source set isn't licensed for the tenant.
 */
export async function createAssessmentFromSet(
  body: CreateAssessmentFromSetRequest,
): Promise<{ id: string; status: string; pack_id: string; level_id: string }> {
  return adminApi<{ id: string; status: string; pack_id: string; level_id: string }>(
    '/admin/assessments/from-set',
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Minimal platform-pack option for the SA pack-scope grant dropdown (Step 2 5a). */
export interface PlatformPackOption {
  id: string;
  name: string;
  domain: string;
  status: string;
}

/**
 * GET /api/admin/packs — platform master library (super-admin only).
 *
 * The super-admin session operates inside the platform tenant, so this
 * RLS-scoped list returns the master-library packs. Used to populate the
 * pack-scope grant dropdown in the platform billing drawer (5a). Filtered to
 * status='published' client-side — a pack grant's scope_id is the PLATFORM pack
 * id, which assertPublishEntitled matches against a clone's source_pack_id.
 * Reuses the existing list route; no new backend endpoint.
 */
export async function listPlatformPublishedPacks(): Promise<{ packs: PlatformPackOption[] }> {
  const data = await adminApi<{ items: PlatformPackOption[] }>("/admin/packs?pageSize=200");
  return { packs: (data.items ?? []).filter((p) => p.status === "published") };
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

// ---------------------------------------------------------------------------
// Typed helpers — user lifecycle (Phase C tenant-admin)
// ---------------------------------------------------------------------------

export interface UserLifecycleResponse {
  userId: string;
  status?: 'active' | 'disabled' | 'pending';
  previousStatus?: string;
  deleted?: boolean;
}

function userLifecycleBody(reason?: string): string {
  return JSON.stringify(reason !== undefined ? { reason } : {});
}

/**
 * POST /api/admin/users/:userId/disable
 * Tenant-admin only. Signs the user out and prevents future logins.
 * Error codes: CANNOT_DISABLE_SELF (400), LAST_ADMIN (409).
 */
export async function disableUserApi(
  userId: string,
  reason?: string,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/users/${encodeURIComponent(userId)}/disable`,
    { method: 'POST', body: userLifecycleBody(reason) },
  );
}

/**
 * POST /api/admin/users/:userId/reenable
 * Tenant-admin only. Allows the user to sign in again.
 */
export async function reenableUserApi(
  userId: string,
  reason?: string,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/users/${encodeURIComponent(userId)}/reenable`,
    { method: 'POST', body: userLifecycleBody(reason) },
  );
}

/**
 * DELETE /api/admin/users/:userId
 * Tenant-admin only. Soft-deletes the user (data preserved 6 months).
 * Error codes: CANNOT_DELETE_SELF (400), LAST_ADMIN (409).
 */
export async function softDeleteUserApi(
  userId: string,
  reason?: string,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: 'DELETE', body: userLifecycleBody(reason) },
  );
}

/**
 * POST /api/admin/users/:userId/restore
 * Tenant-admin only. Restores a soft-deleted user (re-enables separately).
 */
export async function restoreUserApi(
  userId: string,
  reason?: string,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/users/${encodeURIComponent(userId)}/restore`,
    { method: 'POST', body: userLifecycleBody(reason) },
  );
}

/**
 * DELETE /api/admin/users/invitations/:invitationId
 * Tenant-admin only. Cancels a pending invitation and removes the pending user record.
 * Error codes: INVITATION_ALREADY_ACCEPTED (409), INVITATION_NOT_FOUND (404).
 */
export async function cancelInvitationApi(
  invitationId: string,
  reason?: string,
): Promise<{ invitationId: string; cancelled: true }> {
  return adminApi<{ invitationId: string; cancelled: true }>(
    `/admin/users/invitations/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', body: userLifecycleBody(reason) },
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — user lifecycle (Phase C super-admin overrides)
// ---------------------------------------------------------------------------

function superUserLifecycleBody(reason?: string, confirmLastAdmin?: boolean): string {
  const body: { reason?: string; confirm_last_admin?: boolean } = {};
  if (reason !== undefined) body.reason = reason;
  if (confirmLastAdmin !== undefined) body.confirm_last_admin = confirmLastAdmin;
  return JSON.stringify(body);
}

/**
 * POST /api/admin/super/users/:userId/disable
 * Super-admin override. audit row carries is_override:true when bypass fires.
 * Pass confirmLastAdmin:true to intentionally orphan a tenant.
 */
export async function superDisableUserApi(
  userId: string,
  reason?: string,
  confirmLastAdmin?: boolean,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/super/users/${encodeURIComponent(userId)}/disable`,
    { method: 'POST', body: superUserLifecycleBody(reason, confirmLastAdmin) },
  );
}

/**
 * POST /api/admin/super/users/:userId/reenable
 */
export async function superReenableUserApi(
  userId: string,
  reason?: string,
  confirmLastAdmin?: boolean,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/super/users/${encodeURIComponent(userId)}/reenable`,
    { method: 'POST', body: superUserLifecycleBody(reason, confirmLastAdmin) },
  );
}

/**
 * DELETE /api/admin/super/users/:userId
 */
export async function superSoftDeleteUserApi(
  userId: string,
  reason?: string,
  confirmLastAdmin?: boolean,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/super/users/${encodeURIComponent(userId)}`,
    { method: 'DELETE', body: superUserLifecycleBody(reason, confirmLastAdmin) },
  );
}

/**
 * POST /api/admin/super/users/:userId/restore
 */
export async function superRestoreUserApi(
  userId: string,
  reason?: string,
  confirmLastAdmin?: boolean,
): Promise<UserLifecycleResponse> {
  return adminApi<UserLifecycleResponse>(
    `/admin/super/users/${encodeURIComponent(userId)}/restore`,
    { method: 'POST', body: superUserLifecycleBody(reason, confirmLastAdmin) },
  );
}

/**
 * DELETE /api/admin/super/users/invitations/:invitationId
 */
export async function superCancelInvitationApi(
  invitationId: string,
  reason?: string,
  confirmLastAdmin?: boolean,
): Promise<{ invitationId: string; cancelled: true }> {
  return adminApi<{ invitationId: string; cancelled: true }>(
    `/admin/super/users/invitations/${encodeURIComponent(invitationId)}`,
    { method: 'DELETE', body: superUserLifecycleBody(reason, confirmLastAdmin) },
  );
}

// ---------------------------------------------------------------------------
// Typed helpers — super-admin scoped user list (Phase C)
// ---------------------------------------------------------------------------

export interface SuperUserListItem {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuperPendingInvitation {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

export interface SuperUserListResponse {
  users: SuperUserListItem[];
  pending_invitations: SuperPendingInvitation[];
}

/**
 * GET /api/admin/super/tenants/:tenantId/users
 *
 * Super-admin only. Returns users + pending invitations for a tenant.
 * Pass includeDisabled / includeDeleted to widen the result set.
 */
export async function listTenantUsersAsSuperApi(
  tenantId: string,
  opts?: { includeDisabled?: boolean; includeDeleted?: boolean },
): Promise<SuperUserListResponse> {
  const params = new URLSearchParams();
  if (opts?.includeDisabled) params.set('include_disabled', 'true');
  if (opts?.includeDeleted) params.set('include_deleted', 'true');
  const qs = params.toString();
  return adminApi<SuperUserListResponse>(
    `/admin/super/tenants/${encodeURIComponent(tenantId)}/users${qs ? `?${qs}` : ''}`,
  );
}
