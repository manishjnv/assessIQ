// RW-58: super-admin question import helpers (CSV/XLSX -> staged report -> commit | discard). Kept out of src/api.ts.
import { adminApi } from "../api.js";

export type ImportFormat = "csv" | "xlsx";
export type ImportDecision = "ok" | "error" | "duplicate" | "skip";

export interface ImportRowError {
  row: number;
  column: string;
  message: string;
}

export interface ImportRow {
  row: number;
  decision: ImportDecision;
  errors: ImportRowError[];
  raw: Record<string, string>;
  normalized?: unknown;
}

export interface ImportReport {
  importId: string;
  status: string;
  counts: { total: number; ok: number; error: number; duplicate: number; skip: number };
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
  content_base64: string;
  domain: string;
  pack_name?: string;
}

export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export async function uploadImportApi(input: ImportUploadInput): Promise<ImportReport> {
  return adminApi<ImportReport>("/admin/super/question-imports", { method: "POST", body: JSON.stringify(input) });
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
export async function downloadImportTemplate(type: string, format: ImportFormat): Promise<void> {
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
