#!/usr/bin/env node
// Rewrites references to moved docs using docs/moves.json.
// Usage: node tools/docs-rewrite-refs.mjs [--root <dir>] [--dry-run]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = /\.(md|mjs|js|ts|tsx|json|yml|yaml|sh|txt)$/;
const DIRS = ["docs", ".claude", ".github", "tools", "modules", "apps", "packages"];
const SKIP = new Set(["node_modules", ".git"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `extract` entries record text moved out of a file that stays in place; they never remap a path.
export function loadMoves(root, all = false) {
  const f = join(root, "docs", "moves.json");
  const moves = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  return all ? moves : moves.filter((m) => !m.extract);
}

/** Apply the moves in order (chains a->b->c end at c). Returns { path, last } (last = final hop entry or null). */
export function resolveFinal(moves, path) {
  let last = null;
  for (const m of moves) {
    if (path === m.from || (m.from.endsWith("/") && path.startsWith(m.from))) {
      path = m.to + path.slice(m.from.length);
      last = m;
    }
  }
  return { path, last };
}

function walk(dir, root, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(root, p).split(sep).join("/");
    if (SKIP.has(e.name) || rel === "docs/moves.json" || rel === "docs/private") continue;
    if (e.isDirectory()) walk(p, root, out);
    else if (EXT.test(e.name)) out.push(p);
  }
}

function rewriteLine(line, moves, file, root) {
  let n = 0;
  const fromDir = posix.dirname(relative(root, file).split(sep).join("/"));
  // (b) markdown relative links
  line = line.replace(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g, (all, target, anchor = "") => {
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(target)) return all;
    const abs = posix.normalize(posix.join(fromDir, target));
    const { path, last } = resolveFinal(moves, abs);
    if (!last) return all;
    n++;
    let rel = posix.relative(fromDir, path);
    if (target.endsWith("/") && !rel.endsWith("/")) rel += "/";
    return `](${rel}${anchor})`;
  });
  // (a) repo-root-relative path strings
  for (const m of moves) {
    const re = new RegExp(`(?<![\\w./-])${esc(m.from)}${m.from.endsWith("/") ? "[\\w./@-]*" : "(?![\\w-]|\\.\\w)"}`, "g");
    line = line.replace(re, (tok) => {
      const trail = tok.match(/\.+$/)?.[0] ?? "";
      const { path, last } = resolveFinal(moves, tok.slice(0, tok.length - trail.length));
      if (!last) return tok;
      n++;
      return path + trail;
    });
  }
  return [line, n];
}

export function rewriteRefs(root, dryRun = false) {
  const moves = loadMoves(root);
  const files = [];
  for (const d of DIRS) if (existsSync(join(root, d))) walk(join(root, d), root, files);
  for (const f of ["README.md", "PROJECT_BRAIN.md", "CLAUDE.md"]) if (existsSync(join(root, f))) files.push(join(root, f));
  let changed = 0, refs = 0;
  const approval = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const isClaude = /(^|[\\/])CLAUDE\.md$/.test(file);
    let count = 0;
    const out = text.split("\n").map((line, i) => {
      const [l, n] = rewriteLine(line, moves, file, root);
      if (n && isClaude) approval.push(`CLAUDE.md needs approval: line ${i + 1}: ${line.replace(/\r$/, "")}`);
      count += n;
      return l;
    }).join("\n");
    if (!count || isClaude) continue;
    changed++; refs += count;
    if (!dryRun) writeFileSync(file, out);
    console.log(`${dryRun ? "would rewrite" : "rewrote"} ${count} ref(s) in ${relative(root, file).split(sep).join("/")}`);
  }
  approval.forEach((l) => console.log(l));
  console.log(`summary: ${changed} file(s) changed, ${refs} ref(s) rewritten${dryRun ? " (dry run)" : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const i = a.indexOf("--root");
  const root = resolve(i >= 0 ? a[i + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  rewriteRefs(root, a.includes("--dry-run"));
}
