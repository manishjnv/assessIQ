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
}

export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/** Multipart upload. No content-type header here: the browser adds the boundary. The file goes LAST (the server reads the fields before it). */
export async function uploadImportApi(input: ImportUploadInput): Promise<ImportReport> {
  const form = new FormData();
  form.append("format", input.format);
  form.append("domain", input.domain);
  if (input.pack_name) form.append("pack_name", input.pack_name);
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

/** Downloads the template file for one question type (browser save). */
export async function downloadImportTemplate(type: string, format: TemplateFormat): Promise<void> {
  const res = await fetch(`/api/admin/super/question-imports/templates/${encodeURIComponent(type)}?format=${format}`, {
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
