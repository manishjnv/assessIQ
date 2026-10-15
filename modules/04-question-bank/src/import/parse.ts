// RW-58: CSV + XLSX reader. Both produce the same ParsedRow[]; malformed rows become
// RowError entries. Only file-level problems (unreadable file, no `type` header) throw.
import ExcelJS from "exceljs";
import { ValidationError } from "@assessiq/core";
import type { ImportFormat, ParsedRow, ParseResult, RowError } from "./types.js";

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 2000;

/** RFC-4180 tokenizer (same approach as 03-users/import.ts; no dependency). */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (inQuotes) throw new ValidationError("CSV has an unterminated quoted field", { details: { code: "IMPORT_CSV_MALFORMED" } });
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return v.result === undefined || v.result === null ? "" : String(v.result);
    if ("text" in v) return String(v.text); // hyperlink
    return "";
  }
  return String(v);
}

async function readXlsx(data: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError("File is not a readable .xlsx workbook", { details: { code: "IMPORT_XLSX_UNREADABLE" } });
  }
  const ws = wb.worksheets[0];
  if (ws === undefined) throw new ValidationError("Workbook has no sheet", { details: { code: "IMPORT_XLSX_EMPTY" } });
  const out: string[][] = [];
  const width = ws.columnCount;
  // Blank rows stay as empty arrays so index + 1 === sheet row number.
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
    out.push(cells);
  }
  return out;
}

export async function parseImportFile(format: ImportFormat, data: Buffer): Promise<ParseResult> {
  if (data.byteLength > IMPORT_MAX_BYTES) {
    throw new ValidationError(`File exceeds ${IMPORT_MAX_BYTES / 1024} KB`, { details: { code: "IMPORT_TOO_LARGE" } });
  }
  let all: string[][];
  if (format === "csv") {
    const text = data.toString("utf8");
    all = tokenizeCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } else {
    all = await readXlsx(data);
  }
  // Header = first non-blank row.
  const headerAt = all.findIndex((r) => r.some((c) => c.trim() !== ""));
  const header = headerAt < 0 ? [] : all[headerAt]!.map((h) => h.trim().toLowerCase());
  if (!header.includes("type")) {
    throw new ValidationError('Header row must contain a "type" column', { details: { code: "IMPORT_MISSING_TYPE_COLUMN" } });
  }
  const rows: ParsedRow[] = [];
  const errors: RowError[] = [];
  for (let i = headerAt + 1; i < all.length; i++) {
    const cells = all[i]!;
    if (cells.every((c) => c.trim() === "")) continue;
    if (rows.length + errors.length >= IMPORT_MAX_ROWS) {
      throw new ValidationError(`File exceeds ${IMPORT_MAX_ROWS} data rows`, { details: { code: "IMPORT_TOO_MANY_ROWS" } });
    }
    if (cells.slice(header.length).some((c) => c.trim() !== "")) {
      errors.push({ row: i + 1, column: "", message: "row has more cells than the header" });
      continue;
    }
    const rec: Record<string, string> = {};
    header.forEach((h, k) => { if (h !== "") rec[h] = (cells[k] ?? "").trim(); });
    rows.push({ row: i + 1, cells: rec });
  }
  return { rows, errors };
}
