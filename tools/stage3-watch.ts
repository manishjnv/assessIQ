/**
 * tools/stage3-watch.ts
 *
 * Stage 3 promotion watch — read-only alert script.
 *
 * Queries generation_attempts for sharded runs in the last window (1h default,
 * 24h with --window 24h) and exits non-zero when either threshold is breached:
 *
 *   chunks_failed_rate > 0.25  (more than 25% of planned chunks failed)
 *   citation_dropped_total > 0 (any citation-validation drops)
 *
 * On breach, appends a timestamped entry to STAGE3_WATCH_LOG
 * (default: /var/log/assessiq/stage3-watch.log).
 *
 * DECISION LOCKED (docs/design/2026-05-10-stage-3-promotion-rollout.md §8 Q4):
 *   Alert-only. NO auto-rollback. NO env edits. NO container restarts.
 *   Rollback is a deliberate operator action after root-cause analysis.
 *
 * SECURITY NOTE: Uses `SET LOCAL ROLE assessiq_system` inside a read-only
 * transaction to bypass row-level security for the aggregate cross-tenant
 * query. assessiq_system is a BYPASSRLS NOLOGIN role — it can only be
 * activated via SET LOCAL ROLE within an existing transaction; it cannot open
 * a direct DB connection. The elevated privilege is scoped to the transaction
 * duration only (LOCAL semantics) and reverts automatically on COMMIT or
 * ROLLBACK. This is the same access pattern used by the other tools/ scripts.
 * Run only from trusted operator shell access (VPS SSH / systemd service).
 *
 * Usage (requires tsx, run from inside the api container or with DATABASE_URL set):
 *   pnpm exec tsx tools/stage3-watch.ts [options]
 *
 * Args:
 *   --window <1h|24h>      default "1h"   — look-back window for the query
 *   --dry-run              default false  — print would-be log entry to stdout
 *                                          instead of writing the file
 *
 * Exit codes:
 *   0  all metrics within threshold (or no sharded attempts in window)
 *   1  breach detected (chunks_failed_rate > 25% OR citation_dropped > 0)
 *   2  usage error / DATABASE_URL missing / DB connect failure
 */

/* eslint-disable no-console */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WindowOption = "1h" | "24h";

export interface WatchMetrics {
  window: WindowOption;
  total_attempts: number;
  chunks_failed_total: number;
  chunks_planned_total: number;
  citation_dropped_total: number;
  chunks_failed_rate: number | null; // null when chunks_planned_total === 0
}

export interface WatchResult {
  metrics: WatchMetrics;
  breach: boolean;
  breach_reasons: string[];
}

/** Minimal pg-client interface accepted by the query functions. */
export interface MinimalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = Record<string, any>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface AggregateRow {
  total_attempts: string; // pg returns numeric columns as strings
  chunks_failed_total: string;
  chunks_planned_total: string;
  citation_dropped_total: string;
}

// ---------------------------------------------------------------------------
// Core query — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Aggregate sharded generation_attempts metrics for the given look-back window.
 * Caller is responsible for SET LOCAL ROLE so RLS is bypassed for the cross-
 * tenant aggregate. This function performs NO writes.
 */
export async function queryWatchMetrics(
  client: MinimalClient,
  window: WindowOption,
): Promise<WatchMetrics> {
  const interval = window === "24h" ? "24 hours" : "1 hour";

  const res = await client.query<AggregateRow>(
    `SELECT
       COUNT(*)                                AS total_attempts,
       COALESCE(SUM(chunks_failed), 0)         AS chunks_failed_total,
       COALESCE(SUM(chunks_planned), 0)        AS chunks_planned_total,
       COALESCE(SUM(citation_dropped), 0)      AS citation_dropped_total
     FROM generation_attempts
     WHERE started_at > now() - $1::interval
       AND chunks_planned IS NOT NULL`,
    [interval],
  );

  const row = res.rows[0];
  if (row === undefined) {
    // Should not happen (COUNT always returns a row) but guard for TS safety.
    throw new Error("Unexpected empty result from aggregate query");
  }

  const total_attempts = parseInt(row.total_attempts, 10);
  const chunks_failed_total = parseInt(row.chunks_failed_total, 10);
  const chunks_planned_total = parseInt(row.chunks_planned_total, 10);
  const citation_dropped_total = parseInt(row.citation_dropped_total, 10);

  const chunks_failed_rate =
    chunks_planned_total === 0
      ? null
      : chunks_failed_total / chunks_planned_total;

  return {
    window,
    total_attempts,
    chunks_failed_total,
    chunks_planned_total,
    citation_dropped_total,
    chunks_failed_rate,
  };
}

