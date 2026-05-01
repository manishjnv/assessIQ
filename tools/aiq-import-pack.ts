/**
 * tools/aiq-import-pack.ts
 *
 * Phase-1 CLI helper for bulk-importing a question pack from a JSON file into a
 * named tenant. Bridges the gap until the Phase-2 admin-UI upload widget ships
 * (module 10). Wraps `bulkImport` from @assessiq/question-bank.
 *
 * Usage:
 *   pnpm tsx tools/aiq-import-pack.ts --tenant <tenant-slug> <pack-file.json>
 *
 * BYPASSRLS usage (two narrow, pre-tenant-context lookups only):
 *   1. Tenant lookup  — resolves slug → tenant UUID via `SELECT id FROM tenants`.
 *   2. Admin lookup   — resolves "first active admin" in tenant for `created_by`
 *                       attribution (no authenticated user in CLI context).
 *   Both use a short-lived `pg.Client` on the raw DATABASE_URL (which carries
 *   the assessiq_system BYPASSRLS role in production). Neither lookup touches
 *   application data; both end before `bulkImport` starts.
 *   The actual import runs through the standard pool via `withTenant` (RLS-on).
 *
 * "First active admin" attribution rule:
 *   The CLI has no authenticated session, so `created_by` is attributed to the
 *   oldest active admin in the tenant (ORDER BY created_at ASC LIMIT 1). If the
 *   tenant has no active admin, the import is rejected with exit 1.
 *
 * Exit codes:
 *   0  success — prints ImportReport as JSON to stdout
 *   1  tenant not found, or tenant has no active admin
 *   2  file not found / unreadable
 *   3  validation error (parse, schema, content, rubric, level reference)
 *   4  conflict error (slug collision)
 *   5  unexpected error / bad arguments
 */

import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { config } from "@assessiq/core";
import { AppError } from "@assessiq/core";
import { setPoolForTesting, getPool, closePool } from "@assessiq/tenancy";
import { bulkImport } from "../modules/04-question-bank/src/service.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { tenantSlug: string; filePath: string } {
  const args = process.argv.slice(2);

  let tenantSlug: string | undefined;
  let filePath: string | undefined;
  const positionals: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--tenant") {
      if (i + 1 >= args.length) {
        process.stderr.write("Error: --tenant requires a value.\n");
        printUsage();
        process.exit(5);
      }
      tenantSlug = args[i + 1];
      i += 2;
    } else if (arg !== undefined && arg.startsWith("--")) {
      process.stderr.write(`Error: unknown flag '${arg}'.\n`);
      printUsage();
      process.exit(5);
    } else {
      if (arg !== undefined) positionals.push(arg);
      i++;
    }
  }

  if (positionals.length === 1) {
    filePath = positionals[0];
  } else if (positionals.length === 0) {
    process.stderr.write("Error: missing positional <pack-file.json>.\n");
    printUsage();
    process.exit(5);
  } else {
    process.stderr.write("Error: too many positional arguments — expected exactly one file path.\n");
    printUsage();
    process.exit(5);
  }

  if (tenantSlug === undefined) {
    process.stderr.write("Error: --tenant <slug> is required.\n");
    printUsage();
    process.exit(5);
  }

  return { tenantSlug, filePath: filePath as string };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: pnpm tsx tools/aiq-import-pack.ts --tenant <tenant-slug> <pack-file.json>\n",
  );
}

// ---------------------------------------------------------------------------
// Tenant resolution (BYPASSRLS use #1 — slug → UUID)
// ---------------------------------------------------------------------------

async function resolveTenantId(tenantSlug: string): Promise<string> {
  // Short-lived system-role client. BYPASSRLS is required here because we are
  // operating outside any tenant request context — there is no `withTenant`
  // wrapper in scope yet, and the tenants table has no tenant_id RLS column.
  const sysClient = new Client({ connectionString: config.DATABASE_URL });
  await sysClient.connect();
  try {
    const result = await sysClient.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
      [tenantSlug],
    );
    const row = result.rows[0];
    if (row === undefined) {
      process.stderr.write(`Tenant not found: ${tenantSlug}\n`);
      process.exit(1);
    }
    return row.id;
  } finally {
    await sysClient.end();
  }
}

// ---------------------------------------------------------------------------
// Admin resolution (BYPASSRLS use #2 — first active admin for attribution)
// ---------------------------------------------------------------------------

async function resolveSystemAuthor(tenantId: string, tenantSlug: string): Promise<string> {
  // Still pre-tenant-context: withTenant has not been entered yet. We use a
  // second short-lived system-role client to locate the attribution user rather
  // than leaving created_by NULL or inventing a synthetic UUID. The "first
  // active admin" rule is documented in the module-level header above.
  const sysClient = new Client({ connectionString: config.DATABASE_URL });
  await sysClient.connect();
  try {
    const result = await sysClient.query<{ id: string }>(
      `SELECT id FROM users
        WHERE tenant_id = $1
          AND role = 'admin'
          AND status = 'active'
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      process.stderr.write(
        `Tenant has no active admin — cannot attribute import. (tenant: ${tenantSlug})\n`,
      );
      process.exit(1);
    }
    return row.id;
  } finally {
    await sysClient.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { tenantSlug, filePath } = parseArgs();

  // Read the file — map ENOENT / unreadable to exit 2
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(filePath);
  } catch {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exit(2);
  }

  // Resolve tenant (BYPASSRLS #1)
  const tenantId = await resolveTenantId(tenantSlug);

  // Resolve system author (BYPASSRLS #2)
  const createdBy = await resolveSystemAuthor(tenantId, tenantSlug);

  // Run the import through the standard pool (RLS active inside withTenant)
  try {
    const report = await bulkImport(tenantId, fileBuffer, "json", createdBy);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (err: unknown) {
    if (err instanceof AppError) {
      const code = (err as AppError & { details?: { code?: string } }).details?.code ?? err.code;
      switch (code) {
        case "PACK_SLUG_EXISTS":
          process.stderr.write(
            `A pack with slug '${(err as AppError & { details?: { slug?: string } }).details?.slug ?? "?"}' already exists in tenant ${tenantSlug}\n`,
          );
          process.exit(4);
          break;
        case "IMPORT_VALIDATION_FAILED":
          process.stderr.write(`Validation failed: ${err.message}\n`);
          process.exit(3);
          break;
        case "INVALID_CONTENT":
          process.stderr.write(`Question content invalid: ${err.message}\n`);
          process.exit(3);
          break;
        case "RUBRIC_REQUIRED":
        case "RUBRIC_NOT_ALLOWED":
        case "INVALID_RUBRIC":
          process.stderr.write(`Rubric error: ${err.message}\n`);
          process.exit(3);
          break;
        case "IMPORT_LEVEL_REF_INVALID":
          process.stderr.write(`Level reference invalid: ${err.message}\n`);
          process.exit(3);
          break;
        default:
          process.stderr.write(`Unexpected error: ${err.message}\n`);
          process.exit(5);
      }
    } else {
      process.stderr.write(
        `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(5);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(5);
}).finally(async () => {
  await closePool().catch(() => {
    // best-effort; ignore close errors on exit
  });
});
