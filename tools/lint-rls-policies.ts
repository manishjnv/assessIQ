/**
 * tools/lint-rls-policies.ts
 *
 * RLS policy linter for AssessIQ.
 *
 * Scans all migrations/*.sql files (glob: **\/migrations\/*.sql) and rejects any CREATE TABLE that:
 *   - contains a `tenant_id` column
 *   - without BOTH `CREATE POLICY tenant_isolation` AND
 *     `CREATE POLICY tenant_isolation_insert` in the same file.
 *
 * Special case: the `tenants` table itself uses its own `id` column as the
 * tenant discriminator; any `CREATE POLICY tenant_isolation` in that file
 * is accepted regardless of which column it references.
 *
 * Usage:
 *   pnpm tsx tools/lint-rls-policies.ts            # scan repo
 *   pnpm tsx tools/lint-rls-policies.ts --self-test # CI self-validation
 */

import { type Dirent } from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "AccessIQ_UI_Template",
]);

/** Recursively collect files whose path matches the migration glob pattern. */
async function findMigrationFiles(dir: string): Promise<string[]> {
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
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".sql") &&
        path.basename(path.dirname(full)) === "migrations"
      ) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  tableName: string;
  missing: ("tenant_isolation" | "tenant_isolation_insert")[];
}

// ---------------------------------------------------------------------------
// Core validator — operates on a file path + its content string
// ---------------------------------------------------------------------------

function validateSqlContent(
  filePath: string,
  content: string
): Violation[] {
  const lower = content.toLowerCase();
  const violations: Violation[] = [];

  // Check what policies exist in this file (case-insensitive)
  const hasIsolation = lower.includes("create policy tenant_isolation");
  const hasInsert = lower.includes("create policy tenant_isolation_insert");

  // Find every CREATE TABLE block.
  // Regex captures: (1) optional schema-qualified table name, (2) column body
  const createTableRe =
    /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:"?[\w]+"?\."?)?("?)([\w]+)\1\s*\(([\s\S]*?)\);/gi;

  let match: RegExpExecArray | null;
  while ((match = createTableRe.exec(content)) !== null) {
    // Capture groups [2] (table name) and [3] (column body) are guaranteed
    // non-undefined when the regex matches; assert to satisfy
    // noUncheckedIndexedAccess.
    const rawTableName = match[2]!.toLowerCase();
    const columnBody = match[3]!.toLowerCase();

    // Only care about tables that have a tenant_id column
    if (!columnBody.includes("tenant_id")) continue;

    // Special case: `tenants` table — id IS the tenant discriminator.
    // Accept as long as there is at least one `create policy tenant_isolation` anywhere.
    if (rawTableName === "tenants") {
      if (!hasIsolation) {
        violations.push({
          file: filePath,
          tableName: rawTableName,
          missing: ["tenant_isolation"],
        });
      }
      // tenant_isolation_insert is not required for the tenants table itself.
      continue;
    }

    // Normal table: require both policies
    const missing: ("tenant_isolation" | "tenant_isolation_insert")[] = [];
    if (!hasIsolation) missing.push("tenant_isolation");
    if (!hasInsert) missing.push("tenant_isolation_insert");

    if (missing.length > 0) {
      violations.push({ file: filePath, tableName: rawTableName, missing });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Self-test mode
// ---------------------------------------------------------------------------

function runSelfTest(): void {
  process.stdout.write("RLS policy linter — running self-test...\n");

  // --- Fixture 1: valid migration with both policies ---
  const validSql = `
CREATE TABLE public.assessments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  title        text NOT NULL
);

ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.assessments
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation_insert
  ON public.assessments
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
`;

  // --- Fixture 2: invalid migration — missing insert policy ---
  const invalidSql = `
CREATE TABLE public.submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  data         jsonb
);

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.submissions
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
`;

  // --- Fixture 3: tenants table itself (special case) ---
  const tenantsSql = `
CREATE TABLE public.tenants (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug  text NOT NULL UNIQUE
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.tenants
  FOR SELECT
  USING (id = current_setting('app.current_tenant')::uuid);
`;

  const v1 = validateSqlContent("<fixture:valid>", validSql);
  const v2 = validateSqlContent("<fixture:invalid>", invalidSql);
  const v3 = validateSqlContent("<fixture:tenants>", tenantsSql);

  let passed = true;

  if (v1.length !== 0) {
    process.stderr.write(
      `FAIL: valid fixture should have 0 violations, got ${v1.length}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS: valid fixture — 0 violations (expected)\n");
  }

  if (v2.length !== 1 || !v2[0]!.missing.includes("tenant_isolation_insert")) {
    process.stderr.write(
      `FAIL: invalid fixture should have 1 violation (missing tenant_isolation_insert), got ${JSON.stringify(v2)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: invalid fixture — 1 violation missing tenant_isolation_insert (expected)\n"
    );
  }

  if (v3.length !== 0) {
    process.stderr.write(
      `FAIL: tenants-table fixture should have 0 violations, got ${v3.length}\n`
    );
    passed = false;
  } else {
    process.stdout.write("  PASS: tenants-table fixture — 0 violations (expected)\n");
  }

  if (passed) {
    process.stdout.write("RLS policy linter self-test: PASSED\n");
    process.exit(0);
  } else {
    process.stderr.write("RLS policy linter self-test: FAILED\n");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return; // runSelfTest calls process.exit, but keep TS happy
  }

  const files = await findMigrationFiles(REPO_ROOT);
  const allViolations: Violation[] = [];
  let tenantBearingTables = 0;

  for (const file of files) {
    const content = await fsp.readFile(file, "utf8");
    const violations = validateSqlContent(file, content);
    allViolations.push(...violations);

    // Count tenant-bearing tables across all files
    const createTableRe =
      /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:"?[\w]+"?\."?)?("?)([\w]+)\1\s*\(([\s\S]*?)\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createTableRe.exec(content)) !== null) {
      if (m[3]!.toLowerCase().includes("tenant_id")) {
        tenantBearingTables++;
      }
    }
  }

  if (allViolations.length > 0) {
    for (const v of allViolations) {
      const rel = path.relative(REPO_ROOT, v.file);
      process.stderr.write(
        `${rel}:${v.tableName} — missing ${v.missing.join(", ")} policy\n`
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `RLS policy linter: OK (${files.length} migration files scanned, ${tenantBearingTables} tenant-bearing tables matched policies)\n`
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`RLS policy linter error: ${String(err)}\n`);
  process.exit(1);
});
