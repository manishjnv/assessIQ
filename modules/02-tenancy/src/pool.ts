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
      // PG_POOL_MAX (default 30) — see config.ts for the max_connections
      // arithmetic. Was a hardcoded 10, too small for a 300-candidate drive.
      max: config.PG_POOL_MAX,
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

let systemPool: Pool | undefined;

/**
 * FUT-10: pool for `withSystemRole` work. In production SYSTEM_DATABASE_URL (login
 * assessiq_system) is REQUIRED by config, so the app login never needs the BYPASSRLS
 * role. In dev/test it is unset and this returns the main pool. The URL is never logged.
 */
export function getSystemPool(): Pool {
  if (config.SYSTEM_DATABASE_URL === undefined && systemPool === undefined) return getPool();
  if (systemPool === undefined) {
    systemPool = new Pool({
      connectionString: config.SYSTEM_DATABASE_URL,
      max: config.PG_SYSTEM_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "assessiq-system",
    });
    systemPool.on("error", (err) => {
      log.error({ err }, "pg system pool idle-client error");
    });
  }
  return systemPool;
}

/** Test-only: point the system pool at a URL (undefined clears it, back to the main pool). */
export async function setSystemPoolForTesting(connectionString: string | undefined): Promise<void> {
  if (systemPool !== undefined) {
    const p = systemPool;
    systemPool = undefined;
    await p.end();
  }
  if (connectionString === undefined) return;
  systemPool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 5_000, application_name: "assessiq-system-test" });
  systemPool.on("error", (err) => {
    log.error({ err }, "pg system pool idle-client error (test)");
  });
}

export async function closePool(): Promise<void> {
  if (systemPool !== undefined) {
    const sp = systemPool;
    systemPool = undefined;
    await sp.end();
  }
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
