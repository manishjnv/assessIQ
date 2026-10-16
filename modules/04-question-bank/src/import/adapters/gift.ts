// RW-59: GIFT (Moodle) text import, MCQ only. One item = one blank-line separated block.
import { IMPORT_MAX_ROWS } from "../limits.js";
import type { ParseResult } from "../types.js";
import { defaultTopic, mcqRow, tooManyRows } from "./common.js";

const unesc = (s: string): string => s.replace(/\\([\s\S])/g, "$1");

function findUnescaped(t: string, ch: string, from: number): number {
  for (let i = from; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === ch) return i;
  }
  return -1;
}

interface Opt { mark: string; raw: string; fb: string }

/** Returns a parsed row's pieces, or an error message. */
function parseItem(src: string): { title: string; question: string; options: string[]; correct: number; rationale: string } | string {
  let t = src.trim();
  let title = "";
  if (t.startsWith("::")) {
    const end = t.indexOf("::", 2);
    if (end > 0) { title = unesc(t.slice(2, end).trim()); t = t.slice(end + 2).trim(); }
  }
  const open = findUnescaped(t, "{", 0);
  const close = open < 0 ? -1 : findUnescaped(t, "}", open + 1);
  if (open < 0 || close < 0) return "no { } answer block (description and missing-word items are not supported)";
  const block = t.slice(open + 1, close).trim();
  const question = unesc(`${t.slice(0, open)} ${t.slice(close + 1)}`.replace(/\s+/g, " ").trim());
  if (question === "") return "question text is empty";
  if (block === "") return "essay item is not supported (MCQ only)";
  if (block.startsWith("#")) return "numeric item is not supported (MCQ only)";
  if (/^(TRUE|FALSE|T|F)\s*(#|$)/i.test(block)) return "TRUE/FALSE item is not supported (MCQ only)";
  if (block.includes("->")) return "matching item is not supported (MCQ only)";

  const opts: Opt[] = [];
  let cur: Opt | null = null;
  let inFb = false;
  for (let i = 0; i < block.length; i++) {
    const c = block[i]!;
    if (c === "\\") {
      if (cur) {
        const pair = c + (block[i + 1] ?? "");
        if (inFb) cur.fb += pair; else cur.raw += pair;
      }
      i++;
      continue;
    }
    if (c === "=" || c === "~") { cur = { mark: c, raw: "", fb: "" }; opts.push(cur); inFb = false; continue; }
    if (c === "#" && cur) { inFb = true; continue; }
    if (cur) { if (inFb) cur.fb += c; else cur.raw += c; }
    else if (c.trim() !== "") return "answer block must start with = or ~";
  }
  const eq = opts.filter((o) => o.mark === "=");
  if (eq.length === 0) return "no correct answer (= option)";
  if (eq.length > 1) return "more than one = answer (short-answer and multi-answer items are not supported)";
  if (opts.length < 2) return "short-answer item is not supported (MCQ only)";
  if (opts.some((o) => o.raw.trim().startsWith("%"))) return "weighted answers are not supported";
  const correct = opts.indexOf(eq[0]!);
  const fb = unesc(eq[0]!.fb.trim());
  return { title, question, options: opts.map((o) => unesc(o.raw.trim())), correct, rationale: fb === "" ? "Imported from GIFT" : fb };
}

export function parseGift(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("$CATEGORY"));
  const items = lines.join("\n").split(/\n\s*\n/).filter((b) => b.trim() !== "");
  if (items.length > IMPORT_MAX_ROWS) throw tooManyRows();
  const out: ParseResult = { rows: [], errors: [] };
  items.forEach((src, k) => {
    const row = k + 1;
    const p = parseItem(src);
    if (typeof p === "string") out.errors.push({ row, column: "", message: p });
    else out.rows.push(mcqRow(row, p.title || defaultTopic(p.question), p.question, p.options, p.correct, p.rationale));
  });
  return out;
}
