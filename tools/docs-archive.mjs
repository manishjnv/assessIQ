#!/usr/bin/env node
// Z-107: shrink the two biggest start-up docs without losing text.
//   A. docs/SESSION_STATE.md keeps the newest N blocks; older blocks go to docs/archive/sessions-YYYY-MM.md.
//   B. docs/ROADMAP.md: everything after the P0-Z part (first "## " after "## P0-Z") goes to docs/archive/ROADMAP-history-YYYY-MM.md.
//   C. docs/ROADMAP.md: closed rows of Z.2..Z.6 become stub rows; full rows go to docs/archive/ROADMAP-closed-rows-YYYY-MM.md.
//   C2. Stub rows get short title and status cells (shrink-stubs); full text stays in the closed-rows archive.
//   B2. Z.7 "recount update" bullets older than the newest 3, and the Z.7b and Z.8 subsections, move to the history archive.
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
  else writes.delete(p);
};
// current view of a file: staged text if any, else disk
const readCur = (p) => {
  if (!writes.has(p)) return read(p);
  const text = writes.get(p);
  const lines = text.split(/\r?\n/);
  const nl = lines.at(-1) === "";
  if (nl) lines.pop();
  return { text, lines, eol: text.includes("\r\n") ? "\r\n" : "\n", nl };
};
const stats = { blocks: 0, rows: 0, tailSections: 0, shrunk: 0, recount: 0, moved: 0 };
let passReport = [];
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
  // per-pass size report (bytes of ROADMAP.md)
  const passReport0 = [["start", Buffer.byteLength(rm.text)]];
  const mark = (name) => passReport0.push([name, Buffer.byteLength(render(ls, rm.eol, rm.nl))]);
  mark("closed-stubs + old tail");

  // shrink-stubs: title (cell 2) <= 100 chars, status (cell 4) <= 70 chars; originals stay in CLOSED
  const cut = (str, max) => {
    if (str.length <= max) return str;
    for (let b = max - 2; b > 10; b--) {
      let t = str.slice(0, b);
      if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);
      const sp = t.lastIndexOf(" ");
      if (sp > b / 2) t = t.slice(0, sp);
      t = t.trimEnd();
      if ((t.match(/`/g) ?? []).length % 2) t += "`";
      if ((t.match(/\*\*/g) ?? []).length % 2) t += "**";
      t += " …";
      if (t.length <= max) return t;
    }
    return str.slice(0, max);
  };
  const closedText = readCur(CLOSED)?.lines ?? [];
  const skipped = [];
  for (const name of SECTIONS) {
    const start = ls.findIndex((l) => l.startsWith(`### ${name} `));
    let width = null;
    for (let i = start + 1; i < ls.length && !/^#{1,3} /.test(ls[i]); i++) {
      const l = ls[i];
      if (!l.startsWith("|") || /^\|[\s:|-]+\|?$/.test(l)) continue;
      const cells = l.replace(/^\|\s*/, "").replace(/\s*\|\s*$/, "").split(" | ").map((c) => c.trim());
      if (cells[0] === "ID (aliases)") { width = cells.length; continue; }
      if (width === null || width < 6 || cells.length !== width) continue;
      if (!cells.some((c) => c === "archived" || c.startsWith("full row:"))) continue;
      const t = cut(cells[2], 100), st = cut(cells[4], 70);
      if (t === cells[2] && st === cells[4]) continue;
      const pre = `| ${cells[0]} | `;
      if (!closedText.some((x) => x.startsWith(pre) && !x.includes("full row:"))) { skipped.push(cells[0]); continue; }
      cells[2] = t;
      cells[4] = st;
      ls[i] = `| ${cells.join(" | ")} |`;
      stats.shrunk++;
    }
  }
  if (skipped.length) console.log(`shrink-stubs skipped (original row not in ${CLOSED}): ${skipped.join(", ")}`);
  mark("shrink-stubs");

  // history archive edits are done in memory and staged once
  const hx = readCur(HIST);
  const hl = hx ? [...hx.lines] : [`# Archived roadmap sections — ${month}`, "Moved from docs/ROADMAP.md by tools/docs-archive.mjs. Text is verbatim.", ""];
  let histChanged = false;
  const blockEnd = (arr, h) => {
    let e = arr.findIndex((l, i) => i > h && /^#{1,3} /.test(l));
    if (e < 0) e = arr.length;
    while (e > h + 1 && arr[e - 1].trim() === "") e--;
    return e;
  };

  // recount-history: keep the newest 3 "S<NN> recount update" bullets (file order = newest first)
  const RC = /^- S\d+ recount update( \d+)?\b/;
  const z7 = ls.findIndex((l) => /^### Z\.7\b/.test(l));
  let z7end = z7 < 0 ? -1 : ls.findIndex((l, i) => i > z7 && /^#{1,3} /.test(l));
  if (z7 >= 0 && z7end < 0) z7end = ls.length;
  const hits = [];
  for (let i = z7 + 1; z7 >= 0 && i < z7end; i++) if (RC.test(ls[i])) hits.push(i);
  const RHEAD = "## Z.7 recount history (moved)";
  const RPOINT = `- Older recount updates: ${HIST} § Z.7 recount history (moved)`;
  if (hits.length > 3) {
    const idx = hits.slice(3);
    const moved = idx.map((i) => ls[i]);
    let h = hl.indexOf(RHEAD);
    if (h < 0) {
      while (hl.at(-1)?.trim() === "") hl.pop();
      hl.push("", RHEAD, "");
      h = hl.length - 2;
    }
    const have = new Set(hl);
    const fresh = moved.filter((m) => !have.has(m));
    hl.splice(blockEnd(hl, h), 0, ...fresh);
    if (fresh.length) histChanged = true;
    const drop = new Set(idx);
    const hasPointer = ls.includes(RPOINT);
    ls = ls.flatMap((l, i) => (i === idx[0] && !hasPointer ? [RPOINT] : drop.has(i) ? [] : [l]));
    stats.recount += idx.length;
    archiveTargets.push([RM, HIST]);
  }
  mark("recount-history");

  // move-sections: Z.7b and Z.8 (checked: no tool or test reads them)
  const SPOINT = `- Z.7b and Z.8: ${HIST}`;
  const secs = ["Z.7b", "Z.8"].map((n) => ls.findIndex((l) => l.startsWith(`### ${n} `))).filter((i) => i >= 0);
  if (secs.length) {
    const ranges = secs.map((s) => {
      let e = ls.findIndex((l, i) => i > s && /^#{1,3} /.test(l));
      if (e < 0) e = ls.length;
      return [s, e];
    });
    const gone = new Set();
    for (const [s, e] of ranges) {
      const chunk = ls.slice(s, e);
      while (chunk.at(-1)?.trim() === "") chunk.pop();
      if (!hl.includes(chunk[0])) {
        while (hl.at(-1)?.trim() === "") hl.pop();
        hl.push("", ...chunk, "");
        histChanged = true;
      }
      for (let i = s; i < e; i++) gone.add(i);
      stats.moved++;
    }
    const first = ranges[0][0];
    ls = ls.flatMap((l, i) => (i === first ? [SPOINT, ""] : gone.has(i) ? [] : [l]));
    archiveTargets.push([RM, HIST]);
  }
  mark("move-sections");
  if (histChanged) stage(HIST, render(hl, hx?.eol ?? rm.eol));
  passReport = passReport0;

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
console.log(`shrink-stubs: ${stats.shrunk} stub row(s) shortened; recount-history: ${stats.recount} bullet(s) moved; move-sections: ${stats.moved} section(s) moved`);
passReport.forEach(([n, b], i) => console.log(`  ROADMAP.md after ${n}: ${b} bytes${i > 0 ? ` (${b - passReport[i - 1][1]})` : ""}`));
for (const p of [SS, RM]) console.log(`${p}: ${size(p)} -> ${size(p, writes.get(p) ?? read(p)?.text)} bytes`);
for (const p of writes.keys()) console.log(`${dry ? "would write" : "write"}: ${p}`);
if (!dry) {
  for (const [p, text] of writes) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}
