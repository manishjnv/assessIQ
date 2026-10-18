#!/usr/bin/env node
// Z-68: recount the P0-Z open-work tables in docs/ROADMAP.md and compare with the Z.7 counts.
// Rule (ROADMAP Z.7): in Z.2, Z.3, Z.4 and Z.6 a row is closed when its status cell starts
// with a check mark, or with the word "closed" or "done" (rows written after S22). Z.5 rows are all closed. Pointer rows (status "pointer" or "merged into")
// are not counted. Everything else is pending.
// Usage: node tools/roadmap-recount.mjs [--json]
// Exit 0 when the recount equals Z.7, 1 when it differs or ROADMAP cannot be read.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROADMAP = join(ROOT, "docs", "ROADMAP.md");
export const SECTIONS = ["Z.2", "Z.3", "Z.4", "Z.5", "Z.6"];
const CHECK = "✅";
const POINTER = /^(pointer|merged into)/i;
// Rows added after S22 write "closed (S26, ...)" without a check mark; count them closed too.
const CLOSED = /^(closed|done)/i;

export function splitLines(text) {
  return text.split(/\r?\n/);
}

/**
 * Table rows of one P0-Z sub-section ("Z.2" ...) as cell arrays. Cells are split on " | " so that a
 * bare "|" inside a cell does not move the status column. Header and separator rows are skipped.
 * `malformed` counts rows whose cell count differs from the header (a sign of a " | " inside a cell).
 */
export function sectionRows(lines, name) {
  const start = lines.findIndex((l) => l.startsWith(`### ${name} `));
  if (start < 0) throw new Error(`no "### ${name}" heading in ROADMAP`);
  const rows = [];
  let width = null;
  let malformed = 0;
  for (let i = start + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) {
    if (!lines[i].startsWith("|")) continue;
    if (/^\|[\s:|-]+\|?$/.test(lines[i])) continue; // separator row
    const cells = lines[i].replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").split(" | ").map((c) => c.trim());
    if (cells[0] === "ID (aliases)") {
      width = cells.length;
      continue;
    }
    if (width !== null && cells.length !== width) malformed++;
    rows.push(cells);
  }
  return { rows, malformed };
}

/** Status cell (column 5, bold markers removed). */
export const statusOf = (cells) => (cells[4] ?? "").replace(/\*\*/g, "").trim();

/** Counts for one section: live rows, closed, open, and skipped pointer rows. */
export function countSection(name, { rows, malformed }) {
  const live = rows.filter((c) => c[0] && !POINTER.test(statusOf(c)));
  const closed = name === "Z.5" ? live.length : live.filter((c) => statusOf(c).startsWith(CHECK) || CLOSED.test(statusOf(c))).length;
  return {
    section: name,
    rows: live.length,
    closed,
    open: live.length - closed,
    pointers: rows.length - live.length,
    malformed,
  };
}

/** Z.7 numbers: per-section row counts from the counts table, and the newest recount line. */
export function parseZ7(lines) {
  const start = lines.findIndex((l) => /^### Z\.7\b/.test(l));
  if (start < 0) throw new Error('no "### Z.7" heading in ROADMAP');
  let end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start, end);
  const table = {};
  for (const l of body) {
    const m = l.match(/^\| (Z\.[2-6])\b[^|]*\|\s*(\d+)\b/);
    if (m) table[m[1]] = Number(m[2]);
  }
  // Bullets are newest first, so the first recount line with all three totals is the latest.
  let recount = null;
  for (const l of body) {
    const m = l.match(/Pending = [^=]*= (\d+)\. Closed = [^=]*= (\d+)\. Total = (\d+)\./);
    if (m) {
      recount = {
        label: l.replace(/^- /, "").split(",")[0].trim(),
        pending: Number(m[1]),
        closed: Number(m[2]),
        total: Number(m[3]),
      };
      break;
    }
  }
  return { table, recount };
}

/** Full report: per-section counts, totals, and differences against Z.7. */
export function buildReport(lines) {
  const sections = SECTIONS.map((name) => countSection(name, sectionRows(lines, name)));
  const pending = sections.reduce((n, s) => n + s.open, 0);
  const closed = sections.reduce((n, s) => n + s.closed, 0);
  const total = pending + closed;
  const z7 = parseZ7(lines);
  const differences = [];
  for (const s of sections) {
    const want = z7.table[s.section];
    if (want !== undefined && want !== s.rows) differences.push({ what: `${s.section} rows (Z.7 table)`, script: s.rows, z7: want });
  }
  if (z7.recount) {
    const r = z7.recount;
    for (const [what, script, want] of [
      ["pending (recount line)", pending, r.pending],
      ["closed (recount line)", closed, r.closed],
      ["total (recount line)", total, r.total],
    ]) {
      if (script !== want) differences.push({ what, script, z7: want });
    }
  }
  return {
    sections,
    totals: { pending, closed, total, doneSharePct: total ? Math.round((closed / total) * 100) : 0 },
    z7,
    differences,
    same: differences.length === 0,
  };
}

function printReport(report) {
  const out = [
    "Roadmap recount (Z-68). Source: docs/ROADMAP.md, P0-Z tables.",
    "Rule: Z.2, Z.3, Z.4 and Z.6 closed when the status starts with a check mark. Z.5 all closed. Pointer rows skipped.",
    "",
    "Section  Rows  Closed  Open  Pointer rows skipped",
  ];
  for (const s of report.sections) {
    out.push(`${s.section.padEnd(8)} ${String(s.rows).padStart(4)}  ${String(s.closed).padStart(6)}  ${String(s.open).padStart(4)}  ${s.pointers}`);
  }
  const t = report.totals;
  const bad = report.sections.reduce((n, s) => n + s.malformed, 0);
  if (bad) out.push(`Warning: ${bad} row(s) have a cell count that differs from the header. Check for a " | " inside a cell.`);
  out.push("", `Totals: pending ${t.pending}, closed ${t.closed}, total ${t.total}, done share ${t.doneSharePct}%`);
  if (report.z7.recount) {
    const r = report.z7.recount;
    out.push(`Z.7 recount line (${r.label}): pending ${r.pending}, closed ${r.closed}, total ${r.total}`);
  }
  if (report.differences.length) {
    out.push("Differences with Z.7 (script vs Z.7):");
    for (const d of report.differences) out.push(`- ${d.what}: ${d.script} vs ${d.z7} (${d.script - d.z7 >= 0 ? "+" : ""}${d.script - d.z7})`);
  }
  out.push(`Result: ${report.same ? "SAME as Z.7" : "DIFFERENT from Z.7 (exit 1)"}`);
  return out.join("\n");
}

function main() {
  if (!existsSync(ROADMAP)) {
    process.stderr.write("roadmap-recount: missing docs/ROADMAP.md\n");
    process.exitCode = 1;
    return;
  }
  const report = buildReport(splitLines(readFileSync(ROADMAP, "utf8")));
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${printReport(report)}\n`);
  process.exitCode = report.same ? 0 : 1;
}

if (!process.env.VITEST) main();
