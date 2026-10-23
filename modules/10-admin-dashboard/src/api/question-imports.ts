// RW-58: super-admin question import helpers (CSV/XLSX -> staged report -> commit | discard). Kept out of src/api.ts.
import { AdminApiError, adminApi } from "../api.js";
import type { ApiError } from "../api.js";

export type ImportFormat = "csv" | "xlsx" | "gift" | "aiken" | "qti";
/** Formats that have a downloadable template. */
export type TemplateFormat = "csv" | "xlsx";
export type ImportDecision = "ok" | "error" | "duplicate" | "skip";
/** EXP-4: which duplicate check hit a row. 'similar' is a warning; the row stays ready. */
export type DupClass = "exact" | "normalised" | "similar";

export interface ImportRowError {
  row: number;
  column: string;
  message: string;
}

export interface ImportRow {
  row: number;
  decision: ImportDecision;
  dupClass?: DupClass | null;
  errors: ImportRowError[];
  raw: Record<string, string>;
  normalized?: unknown;
}

export interface ImportReport {
  importId: string;
  status: string;
  counts: { total: number; ok: number; error: number; duplicate: number; skip: number };
  duplicateClasses?: Record<DupClass, number>;
  /** Duplicate checks that ran; 'similar' is missing when the database has no pg_trgm. */
  checksRun?: DupClass[];
  rows: ImportRow[];
}

export interface ImportCommitResult {
  importId: string;
  packId: string;
  committed: number;
}

export interface ImportUploadInput {
  file_name: string;
  format: ImportFormat;
  file: File | Blob;
  domain: string;
  pack_name?: string;
  /** EXP-36: append to this existing set instead of creating one. */
  target_pack_id?: string;
  /** EXP-36: the level position every row goes to (needs target_pack_id). Omitted = the file's level column. */
  target_level_position?: number;
}

