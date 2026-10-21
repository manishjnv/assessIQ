#!/usr/bin/env node
// Z-107: shrink the two biggest start-up docs without losing text.
//   A. docs/SESSION_STATE.md keeps the newest N blocks; older blocks go to docs/archive/sessions-YYYY-MM.md.
//   B. docs/ROADMAP.md: everything after the P0-Z part (first "## " after "## P0-Z") goes to docs/archive/ROADMAP-history-YYYY-MM.md.
//   C. docs/ROADMAP.md: closed rows of Z.2..Z.6 become stub rows; full rows go to docs/archive/ROADMAP-closed-rows-YYYY-MM.md.
//   D. Each archive file is recorded in docs/moves.json as an "extract" entry (source file stays in place).
// The roadmap-recount totals must be identical before and after, else nothing is written.
// Usage: node tools/docs-archive.mjs [--root <dir>] [--dry-run] [--keep 5]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// roadmap-recount runs main() on import unless VITEST is set; silence it for the import only.
const hadVitest = process.env.VITEST;
process.env.VITEST = "1";
const { SECTIONS, buildReport, countSection, splitLines } = await import("./roadmap-recount.mjs");
if (hadVitest === undefined) delete process.env.VITEST;

const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const dry = a.includes("--dry-run");
const keep = Number(opt("--keep") ?? 5);
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const fail = (m) => { console.error(`docs-archive: ${m}`); process.exit(1); };
if (!Number.isInteger(keep) || keep < 1) fail("--keep must be a whole number of 1 or more");

const SS = "docs/SESSION_STATE.md", RM = "docs/ROADMAP.md", MV = "docs/moves.json";
const HIST = `docs/archive/ROADMAP-history-${month}.md`;
const CLOSED = `docs/archive/ROADMAP-closed-rows-${month}.md`;
const POINTER_LINE = "Older session blocks: docs/archive/sessions-*.md (see docs/moves.json).";
const OLDER_HEADING = "## Older sections (archived)";

// ---- file helpers: line arrays without the final empty element; eol and final newline remembered per file
const read = (p) => {
  const f = join(root, p);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  const nl = lines.at(-1) === "";
  if (nl) lines.pop();
  return { text, lines, eol: text.includes("\r\n") ? "\r\n" : "\n", nl };
};
const render = (lines, eol, nl = true) => lines.join(eol) + (nl ? eol : "");
const writes = new Map(); // path -> new text (only when it differs from disk)
const stage = (p, text) => {
  const old = read(p);
  if (!old || old.text !== text) writes.set(p, text);
};
const stats = { blocks: 0, rows: 0, tailSections: 0 };
const archiveTargets = []; // [from, to] pairs for moves.json

