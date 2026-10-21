#!/usr/bin/env node
// Z-109: one command for session close-out. NEVER commits or pushes.
// Usage: node tools/close-session.mjs [--root <dir>] [--dry-run]
// Prints OK / WARN / FAIL per step and continues. Exit 1 when any step is FAIL.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const root = resolve(a.includes("--root") ? a[a.indexOf("--root") + 1] : join(here, ".."));
const dry = a.includes("--dry-run");
const STRICT_FROM = "2026-10-29";
const strict = new Date().toISOString().slice(0, 10) >= STRICT_FROM;

const DEC = join(root, "docs", "DECISIONS.md");
const DEC_IN = join(root, "docs", ".session-decisions.txt");
const DEC_HEAD = "# Decisions\n\n*Type: reference*\n\n| Date | Decision | Source |\n| --- | --- | --- |\n";
const SS = join(root, "docs", "SESSION_STATE.md");
const COUNT = join(root, "docs", ".docs-count");
const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_LIMIT = 5;

// Appends new decision lines to DECISIONS.md; returns the number added. Never rewrites existing rows.
function applyDecisions() {
  if (!existsSync(DEC_IN)) return 0;
  const have = existsSync(DEC) ? readFileSync(DEC, "utf8") : null;
  const rows = [];
  for (const line of readFileSync(DEC_IN, "utf8").split(/\r?\n/)) {
    const p = line.split("|").map((s) => s.trim());
    if (p.length < 3 || !p[0] || !p[1]) continue;
    const row = `| ${p[0]} | ${p[1]} | ${p.slice(2).join(" | ")} |`;
    if (!(have ?? "").includes(row) && !rows.includes(row)) rows.push(row);
  }
  if (!rows.length) return 0;
  if (have === null) {
    mkdirSync(dirname(DEC), { recursive: true });
    writeFileSync(DEC, DEC_HEAD);
  } else if (!have.endsWith("\n")) appendFileSync(DEC, "\n");
  appendFileSync(DEC, `${rows.join("\n")}\n`);
  return rows.length;
}

// All *.md files under docs/ (node_modules skipped), absolute paths.
function mdFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) mdFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Birth time, with mtime as the fallback where the file system has no birth time.
const created = (p) => {
  const s = statSync(p);
  return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
};

// Repeat key: drop a leading date and a leading S<NN>-, keep the last two words. Null when fewer than two words.
function repeatKey(file) {
  const words = file
    .replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/^S\d+-/, "")
    .split("-")
    .filter(Boolean);
  return words.length < 2 ? null : words.slice(-2).join("-");
}

