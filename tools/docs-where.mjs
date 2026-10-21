#!/usr/bin/env node
// Where did a doc go? Usage: node tools/docs-where.mjs <old path> [--root <dir>]
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMoves, resolveFinal } from "./docs-rewrite-refs.mjs";

const a = process.argv.slice(2);
const i = a.indexOf("--root");
const old = a.find((x, j) => !x.startsWith("--") && (i < 0 || j !== i + 1));
if (!old) { console.error("usage: docs-where.mjs <old path> [--root <dir>]"); process.exit(2); }
const root = resolve(i >= 0 ? a[i + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
const p = old.replace(/\\/g, "/").replace(/^\.\//, "");
const { path, last } = resolveFinal(loadMoves(root), p);
for (const m of loadMoves(root, true).filter((x) => x.extract && x.from === p)) console.log(`${p}: text moved to ${m.to} (${m.date}: ${m.reason})`);
console.log(last ? `${p} -> ${path} (moved ${last.date}: ${last.reason})` : `${p}: never moved`);
