/**
 * tools/lint-cross-module-deps.ts
 *
 * Cross-module dependency declaration lint for AssessIQ.
 *
 * RCA-prevention guard against the "import @assessiq/X without declaring
 * X in package.json" class of bugs. Three instances caused production
 * restart-loops — see docs/RCA_LOG.md 2026-05-03 § "Missing @assessiq/audit-log
 * dep declarations: recurring pattern (3rd instance), prod restart-loop":
 *
 *   1. 73ad0b2 (Phase 1 closure fix) — modules/02-tenancy importing @assessiq/audit-log
 *      undeclared; surfaced in lifecycle test suite.
 *   2. 8fff574 (G3.D session) — apps/api/package.json missing @assessiq/audit-log;
 *      surfaced when assessiq-api container tried to boot.
 *   3. 81da5db — modules/02-tenancy + modules/13-notifications still missing after
 *      an over-broad revert removed legit declarations.
 *
 * pnpm typecheck passes even with undeclared workspace deps (TypeScript resolves
 * from the monorepo virtual store regardless of declarations). This lint covers the
 * gap that TypeScript misses: runtime ESM resolution requires the dep to be in the
 * per-package node_modules, which only happens when it's declared in package.json.
 *
 * ─── What this lint checks ───────────────────────────────────────────────────────
 *
 * 1. Recursively scans all .ts / .tsx files under:
 *      modules/<n>-<name>/src/**
 *      apps/<name>/src/**
 *      packages/<name>/src/**
 *      tools/**
 *      infra/**
 *    (.d.ts declaration files are skipped.)
 *
 * 2. For each file, walks UP the directory tree to find the nearest package.json.
 *    For example:
 *      modules/02-tenancy/src/service.ts → modules/02-tenancy/package.json  ✓
 *      tools/lint-cross-module-deps.ts   → <workspace-root>/package.json    ✓
 *    The walk stops at the workspace root (inclusive).
 *
 * 3. Extracts every import of an @assessiq/* package:
 *      import ... from "@assessiq/X"          (static default/named/namespace)
 *      import "@assessiq/X"                   (side-effect)
 *      export ... from "@assessiq/X"          (re-export)
 *      import("@assessiq/X")                  (dynamic)
 *    Sub-paths are stripped: "@assessiq/help-system/components" → "@assessiq/help-system"
 *    Relative imports (./*, ../*) and non-@assessiq packages are skipped.
 *
 * 4. Asserts the package is declared in the importer's package.json:
 *    - Non-test files: must be in `dependencies`
 *      (runtime ESM resolution uses only the declared dependency graph)
 *    - Test files (under __tests__/ or *.test.ts / *.spec.ts):
 *      must be in `dependencies` OR `devDependencies`
 *      (test-only workspace imports may legitimately live in devDeps)
 *
 * ─── Violation format ────────────────────────────────────────────────────────────
 *
 *   MISSING DEP  modules/02-tenancy/package.json ← "@assessiq/audit-log"
 *     used in modules/02-tenancy/src/service.ts:15
 *
 * ─── --check-unused flag ─────────────────────────────────────────────────────────
 *
 *   pnpm tsx tools/lint-cross-module-deps.ts --check-unused
 *
 *   Additionally reports every @assessiq/* listed in a package's `dependencies`
 *   (not devDependencies) that is never imported by any file in that package's
 *   source tree. Bloat catcher. Gated behind a flag so transitional scaffolding
 *   states don't break builds (e.g., a dep declared before its first use).
 *
 * ─── --self-test flag ────────────────────────────────────────────────────────────
 *
 *   pnpm tsx tools/lint-cross-module-deps.ts --self-test
 *
 *   Runs the core logic against in-memory fixtures and asserts correct detection.
 *   Exit 0 = pass. Structurally identical to lint-rls-policies.ts --self-test.
 *
 * ─── Exit codes ──────────────────────────────────────────────────────────────────
 *
 *   0  clean (no violations)
 *   1  one or more violations found
 *   2  internal error (malformed package.json, unreadable file, etc.)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────────
 *
 *   pnpm tsx tools/lint-cross-module-deps.ts
 *   pnpm tsx tools/lint-cross-module-deps.ts --self-test
 *   pnpm tsx tools/lint-cross-module-deps.ts --check-unused
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Dirent } from "node:fs";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AssessIQ_UI_Template",
  "storybook-static",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** An @assessiq/* import reference extracted from a source file. */
