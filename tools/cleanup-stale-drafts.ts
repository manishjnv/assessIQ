/**
 * tools/cleanup-stale-drafts.ts
 *
 * Bulk-archive ai_draft questions older than N days.
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
 * Usage (requires tsx, run from inside the api container or with DATABASE_URL set):
 *   pnpm exec tsx tools/cleanup-stale-drafts.ts [options]
 *
 * Args:
 *   --older-than-days <int>   default 7    — archive drafts older than this many days
 *   --pack-id <uuid>          optional     — scope to a single question pack
 *   --apply                   default false — write changes (omit for dry-run)
 *   --quiet                   default false — suppress row table; still prints summary
 *
 * Exit codes:
 *   0  success (dry-run or apply)
 *   1  partial failure (reserved — currently unused; set status if UPDATE is partial)
 *   2  usage error / DATABASE_URL missing / DB connect failure
 */

/* eslint-disable no-console */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StaleDraftRow {
  id: string;
  type: string;
  topic: string;
  points: number;
  pack_id: string;
  level_id: string;
  created_at: Date;
  age_days: number | string; // EXTRACT returns numeric; pg may return as number or string
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
 * SELECT ai_draft questions older than olderThanDays days.
 * Uses the client as-is; caller is responsible for SET LOCAL ROLE.
 */
export async function findStaleDrafts(
  client: MinimalClient,
  olderThanDays: number,
  packId?: string,
): Promise<StaleDraftRow[]> {
  const params: unknown[] = [olderThanDays];
  const packFilter = packId ? `AND pack_id = $2` : "";
  if (packId) params.push(packId);

  const res = await client.query<StaleDraftRow>(
    `SELECT id, type, topic, points, pack_id, level_id, created_at,
            EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS age_days
       FROM questions
      WHERE status = 'ai_draft'
        AND created_at < now() - ($1 * INTERVAL '1 day')
        ${packFilter}
      ORDER BY created_at ASC`,
    params,
  );
  return res.rows;
}

/**
 * UPDATE questions SET status='archived' WHERE id = ANY(ids).
 * Returns the list of ids that were actually updated.
 */
export async function archiveStaleDrafts(
  client: MinimalClient,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await client.query<{ id: string }>(
    `UPDATE questions
        SET status = 'archived',
            updated_at = now()
      WHERE id = ANY($1)
      RETURNING id`,
    [ids],
  );
  return res.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}\u2026`;
}

function printTable(rows: StaleDraftRow[]): void {
  const preview = rows.slice(0, 20);
  const header = `${"id".padEnd(36)}  ${"type".padEnd(12)}  ${"topic".padEnd(62)}  age_days`;
  const sep = "-".repeat(header.length);
  console.log(header);
  console.log(sep);
  for (const row of preview) {
    const ageDays =
      typeof row.age_days === "string" ? parseFloat(row.age_days) : row.age_days;
    console.log(
      `${row.id.padEnd(36)}  ${row.type.padEnd(12)}  ${truncate(row.topic, 62).padEnd(62)}  ${ageDays.toFixed(1)}`,
    );
  }
  if (rows.length > 20) {
    console.log(`  ... and ${rows.length - 20} more rows (use --apply to archive all)`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseCLIArgs(): {
  olderThanDays: number;
  packId: string | undefined;
  apply: boolean;
  quiet: boolean;
} {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "older-than-days": { type: "string", default: "7" },
        "pack-id": { type: "string" },
        apply: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(
      `Usage error: ${err instanceof Error ? err.message : String(err)}\n` +
        "Usage: cleanup-stale-drafts.ts [--older-than-days <int>] [--pack-id <uuid>] [--apply] [--quiet]\n",
    );
    process.exit(2);
  }

  const olderThanDays = parseInt(values["older-than-days"] as string, 10);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    process.stderr.write("Error: --older-than-days must be a positive integer.\n");
    process.exit(2);
  }

  return {
    olderThanDays,
    packId: values["pack-id"] as string | undefined,
    apply: values["apply"] as boolean,
    quiet: values["quiet"] as boolean,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { olderThanDays, packId, apply, quiet } = parseCLIArgs();

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

    const rows = await findStaleDrafts(
      client as unknown as MinimalClient,
      olderThanDays,
      packId,
    );

    const packCount = new Set(rows.map((r) => r.pack_id)).size;

    if (!quiet) {
      console.log(
        `Found ${rows.length} ai_draft question${rows.length === 1 ? "" : "s"} ` +
          `older than ${olderThanDays} day${olderThanDays === 1 ? "" : "s"}, ` +
          `across ${packCount} pack${packCount === 1 ? "" : "s"}.`,
      );
    }
    console.log(`Affected: ${rows.length}`);

    if (!apply) {
      if (!quiet && rows.length > 0) {
        printTable(rows);
      }
      console.log("Run with --apply to archive.");
      await client.query("ROLLBACK");
      return;
    }

    if (rows.length === 0) {
      await client.query("COMMIT");
      console.log("Archived 0 rows. Done.");
      return;
    }

    const ids = rows.map((r) => r.id);
    const archivedIds = await archiveStaleDrafts(client as unknown as MinimalClient, ids);
    await client.query("COMMIT");
    console.log(`Archived ${archivedIds.length} rows. Done.`);
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