// Counts md files, lists the new ones, warns on likely repeats, and writes the Docs line and docs/.docs-count.
// Never FAILs. Returns { res, note, lines }.
function fileCount() {
  if (!existsSync(join(root, "docs"))) return { res: "OK", note: "skipped (no docs/ folder)", lines: [] };
  const now = Date.now();
  // docs/archive/ and docs/private/ never count as new files and never match a repeat name.
  const entries = mdFiles(join(root, "docs")).map((p) => {
    const r = relative(root, p).split(sep).join("/");
    const quiet = /^docs\/(archive|private)\//.test(r);
    return { r, file: basename(p), key: quiet ? null : repeatKey(basename(p)), fresh: !quiet && now - created(p) <= DAY_MS };
  });
  const N = entries.length;
  const prev = existsSync(COUNT) ? Number.parseInt(readFileSync(COUNT, "utf8"), 10) : Number.NaN;
  const k = Number.isFinite(prev) ? N - prev : 0;
  const delta = `${k >= 0 ? "+" : ""}${k}`;
  const lines = [];
  const warns = [];

  // Table by top-level folder under docs/
  const byFolder = new Map();
  for (const e of entries) {
    const parts = e.r.split("/");
    const f = parts.length > 2 ? parts[1] : "(docs root)";
    byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
  }
  const w = Math.max(6, ...[...byFolder.keys()].map((f) => f.length));
  lines.push(`   ${"Folder".padEnd(w)}  md files`);
  for (const [f, n] of [...byFolder].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) lines.push(`   ${f.padEnd(w)}  ${n}`);

  // New files in the last 24 hours
  const fresh = entries.filter((e) => e.fresh).sort((x, y) => x.r.localeCompare(y.r));
  for (const e of fresh) lines.push(`   new: ${e.r}`);
  if (fresh.length > NEW_LIMIT) warns.push("file-count: more than 5 files created in one session");
  for (const e of fresh) {
    if (!e.key) continue;
    const other = entries.find((o) => o !== e && o.key === e.key);
    if (other) warns.push(`file-count: ${e.r} looks like a repeat of ${other.r}`);
  }
  for (const msg of warns) lines.push(`WARN ${msg}`);

  // Docs line under the first heading of SESSION_STATE.md
  if (existsSync(SS)) {
    const text = readFileSync(SS, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const ls = text.split(/\r?\n/);
    const line = `Docs: ${N} md files (${delta} since the last session)`;
    const hi = ls.findIndex((l) => /^#\s/.test(l));
    const di = ls.slice(0, 12).findIndex((l) => l.startsWith("Docs: "));
    if (di >= 0) ls[di] = line;
    else if (hi >= 0) ls.splice(hi + 1, 0, line);
    else ls.unshift(line);
    const out = ls.join(eol);
    if (out !== text) writeFileSync(SS, out);
  }
  if (!dry) writeFileSync(COUNT, `${N}\n`);

  const res = warns.length ? "WARN" : "OK";
  return { res, note: `${N} md files, ${fresh.length} new, ${delta} since the last session`, lines };
}

const node = (script, ...args) => ({ cmd: `node tools/${script}${args.length ? " " + args.join(" ") : ""}`, script, args });
// status: fn(result) -> "OK" | "WARN" | "FAIL"
const steps = [
  { name: "next-brief", ...node("next-brief.mjs") },
  { name: "routing-report", ...node("routing-report.mjs") },
  { name: "roadmap-recount", ...node("roadmap-recount.mjs"), judge: (r) => (r.status !== 0 ? "WARN" : "OK"), note: (r) => r.stdout.split(/\r?\n/).filter(Boolean).pop() ?? "" },
  { name: "docs-archive", ...node("docs-archive.mjs", "--root", root) },
  { name: "docs-plans-index", ...node("docs-plans-index.mjs", "--root", root) },
  { name: "lint-docs", ...node("lint-docs.mjs"), judge: (r) => (r.status === 0 ? "OK" : strict ? "FAIL" : "WARN"), note: (r) => `${(r.stdout.match(/\bmissing\b|\bfinding/gi) ?? []).length ? "findings printed" : ""}` },
  { name: "check-docs-links", ...node("check-docs-links.mjs", "--baseline", "docs/link-baseline.txt") },
  { name: "check-docs-privacy", ...node("check-docs-privacy.mjs") },
  { name: "file-count", cmd: "count docs/ md files, new files, Docs line in docs/SESSION_STATE.md, write docs/.docs-count", own: true, run: fileCount },
  { name: "decisions", cmd: "append docs/.session-decisions.txt to docs/DECISIONS.md", own: true, run: () => {
    const n = applyDecisions();
    let note = `${n} decision(s) appended`;
    if (existsSync(DEC_IN)) note += "; remove docs/.session-decisions.txt after you commit";
    return { res: "OK", note, lines: [] };
  } },
];

if (dry) {
  steps.forEach((s, i) => console.log(`${i + 1}. ${s.name}: ${s.cmd}`));
  console.log("close-session: dry run, nothing written");
  process.exit(0);
}

let failed = 0;
steps.forEach((s, i) => {
  const tag = `${i + 1}. ${s.name}`;
  let res = "OK";
  let note = "";
  let extra = [];
  if (s.own) {
    try {
      ({ res, note, lines: extra } = s.run());
    } catch (e) { res = "FAIL"; note = e.message; }
  } else {
    const args = [join(here, s.script), ...s.args];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    res = s.judge ? s.judge({ status: r.status, stdout: r.stdout ?? "" }) : r.status === 0 ? "OK" : "FAIL";
    note = s.note ? s.note({ stdout: r.stdout ?? "" }) : "";
    if (res !== "OK") note = `${note} ${text.trim().split(/\r?\n/).slice(-3).join(" / ")}`.trim();
  }
  if (res === "FAIL") failed++;
  console.log(`${res} ${tag}${note ? ` (${note})` : ""}`);
  for (const l of extra) console.log(l.startsWith("WARN ") || l.startsWith("   ") ? l : `   ${l}`);
});
console.log(failed ? `close-session: ${failed} step(s) FAIL` : "close-session: done. Nothing committed. Review `git status`, then commit.");
process.exit(failed ? 1 : 0);