interface ImportRef {
  /** Package name without subpath, e.g. "@assessiq/core" */
  pkg: string;
  /** 1-based line number of first occurrence in the file */
  line: number;
}

/** A "missing dep" violation: file imports X but package.json doesn't declare X. */
interface DepViolation {
  /** Absolute path to the package.json that should be updated */
  pkgJsonPath: string;
  /** The @assessiq/X package that's missing */
  depName: string;
  /** Absolute path to the source file that has the import */
  sourceFile: string;
  /** 1-based line of the first import occurrence */
  line: number;
  /** Whether the violation is in a test file */
  isTestFile: boolean;
}

/** An "unused dep" violation: package.json declares X but no file imports X. */
interface UnusedDepViolation {
  pkgJsonPath: string;
  depName: string;
}

// ─── Import extraction ────────────────────────────────────────────────────────

/**
 * Extracts the @assessiq/ package name from any quoted reference.
 * Used only on lines that have already been gated by isImportLine().
 */
const RE_ASSESSIQ_IN_QUOTES =
  /["'](@assessiq\/[^/'"]+(?:\/[^'"]+)?)["']/;

/**
 * Matches dynamic imports: import("@assessiq/X") — can appear anywhere on a
 * non-comment line (e.g. `const m = await import("@assessiq/scoring")`).
 */
const RE_DYNAMIC_SRC =
  /\bimport\s*\(\s*["'](@assessiq\/[^/'"]+(?:\/[^'"]+)?)["']\s*\)/;

/** Strip sub-path: "@assessiq/help-system/components" → "@assessiq/help-system" */
function extractPkgName(importPath: string): string {
  const m = /^(@assessiq\/[^/]+)/.exec(importPath);
  return m?.[1] ?? importPath;
}

/** Return true if the file is dev-only: test files, root-level tool scripts, or
 * module-internal CI scripts. Dev-only files may declare @assessiq/* deps in
 * either `dependencies` or `devDependencies` in their nearest package.json.
 *
 * - Test files (under __tests__/ or *.test.ts / *.spec.ts): standard test-only
 *   workspace imports may legitimately live in devDeps.
 * - Root-level tools (tools/**): these scripts are never bundled into production
 *   runtime; their workspace imports belong in root devDependencies.
 * - Module CI scripts (modules/N-name/ci/): linters like lint-no-ambient-claude.ts live
 *   here; also never deployed to production.
 */
function isTestFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");

  // Standard test file patterns
  if (
    norm.includes("/__tests__/") ||
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.tsx") ||
    norm.endsWith(".spec.ts") ||
    norm.endsWith(".spec.tsx")
  ) {
    return true;
  }

  // Root-level tools/ and module-internal ci/ are dev-time only
  const repoNorm = REPO_ROOT.replace(/\\/g, "/");
  const rel = norm.startsWith(repoNorm + "/")
    ? norm.slice(repoNorm.length + 1)
    : norm;
  return rel.startsWith("tools/") || rel.includes("/ci/");
}

/**
 * Returns true if the trimmed line is an import/export statement or the
 * closing `} from "..."` of a multi-line import.
 *
 * Only these line shapes can legitimately carry @assessiq/ package references
 * as real imports. All other line shapes (string literal values, object
 * properties, comments) are skipped to avoid false positives.
 *
 * Examples that return true:
 *   import { foo } from "@assessiq/core"
 *   import type { T } from "@assessiq/auth"
 *   import "@assessiq/notifications"
 *   export { X } from "@assessiq/core"
 *   export * from "@assessiq/auth"
 *   export type { T } from "@assessiq/tenancy"
 *   } from "@assessiq/core"        ← multi-line import close
 *
 * Examples that return false (no false positive):
 *   'import { foo } from "@assessiq/core";',   ← string literal in source
 *   content: `import { X } from "@assessiq/Y"` ← template prop value
 *   * @uses @assessiq/core                      ← JSDoc body
 *   // import from "@assessiq/core"             ← comment
 */
function isImportLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("import{") ||
    trimmed.startsWith("import'") ||
    trimmed.startsWith('import"') ||
    trimmed === "import" ||
    trimmed.startsWith("export ") ||
    trimmed.startsWith("export{") ||
    trimmed.startsWith("> from ") || // hypothetical but harmless
    trimmed.startsWith("} from ") || // multi-line import close: } from "..."
    trimmed.startsWith("} from'") ||
    trimmed.startsWith('} from"')
  );
}

