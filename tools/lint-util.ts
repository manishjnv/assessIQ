// Shared helpers for the small repo lints (RV71, RV74). Plain node, no deps.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".turbo", ".astro", "AssessIQ_UI_Template"]);

/** Recursively list files under `dir` (absolute) matching `test`. Missing dir -> []. */
export function walk(dir: string, test: (f: string) => boolean = () => true, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

export const rel = (f: string): string => path.relative(REPO_ROOT, f).replace(/\\/g, "/");
export const isSource = (f: string): boolean =>
  /\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f) && !/__tests__/.test(f);
export const lineOf = (text: string, idx: number): number => text.slice(0, idx).split("\n").length;

/** Print violations and exit 1 if any; `ok` is the success line. */
export function finish(name: string, violations: string[], ok: string): never {
  if (violations.length > 0) {
    console.error(`${name}: ${violations.length} violation(s)`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`${name}: ${ok}`);
  process.exit(0);
}

/** Self-test helper: `bad` must produce violations, `good` must produce none. */
export function selfTest(name: string, check: (input: string) => string[], good: string, bad: string): never {
  const g = check(good);
  const b = check(bad);
  if (g.length !== 0 || b.length === 0) {
    console.error(`${name} self-test FAILED: good=${g.length} violation(s) (want 0), bad=${b.length} (want >0)`);
    process.exit(1);
  }
  console.log(`${name} self-test: OK`);
  process.exit(0);
}
