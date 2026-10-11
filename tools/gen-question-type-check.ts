/**
 * tools/gen-question-type-check.ts
 *
 * Generates the migration that (re)creates both question-type CHECK constraints
 * from QUESTION_TYPES (packages/question-types, RW-54b).
 *
 *   tsx tools/gen-question-type-check.ts          write next-numbered migration if the
 *                                                 newest generated one is out of date
 *   tsx tools/gen-question-type-check.ts --check  exit 1 if the newest generated
 *                                                 migration differs from the registry
 *   tsx tools/gen-question-type-check.ts --self-test  check the id validator
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_TYPES } from "../packages/question-types/src/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QB_DIR = join(ROOT, "modules", "04-question-bank", "migrations");
const SUFFIX = "_question_type_check_generated.sql";

// Constraint names and tables found in migrations 0012/0129/0144/0152/0156.
const CONSTRAINTS = [
  { table: "questions", name: "questions_type_check" },
  { table: "question_versions", name: "question_versions_type_check" },
] as const;

const ID_RE = /^[a-z][a-z0-9_]*$/;

/** Returns the first id that is unsafe to inline into SQL, or undefined. */
export function findBadId(ids: readonly string[]): string | undefined {
  return ids.find((t) => !ID_RE.test(t));
}

export function generateSql(): string {
  const bad = findBadId(QUESTION_TYPES);
  if (bad !== undefined) {
    console.error(`invalid question type id: ${JSON.stringify(bad)} (must match ${ID_RE})`);
    process.exit(1);
  }
  const list = QUESTION_TYPES.map((t) => `'${t}'`).join(",");
  const header = `-- GENERATED from packages/question-types. Do not edit by hand. Regenerate with pnpm gen:question-type-check.
--
-- Recreates the question-type CHECK constraints so they equal QUESTION_TYPES
-- (${QUESTION_TYPES.length} types). Safe for the current registry: the nine values equal those in migrations 0152 and 0156.
-- If a type is removed, rows that use it must be migrated first.
`;
  const body = CONSTRAINTS.map(
    (c) => `
ALTER TABLE ${c.table} DROP CONSTRAINT IF EXISTS ${c.name};
ALTER TABLE ${c.table} ADD CONSTRAINT ${c.name}
  CHECK (type IN (${list}));
`,
  ).join("");
  return header + body;
}

function allMigrationNumbers(): number[] {
  const out: number[] = [];
  for (const m of readdirSync(join(ROOT, "modules"), { withFileTypes: true })) {
    const dir = join(ROOT, "modules", m.name, "migrations");
    if (!m.isDirectory() || !existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/^\d{4}_/.test(f)) out.push(parseInt(f.slice(0, 4), 10));
  }
  return out;
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    if (findBadId(["mcq", "x'); drop"]) !== "x'); drop" || findBadId(["mcq", "log_analysis"]) !== undefined) {
      console.error("self-test FAILED");
      process.exit(1);
    }
    return console.log("self-test ok");
  }
  const generated = readdirSync(QB_DIR).filter((f) => f.endsWith(SUFFIX)).sort();
  const latest = generated[generated.length - 1];
  const want = generateSql();
  const upToDate = latest !== undefined && readFileSync(join(QB_DIR, latest), "utf8").replace(/\r\n/g, "\n") === want;
  if (process.argv.includes("--check")) {
    if (upToDate) return console.log(`question-type CHECK migration up to date (${latest})`);
    console.error(`${latest ?? "(none)"} differs from QUESTION_TYPES. Run: pnpm gen:question-type-check`);
    process.exit(1);
  }
  if (upToDate) return console.log(`already up to date: ${latest}`);
  const file = `${String(Math.max(...allMigrationNumbers()) + 1).padStart(4, "0")}${SUFFIX}`;
  const tmp = join(QB_DIR, `${file}.tmp`);
  writeFileSync(tmp, want);
  renameSync(tmp, join(QB_DIR, file)); // atomic: the final path never holds a partial file
  console.log(`wrote ${file}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