// ---------------------------------------------------------------------------
// Breach evaluation — exported for unit testing
// ---------------------------------------------------------------------------

export function evaluateBreach(metrics: WatchMetrics): WatchResult {
  const breach_reasons: string[] = [];

  if (
    metrics.chunks_failed_rate !== null &&
    metrics.chunks_failed_rate > 0.25
  ) {
    breach_reasons.push(
      `chunks_failed_rate ${(metrics.chunks_failed_rate * 100).toFixed(1)}% exceeds 25% threshold` +
        ` (${metrics.chunks_failed_total}/${metrics.chunks_planned_total} chunks failed)`,
    );
  }

  if (metrics.citation_dropped_total > 0) {
    breach_reasons.push(
      `citation_dropped_total=${metrics.citation_dropped_total} (threshold: 0)`,
    );
  }

  return {
    metrics,
    breach: breach_reasons.length > 0,
    breach_reasons,
  };
}

// ---------------------------------------------------------------------------
// Log-file writer — exported for unit testing
// ---------------------------------------------------------------------------

export function formatLogEntry(result: WatchResult): string {
  const ts = new Date().toISOString();
  const headline = result.breach_reasons.join("; ");
  return (
    JSON.stringify({
      ts,
      headline,
      metrics: result.metrics,
    }) + "\n"
  );
}

/**
 * Appends a breach entry to the watch log file.
 * Creates the directory if it does not exist (best-effort; throws if the
 * directory cannot be created due to permissions).
 *
 * Only called when result.breach === true and --dry-run is false.
 */
export function appendToWatchLog(logPath: string, entry: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, entry, "utf8");
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseCLIArgs(): {
  window: WindowOption;
  dryRun: boolean;
} {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        window: { type: "string", default: "1h" },
        "dry-run": { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(
      `Usage error: ${err instanceof Error ? err.message : String(err)}\n` +
        "Usage: stage3-watch.ts [--window <1h|24h>] [--dry-run]\n",
    );
    process.exit(2);
  }

  const windowRaw = values["window"] as string;
  if (windowRaw !== "1h" && windowRaw !== "24h") {
    process.stderr.write(
      `Error: --window must be "1h" or "24h"; got "${windowRaw}"\n`,
    );
    process.exit(2);
  }

  return {
    window: windowRaw as WindowOption,
    dryRun: values["dry-run"] as boolean,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { window, dryRun } = parseCLIArgs();

  const logPath =
    process.env["STAGE3_WATCH_LOG"] ?? "/var/log/assessiq/stage3-watch.log";

  // DATABASE_URL guard — defer eager module imports until after this check.
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
    // Read-only transaction — no writes occur inside this block.
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    const metrics = await queryWatchMetrics(
      client as unknown as MinimalClient,
      window,
    );

    const result = evaluateBreach(metrics);

    // Always emit a structured stdout line — captured by systemd journal.
    const summaryLine = JSON.stringify({
      stage3_watch: true,
      breach: result.breach,
      breach_reasons: result.breach_reasons,
      metrics: result.metrics,
    });
    console.log(summaryLine);

    await client.query("COMMIT");

    if (result.breach) {
      const entry = formatLogEntry(result);
      if (dryRun) {
        console.log("[dry-run] would append to", logPath);
        console.log(entry.trimEnd());
      } else {
        appendToWatchLog(logPath, entry);
        process.stderr.write(
          `BREACH: ${result.breach_reasons.join("; ")}\n` +
            `  Appended entry to ${logPath}\n`,
        );
      }
      process.exit(1);
    }
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
