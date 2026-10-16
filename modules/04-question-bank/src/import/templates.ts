// RW-58: per-type import templates, generated from the registry (no per-type switch).
import ExcelJS from "exceljs";
import { csvCell } from "@assessiq/core";
import { getQuestionType, type QuestionType } from "@assessiq/question-types";
import type { ImportFormat } from "./types.js";

/** Columns every type shares; the rest come from the registry's importColumns. */
export const COMMON_COLUMNS = ["type", "topic", "points", "level", "negative_marks"] as const;

export function templateRows(type: QuestionType): { header: string[]; example: string[] } {
  const cols = getQuestionType(type).importColumns;
  return {
    header: [...COMMON_COLUMNS, ...cols.map((c) => c.key)],
    example: [type, "Example topic", "1", "1", "", ...cols.map((c) => (c.required ? "replace me" : ""))],
  };
}

export async function buildTemplate(type: QuestionType, format: ImportFormat): Promise<Buffer> {
  const { header, example } = templateRows(type);
  if (format === "csv") {
    return Buffer.from([header, example].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", "utf8");
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "AssessIQ";
  const ws = wb.addWorksheet(type);
  ws.addRow(header);
  ws.addRow(example);
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
