/**
 * EXP-10 part 1 (owner decision 2026-10-29): question content is never drawn as raw html.
 *   - No file may use dangerouslySetInnerHTML, innerHTML, outerHTML or insertAdjacentHTML.
 *   - KaTeX (which writes into the DOM through katex.render) is imported by exactly one page component, MathText.tsx.
 *     The server-side check (module 04 rich-validate.ts) may import it too: it only produces strings and throws.
 * A new file that breaks either rule fails this test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCAN = ["apps/web/src", "modules"];
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "storybook-static"]);

function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIR.has(n)) continue;
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.(test|stories)\.(ts|tsx)$/.test(n) && !/__tests__/.test(p.replace(/\\/g, "/"))) out.push(p);
  }
}

const files: string[] = [];
for (const s of SCAN) walk(join(ROOT, s), files);
const rel = (f: string): string => relative(ROOT, f).replace(/\\/g, "/");

describe("question content is never raw html", () => {
  it("scans a believable number of source files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no source file uses dangerouslySetInnerHTML, innerHTML, outerHTML or insertAdjacentHTML", () => {
    const re = /dangerouslySetInnerHTML\s*[=:]|\.(innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML\s*\(/;
    const offenders = files.filter((f) => re.test(readFileSync(f, "utf-8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("only MathText.tsx (page) and rich-validate.ts (server check) import katex", () => {
    const re = /from\s+["']katex["']|import\(\s*["']katex["']\s*\)|require\(\s*["']katex["']\s*\)/;
    const offenders = files.filter((f) => re.test(readFileSync(f, "utf-8"))).map(rel).sort();
    expect(offenders).toEqual([
      "modules/04-question-bank/src/assets/rich-validate.ts",
      "modules/17-ui-system/src/components/MathText.tsx",
    ]);
  });

  it("MathText draws only through katex.render with the shared options (trust off) and never builds html itself", () => {
    const full = readFileSync(join(ROOT, "modules/17-ui-system/src/components/MathText.tsx"), "utf-8");
    const src = full.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // code only, not the header comment
    expect(src).toMatch(/KATEX_OPTIONS/);
    expect(src).toMatch(/\.render\(tex, target\.current/);
    expect(src).not.toMatch(/renderToString|innerHTML|trust\s*:\s*true/);
  });
});
