#!/usr/bin/env node
// Moves a docs file or directory, records it in docs/moves.json, rewrites references.
// Usage: node tools/docs-move.mjs <from> <to> --reason "<text>" [--root <dir>] [--no-rewrite]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMoves, rewriteRefs } from "./docs-rewrite-refs.mjs";

const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const pos = a.filter((x, i) => !x.startsWith("--") && !["--root", "--reason"].includes(a[i - 1]));
const reason = opt("--reason");
if (pos.length !== 2 || !reason) {
  console.error('usage: docs-move.mjs <from> <to> --reason "<text>" [--root <dir>] [--no-rewrite]');
  process.exit(2);
}
const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
let [from, to] = pos.map(norm);
const src = join(root, from), dst = join(root, to);
if (!existsSync(src)) { console.error(`missing: ${from}`); process.exit(1); }
if (existsSync(dst)) { console.error(`refusing: ${to} exists`); process.exit(1); }
const isDir = statSync(src).isDirectory();
if (isDir) { from = from.replace(/\/+$/, "") + "/"; to = to.replace(/\/+$/, "") + "/"; }

const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let tracked = false;
try { tracked = git("ls-files", "--", from).trim() !== ""; } catch { /* not a git repo */ }
mkdirSync(dirname(dst), { recursive: true });
if (tracked) { git("mv", from.replace(/\/$/, ""), to.replace(/\/$/, "")); console.log(`git mv ${from} -> ${to}`); }
else { renameSync(src, dst); console.log(`rename ${from} -> ${to}`); }

// Relative links INSIDE the moved .md files were written for the old folder: re-point them.
const fixOwnLinks = (oldRel, newRel, file) => {
  const t = readFileSync(file, "utf8");
  const oldDir = posix.dirname(oldRel), newDir = posix.dirname(newRel);
  const out = t.replace(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g, (all, target, anchor = "") => {
    if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(target)) return all;
    let abs = posix.normalize(posix.join(oldDir, target));
    if (isDir && abs.startsWith(from)) abs = to + abs.slice(from.length);
    let rel = posix.relative(newDir, abs);
    if (target.endsWith("/") && !rel.endsWith("/")) rel += "/";
    return rel === target ? all : `](${rel}${anchor})`;
  });
  if (out !== t) writeFileSync(file, out);
};
const eachMd = (d, base, cb) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name), r = `${base}${e.name}`; if (e.isDirectory()) eachMd(p, `${r}/`, cb); else if (/\.md$/.test(e.name)) cb(r, p); } };
if (isDir) eachMd(dst, "", (r, p) => fixOwnLinks(from + r, to + r, p));
else if (/\.md$/.test(to)) fixOwnLinks(from, to, dst);

const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const moves = loadMoves(root);
moves.push({ from, to, date, reason });
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "moves.json"), JSON.stringify(moves, null, 2) + "\n");
console.log(`recorded in docs/moves.json (${moves.length} entries)`);
if (!a.includes("--no-rewrite")) rewriteRefs(root);
