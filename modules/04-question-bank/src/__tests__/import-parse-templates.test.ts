/**
 * RW-58: CSV/XLSX parser + templates (no database).
 * - mcq and subjective fixtures parse to identical ParsedRow from CSV and XLSX.
 * - templates round-trip (build -> parse) for every registered type, both formats.
 * - validateRow runs rows through the registry.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { QUESTION_TYPES } from "@assessiq/question-types";
import { parseImportFile } from "../import/parse.js";
import { buildTemplate, templateRows } from "../import/templates.js";
import { validateRow } from "../import/staging.js";

const HEADER = ["type", "topic", "points", "level", "question", "options", "correct", "rationale"];
const ROWS = [
  ["mcq", "Networking", "2", "1", "Which port is HTTPS?", '["80","443","22"]', "1", "HTTPS uses 443"],
  ["subjective", "Policy", "5", "1", "Explain least privilege.", "", "", ""],
];

async function xlsxOf(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("q");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const csvOf = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n"), "utf8");

describe("parseImportFile", () => {
  it("CSV and XLSX give the same ParsedRow for mcq and subjective", async () => {
    const all = [HEADER, ...ROWS];
    const fromCsv = await parseImportFile("csv", csvOf(all));
    const fromXlsx = await parseImportFile("xlsx", await xlsxOf(all));
    expect(fromCsv.errors).toEqual([]);
    expect(fromCsv.rows).toHaveLength(2);
    expect(fromXlsx.rows).toEqual(fromCsv.rows);
    expect(fromCsv.rows[0]!.cells["options"]).toBe('["80","443","22"]');
    expect(fromCsv.rows[0]!.row).toBe(2);
  });

  it("a row with extra cells is a RowError, not an exception", async () => {
    const r = await parseImportFile("csv", Buffer.from("type,topic\r\nmcq,a,EXTRA\r\nmcq,b\r\n"));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 2 });
    expect(r.rows.map((x) => x.row)).toEqual([3]);
  });

  it("missing type column is a file-level error", async () => {
    await expect(parseImportFile("csv", Buffer.from("topic\r\nx\r\n"))).rejects.toThrow(/type/);
  });
});

describe("templates", () => {
  for (const type of QUESTION_TYPES) {
    it(`round-trips ${type} in csv and xlsx`, async () => {
      const { header, example } = templateRows(type);
      const csv = await parseImportFile("csv", await buildTemplate(type, "csv"));
      const xlsx = await parseImportFile("xlsx", await buildTemplate(type, "xlsx"));
      expect(csv.errors).toEqual([]);
      expect(csv.rows).toHaveLength(1);
      expect(Object.keys(csv.rows[0]!.cells)).toEqual(header);
      expect(csv.rows[0]!.cells["type"]).toBe(type);
      expect(Object.values(csv.rows[0]!.cells)).toEqual(example);
      expect(xlsx.rows).toEqual(csv.rows);
    });
  }
});

describe("validateRow", () => {
  const good = { type: "mcq", topic: "t", points: "1", level: "1", question: "Q?", options: '["a","b"]', correct: "1", rationale: "r" };
  it("accepts a valid mcq row (numeric correct read from text)", () => {
    const v = validateRow(2, good);
    expect(v.errors).toEqual([]);
    expect(v.normalized?.content).toMatchObject({ correct: 1, options: ["a", "b"] });
  });
  it("reports column-level errors", () => {
    const v = validateRow(3, { ...good, correct: "9" });
    expect(v.normalized).toBeNull();
    expect(v.errors[0]).toMatchObject({ row: 3, column: "correct" });
    expect(validateRow(4, { ...good, type: "nope" }).errors[0]).toMatchObject({ column: "type" });
  });
});
