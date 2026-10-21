#!/usr/bin/env node
// Z-68: next free migration number. Highest modules/*/migrations/NNNN_*.sql prefix + 1, skipping any
// number that docs/ROADMAP.md or docs/SESSION_STATE.md reserves. A line counts as a reservation when it
// has "reserved" or "claimed" and a 0NNN number, and does not say "not used", "unused" or "released".
// Usage: node tools/next-migration.mjs [--count N]
//   --count N   print N free numbers, one per line, and nothing else.
// Exit 0 on success, 1 when modules/ cannot be read or N is not a positive integer.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_FILES = ["docs/ROADMAP.md", "docs/SESSION_STATE.md"];
const NEGATED = /\b(not used|unused|released|not reserved|free again)\b/i;

export function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Highest 4-digit migration prefix among file names (0 when none). */
export function highestMigration(fileNames) {
  let max = 0;
  for (const f of fileNames) {
    const m = f.match(/^(\d{4})_/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// A number is reserved when it sits within 30 characters of "reserved" or "claimed" on the same
// sentence: "0210 reserved", "reserved for 0210", "claimed 0211 and 0212". Other numbers on the line do not count.
const KEYWORD = /\b(?:reserved|claimed)\b/gi;
const NUMBER = /\b0\d{3}\b/g;

/** Reserved numbers found in the text: [{ number, source, line }]. */
export function reservedFrom(lines, source) {
  const out = [];
  lines.forEach((line, i) => {
    if (NEGATED.test(line)) return;
    const keys = [...line.matchAll(KEYWORD)].map((m) => m.index);
    for (const m of line.matchAll(NUMBER)) {
      const at = m.index;
      const near = keys.some((k) => {
        const span = line.slice(Math.min(at, k), Math.max(at + 4, k + 8));
        return span.length <= 30 && !/[.;|]/.test(span);
      });
      if (near) out.push({ number: Number(m[0]), source, line: i + 1 });
    }
  });
  return out;
}

/** The first `count` numbers above `maxUsed` that are not reserved, zero-padded to 4 digits. */
export function nextFree(maxUsed, reserved, count = 1) {
  const taken = new Set(reserved.map((r) => r.number));
  const out = [];
  let n = maxUsed;
  while (out.length < count) {
    n += 1;
    if (!taken.has(n)) out.push(String(n).padStart(4, "0"));
  }
  return out;
}

function migrationFileNames() {
  const modulesDir = join(ROOT, "modules");
  const names = [];
  for (const mod of readdirSync(modulesDir)) {
    const dir = join(modulesDir, mod, "migrations");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".sql")) names.push(f);
  }
  return names;
}

function main() {
  // docs/ is gitignored: without ROADMAP the reservations cannot be read, so skip (exit 0).
  // With --count the skip line goes to stderr, so stdout still holds only numbers.
  if (!existsSync(join(ROOT, "docs/ROADMAP.md"))) {
    const line = existsSync(join(ROOT, "docs")) ? "next-migration: skipped, docs/ROADMAP.md is not in this checkout" : "next-migration: skipped, docs/ is not in this checkout";
    if (process.argv.includes("--count")) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
    return;
  }
  const countArg = process.argv.indexOf("--count");
  let count = 1;
  if (countArg >= 0) {
    const raw = process.argv[countArg + 1] ?? "";
    if (!/^[1-9]\d*$/.test(raw)) {
      process.stderr.write("next-migration: --count needs a positive whole number\n");
      process.exitCode = 1;
      return;
    }
    count = Number(raw);
  }

  let files;
  try {
    files = migrationFileNames();
  } catch (err) {
    process.stderr.write(`next-migration: cannot read modules/: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const maxUsed = highestMigration(files);
  const reserved = DOC_FILES.flatMap((rel) => {
    const p = join(ROOT, rel);
    return existsSync(p) ? reservedFrom(splitLines(readFileSync(p, "utf8")), rel) : [];
  });
  const free = nextFree(maxUsed, reserved, count);

  if (countArg >= 0) {
    process.stdout.write(`${free.join("\n")}\n`);
    return;
  }
  const out = [
    "Next free migration (Z-68)",
    `- Highest migration file: ${String(maxUsed).padStart(4, "0")} (${files.length} .sql files in modules/*/migrations)`,
  ];
  const above = reserved.filter((r) => r.number > maxUsed);
  if (above.length) {
    for (const r of above) out.push(`- Reserved above the highest file: ${String(r.number).padStart(4, "0")} (${r.source} line ${r.line})`);
  } else {
    out.push("- Reserved above the highest file (ROADMAP or SESSION_STATE): none");
  }
  if (reserved.length > above.length) out.push(`- Older reservations at or below the highest file, ignored: ${reserved.length - above.length}`);
  out.push(`- Next free: ${free[0]}`);
  process.stdout.write(`${out.join("\n")}\n`);
}

if (!process.env.VITEST) main();
