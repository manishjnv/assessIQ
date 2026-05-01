import { Pool } from "pg";
import { config, streamLogger } from "@assessiq/core";

const log = streamLogger('app');

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool === undefined) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      // Connection-level safety: fail fast on a dead connection.
      // Phase 1 will tune these from observability data.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // application_name shows up in pg_stat_activity for debugging.
      application_name: "assessiq",
    });

    pool.on("error", (err) => {
      // pg.Pool emits 'error' on idle clients that fail. Log and let the next
      // checkout attempt re-establish. Do NOT crash the process here.
      log.error({ err }, "pg pool idle-client error");
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/**
 * Test-only: replace the singleton pool with one pointed at the given URL.
 *
 * Used by testcontainers-backed integration tests where `DATABASE_URL` from
 * `vitest.setup.ts` is a placeholder. Closes any previously-created pool
 * first so the singleton stays consistent. NOT exported from `index.ts` —
 * test files import from `./pool.js` directly.
 */
export async function setPoolForTesting(connectionString: string): Promise<Pool> {
  if (pool !== undefined) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    application_name: "assessiq-test",
  });
  pool.on("error", (err) => {
    log.error({ err }, "pg pool idle-client error (test pool)");
  });
  return pool;
}