/**
 * Extract unique @assessiq/* import references from file content.
 * Returns one entry per package (first occurrence line number).
 *
 * Design choices:
 * - Static imports: only matched on lines where the import/export keyword is
 *   the leading token (see isImportLine above). This avoids false positives
 *   from string literal values that contain import-like text (e.g., self-test
 *   fixture strings in lint tools, template literal property values, etc.).
 * - Dynamic imports: matched on all non-comment lines because they can appear
 *   inside expressions (const x = await import("@assessiq/core")).
 * - Comment lines (//, * JSDoc body) are skipped entirely.
 */
function extractImports(content: string): ImportRef[] {
  const lines = content.split("\n");
  const seen = new Map<string, number>(); // pkg → first line

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const trimmed = line.trimStart();

    // Skip comment lines
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith("*/") ||
      trimmed === "*"
    ) {
      continue;
    }

    // Static / re-export / side-effect imports — only on import/export lines
    if (isImportLine(trimmed)) {
      const re = new RegExp(RE_ASSESSIQ_IN_QUOTES.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const pkg = extractPkgName(m[1]!);
        if (!seen.has(pkg)) seen.set(pkg, lineNo);
      }
    }

    // Dynamic imports — scan all non-comment lines.
    // Exception: skip lines whose trimmed content starts with a quote character
    // ('  "  `) — those are string literal VALUES (e.g. self-test fixture
    // strings like `'const x = await import("@assessiq/scoring");',`), not
    // real dynamic-import call-sites. Real dynamic imports live inside
    // expressions that start with const/let/return/await/etc., never a quote.
    const isStringValueLine =
      trimmed.startsWith("'") ||
      trimmed.startsWith('"') ||
      trimmed.startsWith("`");
    if (!isStringValueLine) {
      const reDyn = new RegExp(RE_DYNAMIC_SRC.source, "g");
      let m: RegExpExecArray | null;
      while ((m = reDyn.exec(line)) !== null) {
        const pkg = extractPkgName(m[1]!);
        if (!seen.has(pkg)) seen.set(pkg, lineNo);
      }
    }
  }

  return Array.from(seen.entries()).map(([pkg, line]) => ({ pkg, line }));
}

// ─── Package.json helpers ─────────────────────────────────────────────────────

/**
 * Read and parse a package.json file. Throws with a human-readable error
 * on ENOENT or JSON parse failure.
 */
async function readPackageJson(pkgPath: string): Promise<PackageJson> {
  let raw: string;
  try {
    raw = await fsp.readFile(pkgPath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${pkgPath}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw) as PackageJson;
  } catch (err) {
    throw new Error(`Malformed JSON in ${pkgPath}: ${String(err)}`);
  }
}

/**
 * Walk UP from a directory to find the nearest package.json, stopping at
 * REPO_ROOT (inclusive). Uses a per-call cache to avoid repeated stat calls.
 *
 * Cache semantics: maps a directory path → the nearest package.json found by
 * walking up from that directory (or null if none found before REPO_ROOT).
 */
async function findNearestPkgJson(
  startDir: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (cache.has(startDir)) return cache.get(startDir) ?? null;

  // Build the walk-up path from startDir to REPO_ROOT
  const dirs: string[] = [];
  let dir = startDir;
  while (true) {
    dirs.push(dir);
    if (dir === REPO_ROOT) break;
    if (!dir.startsWith(REPO_ROOT)) {
      // Gone above REPO_ROOT somehow — stop
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Walk the list, check each dir for package.json
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i]!;

    // Check cache for this dir first
    if (cache.has(d)) {
      const cached = cache.get(d) ?? null;
      if (cached !== null) {
        // Back-fill cache for the dirs we walked through to get here
        for (let j = 0; j < i; j++) cache.set(dirs[j]!, cached);
        return cached;
      }
      // cached === null means "no pkg.json at this level", continue up
      continue;
    }

    const candidate = path.join(d, "package.json");
    try {
      await fsp.access(candidate);
      // Found — back-fill cache for all dirs we walked through
      for (let j = 0; j <= i; j++) cache.set(dirs[j]!, candidate);
      return candidate;
    } catch {
      cache.set(d, null); // mark this dir as checked, no pkg.json here
    }
  }

  // Not found anywhere in the walk
  cache.set(startDir, null);
  return null;
}

