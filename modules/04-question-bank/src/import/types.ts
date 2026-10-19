// RW-58: CSV/XLSX question import. Shared shapes.

export type ImportFormat = "csv" | "xlsx" | "gift" | "aiken" | "qti";
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
  /** EX-1: optional penalty for a wrong attempted answer; null = the assessment default. */
  negative_marks: number | null;
  content: Record<string, unknown>;
  /** EXP-4 (import v2). Absent on rows staged before v2; commit then falls back to original / original_human. */
  meta?: RowMeta;
}

export type DupClass = "exact" | "normalised" | "similar";

export interface RowMeta {
  origin: "original_human" | "ai_original" | "ai_seeded" | "derived_from_source" | "scraped_raw" | "tenant_upload" | "licensed";
  rightsStatus: "original" | "derived_from_source" | "scraped_raw" | "licensed" | "metadata_only";
  sourceRef: string | null;
  sourceUrl: string | null;
  seedRef: string | null;
  /** The label as written in the file; difficultyEst is its 1..5 mapping. */
  sourceDifficultyRaw: string | null;
  difficultyEst: number | null;
  language: string;
  pyqYear: number | null;
  pyqShift: string | null;
  /** EXP-8: rows with the same passageRef in one file share one passage; passageText is filled for every row of the group at staging. */
  passageRef?: string | null;
  passageText?: string | null;
  /** Resolved taxonomy_nodes ids (Exam structure stage, deepest Subject map node). */
  stageNodeId: string | null;
  subjectNodeId: string | null;
  normalisedHash: string;
  /** Set by the duplicate pass. 'similar' is a warning only (the row stays ok). */
  dupClass?: DupClass | null;
}

export interface DryRunRow {
  row: number;
  decision: ImportDecision;
  /** EXP-4: which duplicate check hit this row, if any. */
  dupClass: DupClass | null;
  errors: RowError[];
  raw: Record<string, string>;
  normalized: NormalizedRow | null;
}

export interface DryRunReport {
  importId: string;
  status: ImportStatus;
  counts: { total: number; ok: number; error: number; duplicate: number; skip: number };
  /** EXP-4: rows per duplicate class, and the classes that ran ('similar' only when pg_trgm exists). */
  duplicateClasses: Record<DupClass, number>;
  checksRun: DupClass[];
  rows: DryRunRow[];
}

export interface CommitResult {
  importId: string;
  packId: string;
  committed: number;
}
