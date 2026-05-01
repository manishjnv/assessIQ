/**
 * tools/lint-rls-policies.ts
 *
 * RLS policy linter for AssessIQ.
 *
 * Scans all migrations/*.sql files (glob: **\/migrations\/*.sql) and enforces:
 *
 *   1. STANDARD VARIANT — every CREATE TABLE that contains a `tenant_id` column
 *      MUST be accompanied by BOTH `CREATE POLICY tenant_isolation` AND
 *      `CREATE POLICY tenant_isolation_insert` in the same file.
 *
 *   2. JOIN-BASED VARIANT — child tables without their own `tenant_id` column
 *      that derive tenancy through a parent FK (e.g. `levels.pack_id`,
 *      `questions.pack_id`, `question_versions.question_id`,
 *      `question_tags.question_id`). These are listed explicitly in
 *      JOIN_RLS_TABLES below. They MUST have both `tenant_isolation` and
 *      `tenant_isolation_insert` policies, AND those policies MUST contain
 *      an EXISTS sub-select that references `current_setting('app.current_tenant'`
 *      (so tenancy is genuinely enforced at the DB layer rather than the policy
 *      being a no-op `USING (true)`).
 *
 *   3. TENANTS SPECIAL CASE — the `tenants` table itself uses its own `id`
 *      column as the tenant discriminator; any `CREATE POLICY tenant_isolation`
 *      in that file is accepted regardless of which column it references.
 *      tenant_isolation_insert is not required for the tenants table itself.
 *
 * If a migration file ships a CREATE TABLE for a table that is neither a
 * tenant_id-bearing table NOR in the explicit JOIN_RLS_TABLES list, the linter
 * leaves it alone (e.g. junction tables that are intentionally global, or
 * helper tables added by Phase 2+ work — those need to be added to one of
 * the above categories before the linter starts protecting them).
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

/**
 * Tables that MUST have JOIN-based RLS even though they carry no `tenant_id`
 * column directly. Tenancy derives through a parent FK chain.
 *
 * Add a table to this list when:
 *   - it has a foreign key to a tenant-bearing parent (directly or transitively)
 *   - it should be subject to tenant isolation
 *   - and the migration uses `CREATE POLICY tenant_isolation ON <table>` with an
 *     EXISTS sub-select referencing current_setting('app.current_tenant', ...).
 *
 * The linter rejects a migration that creates any of these tables without both
 * policies present and at least one EXISTS clause referencing the GUC.
 */
