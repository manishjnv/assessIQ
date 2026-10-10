/**
 * tools/lint-core-helpers.ts  (RW-35)
 *
 * One definition of each shared helper, all in modules/00-core/src (ids, pagination, hash, escape).
 * Fails (exit 1, file:line) when a source file outside modules/00-core/src has its own copy.
 * Test files, node_modules, dist are skipped. The allowlist is EMPTY on purpose.
 *
 * Usage: pnpm lint:core-helpers | pnpm lint:core-helpers:self-test
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, walk, rel, isSource, finish, selfTest } from "./lint-util.js";

const DIRS = ["modules", "apps", "packages", "tools"];
const CORE = "modules/00-core/src/";
// Patterns are built from pieces so this file never matches itself.
const RULES: Array<[string, RegExp]> = [
  ["createHash", new RegExp("\\bcreate" + "Hash\\(")],
  ["timingSafeEqual", new RegExp("\\btiming" + "SafeEqual\\(")],
  ["uuid-regex", new RegExp("\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}")],
  [
    "local-helper",
    new RegExp("\\b(?:function|const)\\s+(?:escape" + "Html|csv" + "Escape|csv" + "Cell|parse" + "Pagination|sha256" + "Hex)\\b"),
  ],
];

export function check(text: string, where = "x.ts"): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*")) return;
    for (const [name, re] of RULES) if (re.test(line)) out.push(`${where}:${i + 1}  ${name}`);
  });
  return out;
}

if (process.argv.includes("--self-test")) {
  selfTest(
    "lint-core-helpers",
    check,
    'import { sha256Hex } from "@assessiq/core";\nconst ok = isUuid(x);',
    "const h = create" + 'Hash("sha256");\nfunction escape' + "Html(s) {}\nconst csv" + "Cell = (v) => v;\nconst r = /^[0-9a-f]{" + "8}-[0-9a-f]{4}-/i;",
  );
}

const violations: string[] = [];
for (const d of DIRS) {
  for (const f of walk(path.join(REPO_ROOT, d), isSource)) {
    const r = rel(f);
    if (r.startsWith(CORE)) continue;
    violations.push(...check(fs.readFileSync(f, "utf8"), r));
  }
}
finish("lint-core-helpers", violations, "OK (no local copies of shared helpers)");
