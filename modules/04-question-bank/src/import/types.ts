// RW-58: CSV/XLSX question import. Shared shapes.

export type ImportFormat = "csv" | "xlsx";
export type ImportDecision = "ok" | "skip" | "duplicate" | "error";
export type ImportStatus = "staged" | "committed" | "discarded";

/** One data row of the upload. `row` is the 1-based line / sheet row; `cells` is keyed by lower-cased header. */
export interface ParsedRow {
  row: number;
  cells: Record<string, string>;
}

export interface RowError {
  row: number;
  column: string;
  message: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Malformed rows (e.g. more cells than headers). Never thrown. */
  errors: RowError[];
}

export interface ImportFileMeta {
  fileName: string;
  fileSha256: string;
  format: ImportFormat;
  /** Target domain slug (must exist in the tenant). */
  domain: string;
  packName: string;
}

export interface NormalizedRow {
  type: string;
  topic: string;
  points: number;
  level: number;
  content: Record<string, unknown>;
}

export interface DryRunRow {
  row: number;
  decision: ImportDecision;
  errors: RowError[];
  raw: Record<string, string>;
  normalized: NormalizedRow | null;
}

export interface DryRunReport {
  importId: string;
  status: ImportStatus;
  counts: { total: number; ok: number; error: number; duplicate: number; skip: number };
  rows: DryRunRow[];
}

export interface CommitResult {
  importId: string;
  packId: string;
  committed: number;
}
