/**
 * lint-file-size — warn-only. Lists TS/TSX files over 800 lines under
 * modules/ and apps/ (tests, migrations, generated files, node_modules, dist
 * excluded). Always exits 0. `--self-test` checks the filter and counter.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MAX_LINES = 800;
const SKIP_DIR = new Set(["node_modules", "dist", "build", "coverage", ".git", "migrations", "__tests__", "generated", ".claude"]);

export function isCounted(rel: string): boolean {
  const p = rel.split("\\").join("/");
  if (!/\.tsx?$/.test(p) || p.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.tsx?$/.test(p) || /\.generated\.tsx?$/.test(p)) return false;
  return !p.split("/").some((seg) => SKIP_DIR.has(seg));
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split(/\r?\n/).length - (/\n$/.test(text) ? 1 : 0);
}

function walk(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (isCounted(relative(root, full))) out.push(full);
  }
}

function selfTest(): void {
  const ok = (c: boolean, m: string): void => { if (!c) { console.error("FAIL " + m); process.exit(1); } };
  ok(isCounted("modules/a/src/x.ts"), "ts counted");
  ok(isCounted("apps/web/src/p.tsx"), "tsx counted");
  ok(!isCounted("modules/a/src/__tests__/x.ts"), "tests skipped");
  ok(!isCounted("modules/a/src/x.test.ts"), "test file skipped");
  ok(!isCounted("modules/a/migrations/x.ts"), "migrations skipped");
  ok(!isCounted("modules/a/node_modules/x.ts"), "node_modules skipped");
  ok(!isCounted("modules/a/src/x.d.ts"), "d.ts skipped");
  ok(countLines("a\nb\n") === 2 && countLines("a\r\nb") === 2 && countLines("") === 0, "line count");
  console.log("lint-file-size self-test OK");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const root = process.cwd();
  const files: string[] = [];
  for (const top of ["modules", "apps"]) {
    try { walk(join(root, top), root, files); } catch { /* dir absent */ }
  }
  const big = files
    .map((f) => ({ f: relative(root, f).split("\\").join("/"), n: countLines(readFileSync(f, "utf8")) }))
    .filter((x) => x.n > MAX_LINES)
    .sort((a, b) => b.n - a.n);
  for (const x of big) console.warn(`WARN ${x.f}: ${x.n} lines (> ${MAX_LINES})`);
  console.log(`lint-file-size: ${big.length} file(s) over ${MAX_LINES} lines (warn only)`);
}