// ─── Core violation checker ────────────────────────────────────────────────────

/**
 * Check a single source file for missing @assessiq/* dep declarations.
 * Operates purely on in-memory data — suitable for use in self-test.
 */
function checkFileViolations(
  filePath: string,
  content: string,
  pkgJson: PackageJson,
  pkgJsonPath: string
): DepViolation[] {
  const imports = extractImports(content);
  const isTest = isTestFile(filePath);
  const violations: DepViolation[] = [];

  const deps = pkgJson.dependencies ?? {};
  const devDeps = pkgJson.devDependencies ?? {};

  for (const { pkg, line } of imports) {
    // Non-test files: must be in `dependencies` (not just devDependencies —
    // devDeps are excluded from production pnpm installs).
    //
    // Test files: accepted in either `dependencies` or `devDependencies`
    // (test-only workspace imports may legitimately live in devDeps to keep
    // the production dep graph lean).
    const declared = isTest
      ? (pkg in deps) || (pkg in devDeps)
      : (pkg in deps);

    if (!declared) {
      violations.push({
        pkgJsonPath,
        depName: pkg,
        sourceFile: filePath,
        line,
        isTestFile: isTest,
      });
    }
  }

  return violations;
}

// ─── File collection ──────────────────────────────────────────────────────────

/**
 * Recursively collect all .ts / .tsx files under `root`, skipping SKIP_DIRS
 * and .d.ts declaration files.
 */
async function collectSourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const name = entry.name;
        if (
          (name.endsWith(".ts") || name.endsWith(".tsx")) &&
          !name.endsWith(".d.ts")
        ) {
          results.push(full);
        }
      }
    }
  }

  await walk(root);
  return results;
}

// ─── Self-test ────────────────────────────────────────────────────────────────