// ---- A. session blocks
const splitBlocks = (ls) => {
  const idx = [];
  ls.forEach((l, i) => /^# Session/.test(l) && idx.push(i));
  return {
    pre: ls.slice(0, idx[0] ?? ls.length),
    bs: idx.map((s, k) => ls.slice(s, idx[k + 1] ?? ls.length)),
  };
};
const blockKey = (b) => `${b[0]}\n${b.join("\n").slice(0, 200)}`;
const blockMonth = (b) => (b[0].match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown-").slice(0, 7);
const withGap = (b) => (b.at(-1)?.trim() === "" ? b : [...b, ""]);

const ss = read(SS);
let ssAfter = null;
if (ss) {
  const { pre, bs } = splitBlocks(ss.lines);
  if (bs.length > keep) {
    const old = bs.slice(keep);
    const byMonth = new Map();
    for (const b of old) {
      const m = blockMonth(b);
      byMonth.set(m, [...(byMonth.get(m) ?? []), b]);
    }
    for (const [m, moved] of byMonth) {
      const path = `docs/archive/sessions-${m}.md`;
      const ex = read(path);
      const have = new Set(ex ? splitBlocks(ex.lines).bs.map(blockKey) : []);
      const fresh = moved.filter((b) => !have.has(blockKey(b)));
      stats.blocks += fresh.length;
      if (!fresh.length) continue;
      const existing = ex ? splitBlocks(ex.lines).bs : [];
      const head = [`# Archived session blocks — ${m}`, "Moved from docs/SESSION_STATE.md by tools/docs-archive.mjs. Newest block first.", ""];
      stage(path, render([...head, ...[...fresh, ...existing].flatMap(withGap)], ex?.eol ?? ss.eol));
      archiveTargets.push([SS, path]);
    }
    ssAfter = [...pre, ...bs.slice(0, keep).flat()];
  } else ssAfter = ss.lines;
  if (bs.length === 0 && ss.lines.length) ssAfter = ss.lines; // nothing to do without blocks
  else if (bs.length && !ssAfter.some((l) => /^# Session/.test(l))) fail("SESSION_STATE.md would end without a first block");
  if (bs.length && !ss.lines.includes(POINTER_LINE) && !ssAfter.includes(POINTER_LINE)) {
    while (ssAfter.at(-1)?.trim() === "") ssAfter = ssAfter.slice(0, -1);
    ssAfter = [...ssAfter, "", POINTER_LINE];
  }
  stage(SS, render(ssAfter, ss.eol, ss.nl || ssAfter !== ss.lines));
}

// ---- B and C. roadmap
const rm = read(RM);
let before = null, after = null;
if (rm) {
  let ls = rm.lines;
  before = JSON.stringify(buildReport(splitLines(rm.text)));

  // C. closed rows -> stubs
  const closedBySection = {};
  for (const name of SECTIONS) {
    const start = ls.findIndex((l) => l.startsWith(`### ${name} `));
    if (start < 0) fail(`no "### ${name}" heading in ROADMAP`);
    let width = null;
    for (let i = start + 1; i < ls.length && !/^#{1,3} /.test(ls[i]); i++) {
      const l = ls[i];
      if (!l.startsWith("|") || /^\|[\s:|-]+\|?$/.test(l)) continue;
      const cells = l.replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").split(" | ").map((c) => c.trim());
      if (cells[0] === "ID (aliases)") { width = cells.length; continue; }
      if (width === null || width < 6 || cells.length !== width) continue;
      if (cells.some((c) => c === "archived" || c.startsWith("full row:"))) continue;
      if (countSection(name, { rows: [cells], malformed: 0 }).closed !== 1) continue;
      // keep id (0), title (2), status (4); the evidence column (5) points to the archive
      const stub = cells.map((c, k) => (k === 0 || k === 2 || k === 4 ? c : k === 5 ? `full row: ${CLOSED}` : "archived"));
      (closedBySection[name] ??= []).push(l);
      ls[i] = `| ${stub.join(" | ")} |`;
    }
  }
  if (Object.keys(closedBySection).length) {
    const ex = read(CLOSED);
    const sections = new Map(SECTIONS.map((n) => [n, []]));
    let cur = null;
    for (const l of ex?.lines ?? []) {
      const m = l.match(/^## (Z\.\d)$/);
      if (m) cur = m[1];
      else if (cur && l.trim()) sections.get(cur)?.push(l);
    }
    for (const [n, rows] of Object.entries(closedBySection)) {
      const have = new Set(sections.get(n));
      for (const r of rows) if (!have.has(r)) { sections.get(n).push(r); stats.rows++; }
    }
    const out = [`# Archived closed roadmap rows — ${month}`, "Moved from docs/ROADMAP.md by tools/docs-archive.mjs. One original row per line, id first.", ""];
    for (const [n, rows] of sections) if (rows.length) out.push(`## ${n}`, ...rows, "");
    stage(CLOSED, render(out, ex?.eol ?? rm.eol));
    archiveTargets.push([RM, CLOSED]);
  }

  // B. old tail
  const pz = ls.findIndex((l) => /^## P0-Z\b/.test(l));
  const ts = pz < 0 ? -1 : ls.findIndex((l, i) => i > pz && /^## /.test(l));
  if (ts >= 0 && ls[ts] !== OLDER_HEADING) {
    const tail = ls.slice(ts);
    const heads = tail.filter((l) => /^## /.test(l));
    stats.tailSections = heads.length;
    const ex = read(HIST);
    const head = [`# Archived roadmap sections — ${month}`, "Moved from docs/ROADMAP.md by tools/docs-archive.mjs. Text is verbatim.", ""];
    if (!ex || !ex.text.includes(tail[0])) {
      stage(HIST, render(ex ? [...ex.lines, "", ...tail] : [...head, ...tail], ex?.eol ?? rm.eol));
      archiveTargets.push([RM, HIST]);
    }
    ls = [
      ...ls.slice(0, ts),
      OLDER_HEADING,
      "",
      ...heads.map((h) => `- ${h.slice(3)}`),
      "",
      `Full text: ${HIST} (moved by tools/docs-archive.mjs, see docs/moves.json).`,
    ];
  }
  after = JSON.stringify(buildReport(ls));
  if (before !== after) fail("roadmap recount totals differ before vs after; nothing written");
  stage(RM, render(ls, rm.eol, rm.nl));
}

// ---- D. move trail
if (archiveTargets.length) {
  const mv = read(MV);
  const arr = mv ? JSON.parse(mv.text.replace(/^﻿/, "")) : [];
  for (const [from, to] of archiveTargets) {
    if (arr.some((e) => e.from === from && e.to === to && e.extract === true)) continue;
    arr.push({ from, to, date: today, reason: `Z-107 archive: older text moved out, source file stays`, extract: true });
  }
  stage(MV, JSON.stringify(arr, null, 2) + (mv?.eol ?? "\n"));
}

// ---- write and report
const size = (p, text) => (text !== undefined ? Buffer.byteLength(text) : read(p) ? Buffer.byteLength(read(p).text) : 0);
console.log(`${dry ? "[dry-run] would move" : "moved"}: ${stats.blocks} session block(s), ${stats.rows} closed row(s) stubbed, ${stats.tailSections} old roadmap section(s)`);
for (const p of [SS, RM]) console.log(`${p}: ${size(p)} -> ${size(p, writes.get(p) ?? read(p)?.text)} bytes`);
for (const p of writes.keys()) console.log(`${dry ? "would write" : "write"}: ${p}`);
if (!dry) {
  for (const [p, text] of writes) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}
