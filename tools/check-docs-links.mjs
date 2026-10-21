#!/usr/bin/env node
// Z-106: dead relative links in tracked docs. Run from the repo root.
// Usage: node tools/check-docs-links.mjs [--baseline docs/link-baseline.txt] [--write-baseline <file>]
// Baseline lines are "file|target". Only links that are not in the baseline fail the run.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { loadMoves, resolveFinal } from "./docs-rewrite-refs.mjs";

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
// docs/ is gitignored and not tracked in a checkout without it: nothing to check there.
if (!tracked.some((f) => f.startsWith("docs/") && f.endsWith(".md"))) {
  console.log("check-docs-links: skipped, docs/ is not in this checkout");
  process.exit(0);
}
const files = new Set(tracked);
const dirs = new Set();
for (const f of tracked) for (let d = posix.dirname(f); d !== "." && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
const moves = loadMoves(process.cwd());
const baseline = new Set();
if (arg("--baseline") && existsSync(arg("--baseline"))) {
  for (const l of readFileSync(arg("--baseline"), "utf8").split(/\r?\n/)) if (l && !l.startsWith("#")) baseline.add(l);
}

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const dead = [];
const sources = tracked.filter((f) => f.endsWith(".md") && (f.startsWith("docs/") || f === "README.md" || f === "PROJECT_BRAIN.md"));
for (const f of sources) {
  let inFence = false;
  readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const m of line.matchAll(LINK)) {
      let t = m[1];
      if (/^(https?:|mailto:|#|\/|[a-z][a-z0-9+.-]*:)/i.test(t)) continue;
      t = t.replace(/[#?].*$/, "");
      if (!t) continue;
      try { t = decodeURIComponent(t); } catch { /* keep raw */ }
      const p = posix.normalize(posix.join(posix.dirname(f), t)).replace(/\/$/, "");
      if (files.has(p) || dirs.has(p)) continue;
      dead.push({ f, line: i + 1, target: m[1].replace(/[#?].*$/, ""), p });
    }
  });
}

if (arg("--write-baseline")) {
  writeFileSync(arg("--write-baseline"), `# Known dead links (Z-106). Format: file|target. Remove a line when the link is fixed.\n${[...new Set(dead.map((d) => `${d.f}|${d.target}`))].sort().join("\n")}\n`);
  console.log(`docs-links: wrote ${new Set(dead.map((d) => `${d.f}|${d.target}`)).size} baseline entries`);
  process.exit(0);
}
let fresh = 0;
for (const d of dead) {
  if (baseline.has(`${d.f}|${d.target}`)) continue;
  fresh++;
  const r = resolveFinal(moves, d.p);
  console.log(`${d.f}:${d.line}: dead link ${d.target}${r.last ? ` -> moved to ${r.path}` : ""}`);
}
console.log(`docs-links: ${dead.length} dead link(s), ${dead.length - fresh} in baseline, ${fresh} new`);
process.exit(fresh ? 1 : 0);
