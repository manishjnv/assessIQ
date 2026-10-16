// RW-59: Aiken text import, MCQ only. Item = question line(s), "A. text" option lines (A-H), "ANSWER: C".
import { IMPORT_MAX_ROWS } from "../limits.js";
import type { ParseResult } from "../types.js";
import { defaultTopic, mcqRow, tooManyRows } from "./common.js";

const OPTION = /^([A-H])[.)]\s+(.*)$/;

export function parseAiken(text: string): ParseResult {
  const items = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).filter((b) => b.trim() !== "");
  if (items.length > IMPORT_MAX_ROWS) throw tooManyRows();
  const out: ParseResult = { rows: [], errors: [] };
  items.forEach((src, k) => {
    const row = k + 1;
    const q: string[] = [];
    const options: string[] = [];
    let answer: string | undefined;
    for (const l of src.split("\n").map((x) => x.trim()).filter((x) => x !== "")) {
      const a = /^ANSWER\s*:\s*(\S+)\s*$/i.exec(l);
      const o = OPTION.exec(l);
      if (a) answer = a[1]!;
      else if (o && o[1]!.charCodeAt(0) - 65 === options.length) options.push(o[2]!.trim());
      else if (options.length === 0) q.push(l);
      else { out.errors.push({ row, column: "options", message: `unexpected line after options: '${l.slice(0, 40)}'` }); return; }
    }
    const question = q.join(" ");
    if (question === "") { out.errors.push({ row, column: "question", message: "question text is missing" }); return; }
    if (options.length < 2) { out.errors.push({ row, column: "options", message: "at least two options (A. B.) are required" }); return; }
    const idx = answer !== undefined && /^[A-H]$/i.test(answer) ? answer.toUpperCase().charCodeAt(0) - 65 : -1;
    if (idx < 0 || idx >= options.length) {
      out.errors.push({ row, column: "correct", message: "ANSWER line is missing or does not name an option letter" });
      return;
    }
    out.rows.push(mcqRow(row, defaultTopic(question), question, options, idx, "Imported from Aiken"));
  });
  return out;
}
