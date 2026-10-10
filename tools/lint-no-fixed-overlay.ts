/**
 * RW-33 guard (WARN mode this session). In modules/10 and modules/11, hand-rolled
 * overlays and raw tables should go through the shared primitives in
 * @assessiq/ui-system: Modal, ConfirmDialog, Drawer and Table.
 *
 * Flags:
 *   - `position: 'fixed'` / `position: "fixed"` in a .tsx/.ts source file
 *   - a raw `<table` JSX element
 *
 * Allowed:
 *   - any line whose previous line (or same line) has `lint-fixed-allow: <kind>`
 *     (kind = drawer | menu | toast | gate | panel). The allow comment documents the reason.
 *   - anything under modules/17-ui-system (the primitives themselves).
 *
 * Usage:
 *   tsx tools/lint-no-fixed-overlay.ts            warn (exit 0, list hits)
 *   tsx tools/lint-no-fixed-overlay.ts --strict   exit 1 on any hit
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCOPES = ["modules/10-admin-dashboard/src", "modules/11-candidate-ui/src"];
const FIXED = /position:\s*["']fixed["']/;
const RAW_TABLE = /<table(\s|>|$)/;
const ALLOW = /lint-fixed-allow:\s*(drawer|menu|toast|gate|panel|table)/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
}

export interface Hit {
  file: string;
  line: number;
  rule: "fixed-overlay" | "raw-table";
  text: string;
}

export function scanSource(file: string, src: string): Hit[] {
  const lines = src.split(/\r?\n/);
  const hits: Hit[] = [];
  lines.forEach((text, i) => {
    const prev = i > 0 ? lines[i - 1]! : "";
    const allowed = ALLOW.test(text) || ALLOW.test(prev);
    if (allowed) return;
    if (FIXED.test(text)) hits.push({ file, line: i + 1, rule: "fixed-overlay", text: text.trim() });
    if (RAW_TABLE.test(text)) hits.push({ file, line: i + 1, rule: "raw-table", text: text.trim() });
  });
  return hits;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const files: string[] = [];
  for (const s of SCOPES) walk(join(ROOT, s), files);
  const hits = files.flatMap((f) => scanSource(relative(ROOT, f).replace(/\\/g, "/"), readFileSync(f, "utf8")));
  if (hits.length === 0) {
    console.log("lint-no-fixed-overlay: OK (0 hits)");
    return;
  }
  console.log(`lint-no-fixed-overlay: ${hits.length} hit(s) (${strict ? "strict" : "warn"} mode)`);
  for (const h of hits) console.log(`  [${h.rule}] ${h.file}:${h.line}  ${h.text}`);
  process.exit(strict ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lint-no-fixed-overlay.ts")) {
  main();
}
