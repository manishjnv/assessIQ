/**
 * tools/migrate.ts
 *
 * Idempotent migration runner for AssessIQ.
 *
 * Discovers all `modules/*\/migrations/*.sql` files, applies pending ones in
 * lexical order by basename, and records each application in `schema_migrations`
 * with a sha256 checksum so re-runs are no-ops and accidental edits to applied
 * migrations are caught at apply time.
 *
 * Usage:
 *   pnpm tsx tools/migrate.ts                  # apply pending
 *   pnpm tsx tools/migrate.ts --dry-run        # list pending without applying
 *   pnpm tsx tools/migrate.ts --force-rerun X  # re-apply X even if checksum mismatches
 *
 * Environment: DATABASE_URL must be set. Connects as the URL's role; the role
 * must have CREATE TABLE permission on the public schema. In production deploy,
 * this is the postgres superuser (NOT assessiq_app — RLS would block the
 * schema_migrations write under the application role since that table has no
 * tenant_id by design — it's infrastructure, not domain).
 *
 * Cross-module ordering note: 02-tenancy uses 0001-0003 (4-digit); 01-auth uses
 * 010-015 (3-digit). Lexical sort by basename gives:
 *   0001_tenants.sql < 0002_rls_helpers.sql < 0003_tenants_rls.sql
 *   < 010_oauth_identities.sql < 011_sessions.sql < 012_totp.sql
 *   < 013_recovery_codes.sql < 014_embed_secrets.sql < 015_api_keys.sql
 * which is the correct dependency order (auth tables FK to tenants).
 */

import * as crypto from "node:crypto";
import { type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, type WriteStream, createWriteStream } from "node:fs";
import { Client } from "pg";

/**
 * Self-contained JSONL logger for migrate.ts.
 *
 * Why not import @assessiq/core's streamLogger here?
 *   - tools/ is outside the pnpm workspace; relative imports work but pull in
 *     the eager `config = loadConfig()` singleton which requires DB/secret env
 *     vars even for `--dry-run`. That's wrong for a CLI tool that legitimately
 *     runs with no env to list pending migrations.
 *
 * Schema matches streamLogger output (level/time/msg/stream/pid + fields).
 * See docs/11-observability.md § Streams & paths.
 */

const LEVEL_NUMBERS: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

let _migrationFile: WriteStream | undefined;
function getMigrationFile(): WriteStream | undefined {
  if (_migrationFile !== undefined) return _migrationFile;
  const dir = process.env["LOG_DIR"];
  if (dir === undefined || dir.length === 0) return undefined;
  mkdirSync(dir, { recursive: true });
  _migrationFile = createWriteStream(`${dir}/migration.log`, { flags: "a" });
  return _migrationFile;
}

function emit(level: keyof typeof LEVEL_NUMBERS, msgOrFields: string | Record<string, unknown>, msg?: string): void {
  const isObj = typeof msgOrFields === "object";
  const fields = isObj ? msgOrFields : {};
  const message = isObj ? (msg ?? "") : msgOrFields;
  const line = JSON.stringify({
    level: LEVEL_NUMBERS[level],
    time: new Date().toISOString(),
    pid: process.pid,
    stream: "migration",
    ...fields,
    msg: message,
  }) + "\n";
  process.stdout.write(line);
  const file = getMigrationFile();
  if (file !== undefined) file.write(line);
  // error.log mirror — only when LOG_DIR is set and level >= error
  if (LEVEL_NUMBERS[level] >= 50) {
    const dir = process.env["LOG_DIR"];
    if (dir !== undefined && dir.length > 0) {
      try { appendFileSync(`${dir}/error.log`, line); } catch { /* best effort */ }
    }
  }
}

const log = {
  info: (a: string | Record<string, unknown>, b?: string) => emit("info", a, b),
  warn: (a: string | Record<string, unknown>, b?: string) => emit("warn", a, b),
  error: (a: string | Record<string, unknown>, b?: string) => emit("error", a, b),
  fatal: (a: string | Record<string, unknown>, b?: string) => emit("fatal", a, b),
};

// ---------------------------------------------------------------------------
// Paths
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

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// File discovery — modules/<name>/migrations/*.sql only
// ---------------------------------------------------------------------------