const JOIN_RLS_TABLES: ReadonlySet<string> = new Set([
  // Phase 1 G1.A — modules/04-question-bank
  "levels",                // pack_id → question_packs.tenant_id
  "questions",             // pack_id → question_packs.tenant_id
  "question_versions",     // question_id → questions.pack_id → question_packs.tenant_id
  "question_tags",         // question_id → questions.pack_id → question_packs.tenant_id
  // Phase 1 G1.C — modules/06-attempt-engine (forward-declared so the lint
  // gate is in place when those migrations land; until they exist this
  // entry is inert).
  "attempt_questions",
  "attempt_answers",
  "attempt_events",
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
  missing: (
    | "tenant_isolation"
    | "tenant_isolation_insert"
    | "exists_clause_with_current_setting"
  )[];
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

  // Check what policies exist in this file (case-insensitive substring matches).
  // Both standard and JOIN-based variants name the policies identically; the
  // body differs (direct `tenant_id =` predicate vs `EXISTS (...)`). The
  // EXISTS check below distinguishes them.
  const hasIsolation = lower.includes("create policy tenant_isolation");
  const hasInsert = lower.includes("create policy tenant_isolation_insert");

  // For the JOIN-based variant we additionally require that at least one
  // EXISTS sub-select in the file references `current_setting('app.current_tenant'`
  // so the policy isn't a no-op (e.g. `USING (true)` would smuggle through
  // the name check).
  const hasExistsCurrentSetting =
    /exists\s*\([\s\S]*?current_setting\s*\(\s*'app\.current_tenant'/i.test(
      content,
    );

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
    const hasTenantIdColumn = columnBody.includes("tenant_id");

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

    // JOIN-based variant — child table that derives tenancy through a parent FK.
    // The table itself has NO tenant_id column. Require both policies AND an
    // EXISTS clause that references the app.current_tenant GUC.
    if (JOIN_RLS_TABLES.has(rawTableName)) {
      const missing: Violation["missing"] = [];
      if (!hasIsolation) missing.push("tenant_isolation");
      if (!hasInsert) missing.push("tenant_isolation_insert");
      if ((hasIsolation || hasInsert) && !hasExistsCurrentSetting) {
        // Policies are named correctly but their body is suspicious — no
        // EXISTS-with-current_setting means the policy is structurally unable
        // to enforce tenancy through the FK chain. Reject as if missing.
        missing.push("exists_clause_with_current_setting");
      }
      if (missing.length > 0) {
        violations.push({
          file: filePath,
          tableName: rawTableName,
          missing,
        });
      }
      continue;
    }

    // Standard variant — table has its own tenant_id column. Require both policies.
    if (hasTenantIdColumn) {
      const missing: Violation["missing"] = [];
      if (!hasIsolation) missing.push("tenant_isolation");
      if (!hasInsert) missing.push("tenant_isolation_insert");
      if (missing.length > 0) {
        violations.push({ file: filePath, tableName: rawTableName, missing });
      }
      continue;
    }

    // Table has no tenant_id column AND is not in JOIN_RLS_TABLES — leave
    // alone. (Junction tables not yet onboarded, helper tables, etc.)
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

  // --- Fixture 4: valid JOIN-based migration (child table, no tenant_id) ---
  const validJoinSql = `
CREATE TABLE public.levels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id   uuid NOT NULL REFERENCES question_packs(id) ON DELETE CASCADE,
  position  int NOT NULL,
  label     text NOT NULL
);

ALTER TABLE public.levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.levels
  USING (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON public.levels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM question_packs p
      WHERE p.id = levels.pack_id
        AND p.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
`;

  // --- Fixture 5: child table missing RLS entirely ---
  const childMissingRlsSql = `
CREATE TABLE public.levels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id   uuid NOT NULL REFERENCES question_packs(id),
  position  int NOT NULL
);
`;

  // --- Fixture 6: child table policies named correctly but body is a no-op ---
  const childNoOpPolicySql = `
CREATE TABLE public.questions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id  uuid NOT NULL REFERENCES question_packs(id),
  topic    text NOT NULL
);

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.questions
  USING (true);

CREATE POLICY tenant_isolation_insert ON public.questions
  FOR INSERT
  WITH CHECK (true);
`;

  const v1 = validateSqlContent("<fixture:valid>", validSql);
  const v2 = validateSqlContent("<fixture:invalid>", invalidSql);
  const v3 = validateSqlContent("<fixture:tenants>", tenantsSql);
  const v4 = validateSqlContent("<fixture:join-valid>", validJoinSql);
  const v5 = validateSqlContent("<fixture:child-missing-rls>", childMissingRlsSql);
  const v6 = validateSqlContent("<fixture:child-noop-policy>", childNoOpPolicySql);

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

  if (v4.length !== 0) {
    process.stderr.write(
      `FAIL: JOIN-valid fixture should have 0 violations, got ${JSON.stringify(v4)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: JOIN-based valid fixture — 0 violations (expected)\n"
    );
  }

  if (
    v5.length !== 1 ||
    !v5[0]!.missing.includes("tenant_isolation") ||
    !v5[0]!.missing.includes("tenant_isolation_insert")
  ) {
    process.stderr.write(
      `FAIL: child-missing-rls fixture should have 1 violation (both policies missing on \`levels\`), got ${JSON.stringify(v5)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: child-missing-rls fixture — both policies missing on `levels` (expected)\n"
    );
  }

  if (
    v6.length !== 1 ||
    !v6[0]!.missing.includes("exists_clause_with_current_setting")
  ) {
    process.stderr.write(
      `FAIL: child-noop-policy fixture should flag exists_clause_with_current_setting on \`questions\`, got ${JSON.stringify(v6)}\n`
    );
    passed = false;
  } else {
    process.stdout.write(
      "  PASS: child-noop-policy fixture — exists_clause_with_current_setting flagged (expected)\n"
    );
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
  let joinBasedTables = 0;

  for (const file of files) {
    const content = await fsp.readFile(file, "utf8");
    const violations = validateSqlContent(file, content);
    allViolations.push(...violations);

    // Count tenant-bearing and JOIN-based tables across all files
    const createTableRe =
      /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:"?[\w]+"?\."?)?("?)([\w]+)\1\s*\(([\s\S]*?)\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createTableRe.exec(content)) !== null) {
      const name = m[2]!.toLowerCase();
      if (m[3]!.toLowerCase().includes("tenant_id")) {
        tenantBearingTables++;
      } else if (JOIN_RLS_TABLES.has(name)) {
        joinBasedTables++;
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
    `RLS policy linter: OK (${files.length} migration files scanned, ${tenantBearingTables} tenant-bearing tables + ${joinBasedTables} JOIN-based child tables matched policies)\n`
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`RLS policy linter error: ${String(err)}\n`);
  process.exit(1);
});