export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/** Multipart upload. No content-type header here: the browser adds the boundary. The file goes LAST (the server reads the fields before it). */
export async function uploadImportApi(input: ImportUploadInput): Promise<ImportReport> {
  const form = new FormData();
  form.append("format", input.format);
  form.append("domain", input.domain);
  if (input.pack_name) form.append("pack_name", input.pack_name);
  if (input.target_pack_id) form.append("target_pack_id", input.target_pack_id);
  if (input.target_level_position !== undefined) form.append("target_level_position", String(input.target_level_position));
  form.append("file_name", input.file_name);
  form.append("file", input.file, input.file_name);
  const res = await fetch("/api/admin/super/question-imports", { method: "POST", body: form, credentials: "include" });
  if (!res.ok) {
    let body: { error?: ApiError };
    try { body = (await res.json()) as { error?: ApiError }; } catch { body = {}; }
    throw new AdminApiError(res.status, body.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  }
  return (await res.json()) as ImportReport;
}

export async function getImportApi(id: string): Promise<ImportReport> {
  return adminApi<ImportReport>(`/admin/super/question-imports/${encodeURIComponent(id)}`);
}

export async function fixImportRowApi(
  id: string,
  row: number,
  body: { values?: Record<string, string>; skip?: boolean },
): Promise<ImportReport> {
  return adminApi<ImportReport>(`/admin/super/question-imports/${encodeURIComponent(id)}/rows/${row}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function commitImportApi(id: string): Promise<ImportCommitResult> {
  return adminApi<ImportCommitResult>(`/admin/super/question-imports/${encodeURIComponent(id)}/commit`, { method: "POST" });
}

export async function discardImportApi(id: string): Promise<unknown> {
  return adminApi<unknown>(`/admin/super/question-imports/${encodeURIComponent(id)}/discard`, { method: "POST" });
}

/** Downloads the template file for one question type (browser save). `org` selects the organisation route. Literal paths: tools/lint-ui-api-contract.ts reads them. */
export async function downloadImportTemplate(
  type: string, format: TemplateFormat, org = false,
): Promise<void> {
  const res = await fetch(org
    ? `/api/admin/question-imports/templates/${encodeURIComponent(type)}?format=${format}`
    : `/api/admin/super/question-imports/templates/${encodeURIComponent(type)}?format=${format}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("template");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `question-import-${type}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// EXP-17: organisation upload (tenant admin). Same flow as above under /api/admin/question-imports.
// ---------------------------------------------------------------------------

export type OrgRightsStatus = "original" | "derived_from_source" | "licensed";

export interface OrgUploadInput {
  file_name: string;
  format: "csv" | "xlsx";
  file: File | Blob;
  domain: string;
  pack_name?: string;
  source_ref?: string;
  /** EXP-17: optional free-text note, max 500 characters. Sent only when not empty. */
  source_note?: string;
  rights_status: OrgRightsStatus;
  /** EXP-36: append to this existing set instead of creating one. */
  target_pack_id?: string;
  /** EXP-36: the level position every row goes to (needs target_pack_id). */
  target_level_position?: number;
}

export interface OrgUploadItem {
  id: string;
  file_name: string;
  format: string;
  status: string;
  row_count: number;
  error_count: number;
  rights_status: string | null;
  created_at: string;
  committed_pack_id: string | null;
  question_count: number;
  withdrawn_count: number;
  /** Generated at commit (ORG-...); null while the upload is only checked. */
  licence_id: string | null;
  source_note: string | null;
}

/** EXP-17 plan limits. null = no limit, 0 = not allowed. */
export interface OrgUploadLimits {
  perUpload: number | null;
  perMonth: number | null;
  total: number | null;
}

export interface OrgUploadUsage {
  uploads_this_month: number;
  questions_total: number;
}

/** The list response. The plan fields are missing on an older API; the page then hides the plan panel. */
export interface OrgUploadListResponse {
  items: OrgUploadItem[];
  tiers_enforced?: boolean;
  limits?: OrgUploadLimits;
  usage?: OrgUploadUsage;
}

const ORG_BASE = "/api/admin/question-imports";

/** Multipart upload with the rights warranty. Text fields first, file last (the server reads in order). */
export async function uploadOrgImportApi(input: OrgUploadInput): Promise<ImportReport> {
  const form = new FormData();
  form.append("format", input.format);
  form.append("domain", input.domain);
  if (input.pack_name) form.append("pack_name", input.pack_name);
  if (input.source_ref) form.append("source_ref", input.source_ref);
  if (input.source_note) form.append("source_note", input.source_note);
  if (input.target_pack_id) form.append("target_pack_id", input.target_pack_id);
  if (input.target_level_position !== undefined) form.append("target_level_position", String(input.target_level_position));
  form.append("rights_status", input.rights_status);
  form.append("content_warranty", "true");
  form.append("file_name", input.file_name);
  form.append("file", input.file, input.file_name);
  const res = await fetch(ORG_BASE, { method: "POST", body: form, credentials: "include" });
  if (!res.ok) {
    let body: { error?: ApiError };
    try { body = (await res.json()) as { error?: ApiError }; } catch { body = {}; }
    throw new AdminApiError(res.status, body.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  }
  return (await res.json()) as ImportReport;
}

export async function commitOrgImportApi(id: string): Promise<ImportCommitResult> {
  return adminApi<ImportCommitResult>(`/admin/question-imports/${encodeURIComponent(id)}/commit`, { method: "POST" });
}

export async function discardOrgImportApi(id: string): Promise<unknown> {
  return adminApi<unknown>(`/admin/question-imports/${encodeURIComponent(id)}/discard`, { method: "POST" });
}

export async function listOrgUploadsApi(): Promise<OrgUploadListResponse> {
  return adminApi<OrgUploadListResponse>("/admin/question-imports");
}

export async function withdrawOrgUploadApi(id: string): Promise<{ importId: string; withdrawn: number }> {
  return adminApi<{ importId: string; withdrawn: number }>(`/admin/question-imports/${encodeURIComponent(id)}/withdraw`, { method: "POST" });
}

export function downloadOrgImportTemplate(type: string, format: TemplateFormat): Promise<void> {
  return downloadImportTemplate(type, format, true);
}

// isTierLocked (403 TIER_NOT_INCLUDED) lives in ./tier-lock.ts (Z-80). Re-exported for the upload page.
export { isTierLocked } from "./tier-lock.js";
