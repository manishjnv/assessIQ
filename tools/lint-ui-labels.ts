/**
 * tools/lint-ui-labels.ts  (RW-13)
 *
 * Pages must show glossary words, not raw data. Line-based heuristic scan of non-test .tsx in
 * modules/10-admin-dashboard/src, modules/11-candidate-ui/src, apps/web/src.
 *
 * Rules (one hit = file:line  rule):
 *   raw-enum    `{x.status}` `{x.type}` `{x.role}` `{x.tier}` `{x.audience}` `{x.scope_type}` rendered
 *               directly. Fix: call a function from modules/10-admin-dashboard/src/lib/labels.ts.
 *               (Only the bare `{a.b}` form is caught; ternaries and template strings are not.)
 *   id-slice    `<name ending in id/Id/sha/hash>.slice(0, N)` (a truncated ID or SHA shown to a user).
 *   http-status `HTTP ${...}` or "HTTP " + x in a string (status code shown to a user).
 *   date        toLocaleString/-DateString/-TimeString, Intl.DateTimeFormat, Intl.RelativeTimeFormat.
 *               Use formatDate/formatDateTime/formatRelative from @assessiq/ui-system. A trailing
 *               `// lint-ui-labels: number` comment allows a number-only toLocaleString().
 *               modules/17-ui-system/src/format.ts is exempt (it is not scanned).
 *
 * WARN mode: exit 0 unless --strict. Usage: pnpm lint:ui-labels [--strict] | pnpm lint:ui-labels:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, isSource, selfTest } from "./lint-util.js";

const DIRS = ["modules/10-admin-dashboard/src", "modules/11-candidate-ui/src", "apps/web/src"];
const RULES: Array<[string, RegExp]> = [
  ["raw-enum", /(?<!=)\{\s*[A-Za-z_][\w?.]*\.(?:status|type|role|tier|audience|scope_type)\s*\}/],
  ["id-slice", /\b\w*(?:[iI]d|sha|Sha|hash|Hash)\b\??\.slice\(\s*0\s*,\s*\d+\s*\)/],
  ["http-status", /HTTP\s*\$\{|["'`]HTTP\s*["'`]\s*\+/],
  ["date", /\btoLocale(?:Date|Time)?String\s*\(|\bIntl\.(?:DateTimeFormat|RelativeTimeFormat)\b/],
];

export function check(text: string, where = "x.tsx"): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*")) return;
    for (const [name, re] of RULES) {
      if (!re.test(line)) continue;
      if (name === "date" && /\/\/\s*lint-ui-labels:\s*number/.test(line)) continue;
      out.push(`${where}:${i + 1}  ${name}`);
    }
  });
  return out;
}

if (process.argv.includes("--self-test")) {
  selfTest(
    "lint-ui-labels",
    check,
    [
      "<span>{questionTypeLabel(q.type)}</span>",
      "const n = total.toLocaleString(); // lint-ui-labels: number",
      "const short = code.slice(0, 6);",
    ].join("\n"),
    ["<b>{q.status}</b>", "<i>{row.id.slice(0, 8)}</i>", "`HTTP ${err.status}`", "d.toLocaleDateString()"].join("\n"),
  );
}

const hits: string[] = [];
for (const d of DIRS) {
  for (const f of walk(path.join(REPO_ROOT, d), (p) => p.endsWith(".tsx") && isSource(p))) {
    hits.push(...check(fs.readFileSync(f, "utf8"), rel(f)));
  }
}
const byRule: Record<string, number> = {};
for (const h of hits) { const r = h.split(/\s+/).pop()!; byRule[r] = (byRule[r] ?? 0) + 1; }
for (const h of hits) console.log(h);
console.log(`ui-labels: ${hits.length} hit(s) ${JSON.stringify(byRule)}`);
process.exit(process.argv.includes("--strict") && hits.length > 0 ? 1 : 0);