async function findMigrationFiles(): Promise<string[]> {
  const results: string[] = [];

  // Only descend one level into modules/* before looking for migrations/
  let moduleDirs: Dirent[];
  const modulesRoot = path.join(REPO_ROOT, "modules");
  try {
    moduleDirs = await fsp.readdir(modulesRoot, { withFileTypes: true });
  } catch {
    // modules/ directory unreadable or absent — nothing to migrate
    return results;
  }

  for (const moduleEntry of moduleDirs) {
    if (!moduleEntry.isDirectory()) continue;
    if (SKIP_DIRS.has(moduleEntry.name)) continue;

    const migrationsDir = path.join(modulesRoot, moduleEntry.name, "migrations");

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(migrationsDir, { withFileTypes: true });
    } catch {
      // No migrations/ directory (or unreadable) — fine, skip silently
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sql")) {
        results.push(path.join(migrationsDir, entry.name));
      }
    }
  }

  // Sort lexically by basename — this is the load-bearing ordering contract.
  // "0001_tenants.sql" < "010_oauth_identities.sql" in lexical order because
  // '0' === '0', '0' === '1'? No — "0001" vs "010": '0'='0', '0'='1'? No,
  // '0' < '1', so "0001…" < "010…". Correct dependency order.
  results.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  return results;
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Applied-migration record from the tracking table
// ---------------------------------------------------------------------------

interface AppliedMigration {
  version: string;
  applied_at: string;
  checksum: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");

  const forceRerunIdx = args.indexOf("--force-rerun");
  const forceRerunBasename: string | null =
    forceRerunIdx !== -1 ? (args[forceRerunIdx + 1] ?? null) : null;

  if (forceRerunIdx !== -1 && forceRerunBasename === null) {
    log.error("--force-rerun requires a basename argument, e.g. --force-rerun 010_oauth_identities.sql");
    process.exit(1);
  }

  // Discover all migration files
  const files = await findMigrationFiles();

  if (files.length === 0) {
    log.info("no migration files found under modules/*/migrations/");
    process.exit(0);
  }

  // In dry-run mode we can list files without a DB connection
  if (isDryRun) {
    log.info({ count: files.length }, "dry-run: listing pending migrations (no DB connection)");
    for (const f of files) {
      const basename = path.basename(f);
      log.info({ file: basename, action: "list" }, "migration.list");
    }
    log.info("dry-run complete (pass/fail status requires a live DATABASE_URL)");
    process.exit(0);
  }

  // Validate DATABASE_URL
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    log.error(
      "DATABASE_URL environment variable is not set. Set it to a Postgres connection string, e.g. " +
        "DATABASE_URL=postgres://user:pass@host:5432/dbname pnpm tsx tools/migrate.ts",
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
  } catch (err) {
    log.error({ err }, "could not connect to Postgres");
    process.exit(1);
  }

  try {
    // Ensure tracking table exists
    await client.query(SCHEMA_MIGRATIONS_DDL);

    // Load all already-applied migrations
    const { rows } = await client.query<AppliedMigration>(
      "SELECT version, applied_at::text AS applied_at, checksum FROM schema_migrations",
    );
    const applied = new Map<string, AppliedMigration>(rows.map((r) => [r.version, r]));

    let pendingCount = 0;
    let appliedCount = 0;
    let skippedCount = 0;

    for (const filePath of files) {
      const basename = path.basename(filePath);
      const content = await fsp.readFile(filePath, "utf8");
      const currentChecksum = sha256(content);

      const existing = applied.get(basename);

      if (existing !== undefined) {
        // Already applied — check for drift
        if (existing.checksum !== currentChecksum && basename !== forceRerunBasename) {
          log.error(
            {
              file: basename,
              applied_at: existing.applied_at,
              applied_checksum: existing.checksum,
              current_checksum: currentChecksum,
            },
            "migration.drift",
          );
          process.exit(1);
        }

        if (existing.checksum === currentChecksum) {
          // Clean skip
          log.info(
            { file: basename, applied_at: existing.applied_at, action: "skip" },
            "migration.skip",
          );
          skippedCount++;
          continue;
        }

        // force-rerun path: checksum mismatches but user asked for it
        log.warn(
          { file: basename, action: "force-rerun" },
          "migration.force-rerun",
        );

        const start = Date.now();
        await client.query("BEGIN");
        try {
          await client.query(content);
          await client.query(
            "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) " +
              "ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()",
            [basename, currentChecksum],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {
            // ignore rollback error; surface the original
          });
          throw err;
        }

        log.info(
          {
            file: basename,
            sha256: currentChecksum,
            durationMs: Date.now() - start,
            action: "force-rerun",
          },
          "migration.applied",
        );
        appliedCount++;
        continue;
      }

      // New (pending) migration
      log.info({ file: basename, action: "apply" }, "migration.apply");
      pendingCount++;

      const start = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(content);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [basename, currentChecksum],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {
          // ignore rollback error; surface the original
        });
        log.error({ err, file: basename }, "migration.failed");
        process.exit(1);
      }

      log.info(
        {
          file: basename,
          sha256: currentChecksum,
          durationMs: Date.now() - start,
          action: "apply",
        },
        "migration.applied",
      );
      appliedCount++;
    }

    const total = pendingCount + appliedCount + skippedCount;
    log.info(
      { applied: appliedCount, skipped: skippedCount, total },
      "migrate.done",
    );
  } finally {
    await client.end().catch(() => {
      // best-effort disconnect
    });
  }

  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err }, "migrate.fatal");
  process.exit(1);
});