function runSelfTest(): void {
  process.stdout.write("Running lint-cross-module-deps self-test...\n");

  let passed = true;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      process.stdout.write(`  PASS: ${name}\n`);
    } else {
      process.stderr.write(`  FAIL: ${name}\n`);
      passed = false;
    }
  }

  const FAKE_PKG = "/fake/modules/02-tenancy/package.json";
  const pkgEmpty: PackageJson = { dependencies: {} };
  const pkgWithCore: PackageJson = {
    dependencies: { "@assessiq/core": "workspace:*" },
  };
  const pkgWithAuditLog: PackageJson = {
    dependencies: { "@assessiq/audit-log": "workspace:*" },
  };
  const pkgDevOnly: PackageJson = {
    devDependencies: { "@assessiq/audit-log": "workspace:*" },
  };
  const pkgWithBoth: PackageJson = {
    dependencies: { "@assessiq/core": "workspace:*" },
    devDependencies: { "@assessiq/audit-log": "workspace:*" },
  };

  // ─── Import extraction ─────────────────────────────────────────────────────

  const refs = extractImports([
    'import { foo } from "@assessiq/core";',
    'import type { Bar } from "@assessiq/tenancy";',
    'export * from "@assessiq/auth";',
    'import "@assessiq/notifications";',
    'const x = await import("@assessiq/scoring");',
    "import './local';",
    "import 'fastify';",
    "import * as fs from 'node:fs';",
    'import { X } from "@assessiq/help-system/components";',
    "// import { Y } from \"@assessiq/audit-log\"; -- commented out",
    " * @uses import from \"@assessiq/rubric-engine\" -- JSDoc body line",
    'export { Z } from "@assessiq/users";',
  ].join("\n"));

  const imported = new Set(refs.map((r) => r.pkg));
  assert(imported.has("@assessiq/core"), "extracts static default/named import");
  assert(imported.has("@assessiq/tenancy"), "extracts type-only import");
  assert(imported.has("@assessiq/auth"), "extracts re-export *");
  assert(imported.has("@assessiq/notifications"), "extracts side-effect import");
  assert(imported.has("@assessiq/scoring"), "extracts dynamic import");
  assert(imported.has("@assessiq/users"), "extracts named re-export");
  assert(
    imported.has("@assessiq/help-system"),
    "strips subpath: @assessiq/help-system/components → @assessiq/help-system"
  );
  assert(
    !imported.has("@assessiq/help-system/components"),
    "does not keep the subpath as a separate entry"
  );
  assert(!imported.has("fastify"), "skips non-@assessiq package");
  assert(!imported.has("node:fs"), "skips node built-in (node: prefix)");
  assert(!imported.has("./local"), "skips relative import");
  assert(!imported.has("@assessiq/audit-log"), "skips // comment lines");
  assert(!imported.has("@assessiq/rubric-engine"), "skips * JSDoc body lines");

  // Line number for first occurrence
  const coreRef = refs.find((r) => r.pkg === "@assessiq/core");
  assert(coreRef?.line === 1, "line number is 1-based and correct");

  // ─── Missing dep — non-test file ───────────────────────────────────────────

  const v1 = checkFileViolations(
    "/fake/modules/02-tenancy/src/service.ts",
    'import { auditLog } from "@assessiq/audit-log";',
    pkgEmpty,
    FAKE_PKG
  );
  assert(v1.length === 1, "missing dep in non-test file → 1 violation");
  assert(
    v1[0]?.depName === "@assessiq/audit-log",
    "violation names the missing dep"
  );
  assert(v1[0]?.line === 1, "violation reports the correct line number");
  assert(
    v1[0]?.pkgJsonPath === FAKE_PKG,
    "violation points to the correct package.json"
  );

  // ─── Declared dep — non-test file ──────────────────────────────────────────

  const v2 = checkFileViolations(
    "/fake/modules/00-core/src/config.ts",
    'import { config } from "@assessiq/core";',
    pkgWithCore,
    FAKE_PKG
  );
  assert(v2.length === 0, "declared dep in non-test file → 0 violations");

  // ─── devDeps-only — non-test file → should be a violation ──────────────────

  const v3 = checkFileViolations(
    "/fake/modules/02-tenancy/src/service.ts",
    'import { log } from "@assessiq/audit-log";',
    pkgDevOnly,
    FAKE_PKG
  );
  assert(
    v3.length === 1,
    "dep in devDependencies only + non-test file → violation (needs to be in dependencies)"
  );

  // ─── devDeps-only — test file → no violation ───────────────────────────────

  const v4 = checkFileViolations(
    "/fake/modules/02-tenancy/src/__tests__/service.test.ts",
    'import { log } from "@assessiq/audit-log";',
    pkgDevOnly,
    FAKE_PKG
  );
  assert(
    v4.length === 0,
    "dep in devDependencies + test file → no violation (devDeps OK for tests)"
  );

  // ─── Missing dep — test file ────────────────────────────────────────────────

  const v5 = checkFileViolations(
    "/fake/modules/02-tenancy/src/__tests__/service.test.ts",
    'import { audit } from "@assessiq/audit-log";',
    pkgEmpty,
    FAKE_PKG
  );
  assert(
    v5.length === 1,
    "missing dep in test file (not in deps or devDeps) → violation"
  );

  // ─── Dynamic import — missing dep ──────────────────────────────────────────

  const v6 = checkFileViolations(
    "/fake/modules/13-notifications/src/loader.ts",
    'const m = await import("@assessiq/notifications");',
    pkgEmpty,
    FAKE_PKG
  );
  assert(v6.length === 1, "dynamic import with missing dep → violation");

  // ─── Subpath import — base package declared ────────────────────────────────

  const v7 = checkFileViolations(
    "/fake/apps/web/src/ui.tsx",
    'import { Button } from "@assessiq/help-system/components";',
    { dependencies: { "@assessiq/help-system": "workspace:*" } },
    FAKE_PKG
  );
  assert(
    v7.length === 0,
    "subpath import with base package declared → no violation"
  );

  // ─── Subpath import — base package NOT declared ────────────────────────────

  const v8 = checkFileViolations(
    "/fake/apps/web/src/ui.tsx",
    'import { Button } from "@assessiq/help-system/components";',
    pkgEmpty,
    FAKE_PKG
  );
  assert(
    v8.length === 1,
    "subpath import with base package undeclared → violation"
  );

  // ─── Non-@assessiq and node built-ins skipped ──────────────────────────────

  const v9 = checkFileViolations(
    "/fake/modules/00-core/src/utils.ts",
    [
      'import fastify from "fastify";',
      'import * as fs from "node:fs";',
      "import './local';",
      'import "pg";',
      'import { Pool } from "pg";',
    ].join("\n"),
    pkgEmpty,
    FAKE_PKG
  );
  assert(
    v9.length === 0,
    "non-@assessiq imports (fastify, node:fs, pg, relative) → 0 violations"
  );

  // ─── Multiple imports, some declared ──────────────────────────────────────

  const v10 = checkFileViolations(
    "/fake/modules/05-assessment-lifecycle/src/service.ts",
    [
      'import { core } from "@assessiq/core";',
      'import { auditLog } from "@assessiq/audit-log";',
    ].join("\n"),
    pkgWithCore,
    FAKE_PKG
  );
  assert(
    v10.length === 1,
    "multiple imports: one declared, one missing → exactly 1 violation"
  );
  assert(
    v10[0]?.depName === "@assessiq/audit-log",
    "violation targets the undeclared dep, not the declared one"
  );

  // ─── Type-only import — missing dep ────────────────────────────────────────

  const v11 = checkFileViolations(
    "/fake/modules/02-tenancy/src/types.ts",
    'import type { Config } from "@assessiq/core";',
    pkgEmpty,
    FAKE_PKG
  );
  assert(
    v11.length === 1,
    "type-only import with missing dep → violation (TS resolves it, runtime doesn't)"
  );

  // ─── Re-export with declared dep ───────────────────────────────────────────

  const v12 = checkFileViolations(
    "/fake/modules/00-core/src/index.ts",
    'export type { Foo } from "@assessiq/core";',
    pkgWithCore,
    FAKE_PKG
  );
  assert(v12.length === 0, "type re-export with declared dep → no violation");

  // ─── The exact real-world RCA pattern ─────────────────────────────────────

  // Simulates 81da5db: 02-tenancy/src/service.ts imports @assessiq/audit-log
  // but modules/02-tenancy/package.json declares only @assessiq/core
  const v13 = checkFileViolations(
    "/fake/modules/02-tenancy/src/service.ts",
    [
      'import { getPool } from "@assessiq/core";',
      'import { writeAuditLog } from "@assessiq/audit-log";',
    ].join("\n"),
    pkgWithCore, // only @assessiq/core declared
    "/fake/modules/02-tenancy/package.json"
  );
  assert(
    v13.length === 1,
    "RCA regression: 02-tenancy imports audit-log without declaration → caught"
  );
  assert(
    v13[0]?.depName === "@assessiq/audit-log",
    "RCA regression: violation correctly names @assessiq/audit-log"
  );
  assert(
    v13[0]?.pkgJsonPath === "/fake/modules/02-tenancy/package.json",
    "RCA regression: violation points to 02-tenancy/package.json"
  );

  // ─── isTestFile detection ──────────────────────────────────────────────────

  assert(
    isTestFile("/fake/modules/01-auth/src/__tests__/api-keys.test.ts"),
    "isTestFile: __tests__ directory"
  );
  assert(
    isTestFile("/fake/modules/01-auth/src/sessions.test.ts"),
    "isTestFile: .test.ts suffix"
  );
  assert(
    isTestFile("/fake/modules/01-auth/src/sessions.spec.ts"),
    "isTestFile: .spec.ts suffix"
  );
  assert(
    !isTestFile("/fake/modules/01-auth/src/sessions.ts"),
    "isTestFile: normal .ts file → false"
  );

  // ─── Result ────────────────────────────────────────────────────────────────

  if (passed) {
    process.stdout.write("\nCross-module dep lint self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("\nCross-module dep lint self-test: FAILED\n");
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return; // runSelfTest calls process.exit; this keeps TS happy
  }

  const checkUnused = args.includes("--check-unused");

  try {
    const files = await collectSourceFiles(REPO_ROOT);

    // Walk all files: find their nearest package.json, read content, extract imports.
    // Group by package.json path for the --check-unused pass.
    const pkgJsonDirCache = new Map<string, string | null>();
    const pkgJsonContentCache = new Map<string, PackageJson>();

    // filesByPkg: pkgJsonPath → { pkgJson, files: [{path, content, imports}] }
    interface FileEntry {
      path: string;
      content: string;
      imports: ImportRef[];
    }
    interface PkgGroup {
      pkgJson: PackageJson;
      files: FileEntry[];
    }
    const byPkg = new Map<string, PkgGroup>();

    for (const file of files) {
      const fileDir = path.dirname(file);
      const pkgPath = await findNearestPkgJson(fileDir, pkgJsonDirCache);
      if (!pkgPath) {
        // No package.json found between this file and repo root — skip silently.
        // (This shouldn't happen in a normal workspace but don't crash on it.)
        continue;
      }

      // Read / cache the package.json
      if (!pkgJsonContentCache.has(pkgPath)) {
        let pkgJson: PackageJson;
        try {
          pkgJson = await readPackageJson(pkgPath);
        } catch (err) {
          process.stderr.write(`Internal error: ${String(err)}\n`);
          process.exit(2);
        }
        pkgJsonContentCache.set(pkgPath, pkgJson);
      }

      // Read the source file
      let content: string;
      try {
        content = await fsp.readFile(file, "utf8");
      } catch {
        // File disappeared between collection and read — skip
        continue;
      }

      const imports = extractImports(content);

      if (!byPkg.has(pkgPath)) {
        byPkg.set(pkgPath, {
          pkgJson: pkgJsonContentCache.get(pkgPath)!,
          files: [],
        });
      }
      byPkg.get(pkgPath)!.files.push({ path: file, content, imports });
    }

    // Collect violations
    const violations: DepViolation[] = [];
    const unusedViolations: UnusedDepViolation[] = [];

    for (const [pkgPath, group] of byPkg) {
      // Pass 1: missing dep declarations
      for (const entry of group.files) {
        const fileViolations = checkFileViolations(
          entry.path,
          entry.content,
          group.pkgJson,
          pkgPath
        );
        violations.push(...fileViolations);
      }

      // Pass 2 (optional): declared deps that are never imported
      if (checkUnused) {
        const declaredDeps = Object.keys(group.pkgJson.dependencies ?? {}).filter(
          (k) => k.startsWith("@assessiq/")
        );

        if (declaredDeps.length > 0) {
          // Collect all @assessiq/* actually imported anywhere in this package
          const importedPkgs = new Set<string>();
          for (const entry of group.files) {
            for (const { pkg } of entry.imports) {
              importedPkgs.add(pkg);
            }
          }

          for (const dep of declaredDeps) {
            if (!importedPkgs.has(dep)) {
              unusedViolations.push({ pkgJsonPath: pkgPath, depName: dep });
            }
          }
        }
      }
    }

    // Output results
    let exitCode = 0;

    if (violations.length > 0) {
      for (const v of violations) {
        const relPkg = path.relative(REPO_ROOT, v.pkgJsonPath);
        const relSrc = path.relative(REPO_ROOT, v.sourceFile);
        process.stderr.write(
          `MISSING DEP  ${relPkg} ← "${v.depName}"\n` +
            `  used in ${relSrc}:${v.line}\n`
        );
      }
      exitCode = 1;
    }

    if (unusedViolations.length > 0) {
      for (const u of unusedViolations) {
        const relPkg = path.relative(REPO_ROOT, u.pkgJsonPath);
        process.stderr.write(
          `UNUSED DEP   ${relPkg} declares "${u.depName}" — not imported by any file in this package\n`
        );
      }
      exitCode = 1;
    }

    const totalFiles = Array.from(byPkg.values()).reduce(
      (n, g) => n + g.files.length,
      0
    );
    const pkgCount = byPkg.size;

    if (exitCode === 0) {
      process.stdout.write(
        `Cross-module dep lint: OK — ${totalFiles} source files across ${pkgCount} packages, 0 violations\n`
      );
    }

    process.exit(exitCode);
  } catch (err) {
    process.stderr.write(`Cross-module dep lint internal error: ${String(err)}\n`);
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Cross-module dep lint fatal: ${String(err)}\n`);
  process.exit(2);
});
