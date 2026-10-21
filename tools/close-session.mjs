#!/usr/bin/env node
// Z-109: one command for session close-out. NEVER commits or pushes.
// Usage: node tools/close-session.mjs [--root <dir>] [--dry-run]
// Prints OK / WARN / FAIL per step and continues. Exit 1 when any step is FAIL.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  { name: "decisions", cmd: "append docs/.session-decisions.txt to docs/DECISIONS.md", own: true },
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
  if (s.own) {
    try {
      const n = applyDecisions();
      note = `${n} decision(s) appended`;
      if (existsSync(DEC_IN)) note += "; remove docs/.session-decisions.txt after you commit";
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
});
console.log(failed ? `close-session: ${failed} step(s) FAIL` : "close-session: done. Nothing committed. Review `git status`, then commit.");
process.exit(failed ? 1 : 0);
