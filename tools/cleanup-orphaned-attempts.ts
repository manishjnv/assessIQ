/**
 * tools/cleanup-orphaned-attempts.ts
 *
 * Mark 'running' generation_attempts rows older than N minutes as 'failed'
 * with error_code='ORPHANED'.
 *
 * SECURITY NOTE: This script uses `SET LOCAL ROLE assessiq_system` inside a
 * transaction to bypass row-level security (RLS). The assessiq_system role
 * holds BYPASSRLS privilege and is a NOLOGIN role — it can only be activated
 * via `SET LOCAL ROLE` within an existing transaction; it cannot be used to
 * open a direct DB connection. The elevated privilege is scoped to the
 * transaction duration only (LOCAL semantics) and reverts automatically on
 * COMMIT or ROLLBACK. This is a cross-tenant ops sweep: no authenticated
 * request context exists; the system role is the correct and intentional
 * mechanism. Run only from trusted operator shell access (VPS SSH / docker exec).
 *
 * Background: The try/finally finalize block in handleAdminGenerate (commit
 * f449203) closes the common success/failure path. However, two attempt rows
 * have already orphaned in production (019e0b0a + an earlier one at 04:41 the
 * prior day) — likely from container SIGTERM racing the finalize block. Until
 * the race condition is root-caused, this sweep keeps the table clean.
 *
 * Usage (requires tsx, run from inside the api container or with DATABASE_URL set):
 *   pnpm exec tsx tools/cleanup-orphaned-attempts.ts [options]
 *
 * Args:
 *   --older-than-minutes <int>  default 30   — threshold in minutes for 'running'
 *   --apply                     default false — write changes (omit for dry-run)
 *   --quiet                     default false — suppress row table; still prints summary
 *
 * Exit codes:
 *   0  success (dry-run or apply)
 *   1  partial failure (reserved — currently unused)
 *   2  usage error / DATABASE_URL missing / DB connect failure
 */

/* eslint-disable no-console */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanedAttemptRow {
  id: string;
  pack_id: string;
  level_id: string;
  count_requested: number;
  started_at: Date;
  age_min: number | string; // EXTRACT returns numeric; pg may return as number or string
}

/** Minimal pg-client interface accepted by the query functions. */
export interface MinimalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = Record<string, any>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Core query functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * SELECT generation_attempts rows with status='running' older than
 * olderThanMinutes minutes.
 * Uses the client as-is; caller is responsible for SET LOCAL ROLE.
 */
export async function findOrphanedAttempts(
  client: MinimalClient,
  olderThanMinutes: number,
): Promise<OrphanedAttemptRow[]> {
  const res = await client.query<OrphanedAttemptRow>(
    `SELECT id, pack_id, level_id, count_requested, started_at,
            EXTRACT(EPOCH FROM (now() - started_at)) / 60 AS age_min
       FROM generation_attempts
      WHERE status = 'running'
        AND started_at < now() - ($1 * INTERVAL '1 minute')
      ORDER BY started_at ASC`,
    [olderThanMinutes],
  );
  return res.rows;
}

/**
 * UPDATE generation_attempts SET status='failed', error_code='ORPHANED', ...
 * for all ids in the given list. Returns the list of ids actually updated.
 * Idempotent: if a row was already cleaned up, it simply won't match.
 */
export async function markAttemptsOrphaned(
  client: MinimalClient,
  ids: string[],
  olderThanMinutes: number,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const message =
    `Marked failed by cleanup-orphaned-attempts after ${olderThanMinutes} min idle`;
  const res = await client.query<{ id: string }>(
    `UPDATE generation_attempts
        SET status        = 'failed',
            error_code    = 'ORPHANED',
            error_message = $2,
            finished_at   = now()
      WHERE id = ANY($1)
      RETURNING id`,
    [ids, message],
  );
  return res.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function printTable(rows: OrphanedAttemptRow[]): void {
  const header = `${"id".padEnd(36)}  ${"pack_id".padEnd(36)}  ${"level_id".padEnd(36)}  cnt  age_min`;
  const sep = "-".repeat(header.length);
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const ageMin =
      typeof row.age_min === "string" ? parseFloat(row.age_min) : row.age_min;
    console.log(
      `${row.id.padEnd(36)}  ${row.pack_id.padEnd(36)}  ${row.level_id.padEnd(36)}  ` +
        `${String(row.count_requested).padEnd(4)} ${ageMin.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseCLIArgs(): {
  olderThanMinutes: number;
  apply: boolean;
  quiet: boolean;
} {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "older-than-minutes": { type: "string", default: "30" },
        apply: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(
      `Usage error: ${err instanceof Error ? err.message : String(err)}\n` +
        "Usage: cleanup-orphaned-attempts.ts [--older-than-minutes <int>] [--apply] [--quiet]\n",
    );
    process.exit(2);
  }

  const olderThanMinutes = parseInt(values["older-than-minutes"] as string, 10);
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 1) {
    process.stderr.write("Error: --older-than-minutes must be a positive integer.\n");
    process.exit(2);
  }

  return {
    olderThanMinutes,
    apply: values["apply"] as boolean,
    quiet: values["quiet"] as boolean,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { olderThanMinutes, apply, quiet } = parseCLIArgs();

  // DATABASE_URL guard: @assessiq/tenancy → @assessiq/core validates all env
  // vars eagerly at import time. Guard before importing to avoid a confusing
  // Zod validation error when the variable is simply absent.
  if (!process.env["DATABASE_URL"]) {
    process.stderr.write(
      "DATABASE_URL not set — run from inside the api container or " +
        "export DATABASE_URL pointing at VPS postgres.\n",
    );
    process.exit(2);
  }

  // Dynamic import deferred past the DATABASE_URL guard.
  const { getPool, closePool } = await import("@assessiq/tenancy");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const rows = await findOrphanedAttempts(
      client as unknown as MinimalClient,
      olderThanMinutes,
    );

    if (!quiet) {
      console.log(
        `Found ${rows.length} orphaned running attempt${rows.length === 1 ? "" : "s"} ` +
          `older than ${olderThanMinutes} minute${olderThanMinutes === 1 ? "" : "s"}.`,
      );
    }
    console.log(`Affected: ${rows.length}`);

    if (!apply) {
      if (!quiet && rows.length > 0) {
        printTable(rows);
      }
      console.log("Run with --apply to mark failed.");
      await client.query("ROLLBACK");
      return;
    }

    if (rows.length === 0) {
      await client.query("COMMIT");
      console.log("Marked 0 attempts failed. Done.");
      return;
    }

    const ids = rows.map((r) => r.id);
    const updatedIds = await markAttemptsOrphaned(
      client as unknown as MinimalClient,
      ids,
      olderThanMinutes,
    );
    await client.query("COMMIT");
    console.log(`Marked ${updatedIds.length} attempt${updatedIds.length === 1 ? "" : "s"} failed (ORPHANED). Done.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection likely dead; swallow.
    });
    process.stderr.write(
      `DB error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  } finally {
    client.release();
    await closePool().catch(() => {
      // Best-effort pool close; do not mask prior errors.
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point — only execute when run directly (not when imported by tests)
// ---------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
}
