/**
 * tools/lint-logging-discipline.ts
 *
 * Enforces the operational-logging convention from docs/11-observability.md:
 *
 *   1. No `console.<level>(...)` calls in production source (apps/api, modules,
 *      tools). Frontend (apps/web) is allowed gated dev-console warnings via
 *      `import.meta.env.DEV` — these are explicitly whitelisted.
 *
 *   2. Module source files must NOT import the root `logger` from
 *      `@assessiq/core` — they must use `streamLogger(name)` instead so log
 *      lines route to the right per-stream file. (Apps and tools are exempt:
 *      apps/api may import the bare `streamLogger`; tools/ has its own pattern.)
 *
 *   3. No string concatenation in log calls — pino is structured.
 *      Pattern caught: `log.<level>('msg ' + value)` or `log.<level>(\`...${value}...\`)`.
 *      Object-form is required: `log.info({field: value}, 'msg')`.
 *
 *   4. No bare `log.error(err)` — must be `log.error({err}, '<label>')`.
 *      A bare error arg loses field structure on the on-disk file.
 *
 * Exit code: 0 = clean, 1 = violations (one-line summary per violation).
 *
 * Cross-reference: docs/11-observability.md § 8 — How a module emits logs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const SCAN_ROOTS = ["apps/api/src", "modules", "tools"];

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "coverage", ".turbo",
  "__tests__", "__mocks__", "AccessIQ_UI_Template",
]);

// Files explicitly exempted (with rationale)
const EXEMPT_FILES = new Set([
  // tools/migrate.ts uses a self-contained JSONL writer because the workspace
  // package can't be resolved from outside the workspace; documented in-file.
  "tools/migrate.ts",
  // tools/lint-* scripts use process.stdout.write + process.exit — the
  // logging-discipline lint itself is intentionally console-free but uses
  // process.std{out,err} for CLI output.
  "tools/lint-rls-policies.ts",
  "tools/lint-logging-discipline.ts",
]);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function normalizeFile(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function lintFile(absPath: string): Violation[] {
  const rel = normalizeFile(absPath);
  if (EXEMPT_FILES.has(rel)) return [];

  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const violations: Violation[] = [];

  // Rule 1 — no console.<level> in non-frontend source.
  // The lint runs against apps/api + modules + tools, so any console.* hit is a violation.
  const consoleRe = /\bconsole\.(log|error|warn|info|debug)\s*\(/;

  // Rule 2 — modules/* must not import the root `logger` from @assessiq/core.
  // Detect: `import { ..., logger, ... } from '@assessiq/core'` or `from "@assessiq/core"`.
  const isModuleFile = rel.startsWith("modules/");
  const loggerImportRe = /import\s*\{[^}]*\blogger\b[^}]*\}\s*from\s*['"]@assessiq\/core['"]/;

  // Rule 3 — string concat in log calls. Conservative regex — catches
  // `log.<level>('foo' + bar)` and template-literal-as-only-arg cases.
  const concatRe = /\blog\w*\.(info|warn|error|debug|trace|fatal)\s*\(\s*['"`][^'"`]*['"`]\s*\+/;
  const tmplRe = /\blog\w*\.(info|warn|error|debug|trace|fatal)\s*\(\s*`[^`]*\$\{/;

  // Rule 4 — bare `log.error(err)` single-arg form.
  // Pattern: `log.error(<identifier>)` where <identifier> is not an object literal.
  const bareErrRe = /\blog\w*\.error\s*\(\s*[a-zA-Z_$][\w$]*\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (consoleRe.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: "no-console", text: line.trim() });
    }

    if (isModuleFile && loggerImportRe.test(line)) {
      violations.push({
        file: rel, line: i + 1, rule: "modules-must-use-streamLogger",
        text: line.trim(),
      });
    }

    if (concatRe.test(line) || tmplRe.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: "no-string-concat-in-log", text: line.trim() });
    }

    if (bareErrRe.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: "no-bare-error-arg", text: line.trim() });
    }
  }

  return violations;
}

function main(): void {
  const violations: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    try { statSync(abs); } catch { continue; }
    for (const file of walk(abs)) {
      violations.push(...lintFile(file));
    }
  }

  if (violations.length === 0) {
    process.stdout.write("logging-discipline: OK (0 violations)\n");
    process.exit(0);
  }

  process.stderr.write(`logging-discipline: ${violations.length} violation(s)\n\n`);
  for (const v of violations) {
    process.stderr.write(`  [${v.rule}] ${v.file}:${v.line}\n      ${v.text}\n`);
  }
  process.stderr.write(
    "\nRules:\n" +
    "  no-console                       → use streamLogger() from @assessiq/core\n" +
    "  modules-must-use-streamLogger    → import { streamLogger } not { logger }\n" +
    "  no-string-concat-in-log          → use object-form: log.info({field}, 'msg')\n" +
    "  no-bare-error-arg                → log.error({err}, 'label') not log.error(err)\n" +
    "\nSee docs/11-observability.md § 8.\n",
  );
  process.exit(1);
}

main();
