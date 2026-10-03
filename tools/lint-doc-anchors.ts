/**
 * tools/lint-doc-anchors.ts  (RV71a)
 *
 * Every `NN-name.md#anchor` reference in code comments, SKILL.md files and docs must point to a
 * heading that exists in docs/NN-name.md (GitHub slug rules). `#L12` / `#L1-L3` line refs are
 * skipped. docs/ is gitignored (only some files are tracked): if docs/ or the target file is
 * absent (e.g. in CI), that reference is skipped and the skip count is printed.
 *
 * Usage: pnpm lint:doc-anchors | pnpm lint:doc-anchors:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, lineOf, finish, selfTest } from "./lint-util.js";

const DOCS = path.join(REPO_ROOT, "docs");
const REF = /\b(\d\d-[a-z0-9-]+\.md)#([A-Za-z0-9_%-]+)/g;

export function slugs(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const h = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Known stale anchors, fix the doc then delete the entry. */
const KNOWN_STALE = new Set([
  // RV71 found - open: heading is now "15.3 Pattern reflows (catalog ...)"; cited from docs/04-auth-flows.md:629
  "10-branding-guideline.md#153-pattern-reflows-catalog--populated-incrementally-by-later-phases",
]);

/** Violations for one source text, given a loader for doc contents (undefined = doc absent). */
export function checkText(text: string, where: string, load: (doc: string) => string | undefined): string[] {
  const v: string[] = [];
  for (const m of text.matchAll(REF)) {
    const [, doc, anchor] = m;
    if (/^L\d+(-L\d+)?$/.test(anchor!) || KNOWN_STALE.has(`${doc}#${anchor}`)) continue;
    const md = load(doc!);
    if (md === undefined) continue;
    if (!slugs(md).has(decodeURIComponent(anchor!).toLowerCase())) {
      v.push(`${where}:${lineOf(text, m.index!)}: ${doc}#${anchor} - no such heading`);
    }
  }
  return v;
}

if (process.argv.includes("--self-test")) {
  const doc = "# Title\n## Data `model`\n```\n# not a heading\n```\n## Data model\n";
  const load = (): string => doc;
  selfTest(
    "doc-anchors",
    (t) => checkText(t, "t", load),
    "see 02-x.md#data-model and 02-x.md#data-model-1 and 02-x.md#L10-L12",
    "see 02-x.md#not-a-heading",
  );
} else {
  const cache = new Map<string, string | undefined>();
  const load = (doc: string): string | undefined => {
    if (!cache.has(doc)) {
      const p = path.join(DOCS, doc);
      cache.set(doc, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined);
    }
    return cache.get(doc);
  };
  if (!fs.existsSync(DOCS)) {
    console.log("doc-anchors: SKIPPED - docs/ is absent in this checkout (gitignored); runs locally");
    process.exit(0);
  }
  const files = ["modules", "apps", "docs", "tools"].flatMap((d) =>
    walk(path.join(REPO_ROOT, d), (f) => /\.(ts|tsx|md)$/.test(f)));
  const v = files.flatMap((f) => checkText(fs.readFileSync(f, "utf8"), rel(f), load));
  const missing = [...cache.entries()].filter(([, c]) => c === undefined).map(([d]) => d);
  if (missing.length) console.log(`doc-anchors: skipped refs to absent docs: ${missing.join(", ")}`);
  finish("doc-anchors", v, `OK (${files.length} files scanned)`);
}
