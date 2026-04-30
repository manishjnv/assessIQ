import type { PoolClient } from "pg";
import { getPool } from "./pool.js";

/**
 * Run `fn` inside a per-call Postgres transaction with tenant context pinned.
 *
 * Implementation notes:
 *
 * 1. `SET LOCAL` is transaction-scoped. Outside an explicit transaction, `SET
 *    LOCAL` is a no-op with a warning. We `BEGIN` first so `SET LOCAL ROLE`
 *    and `set_config(..., true)` actually take effect for the duration.
 *
 * 2. `SET LOCAL ROLE assessiq_app` is defense-in-depth. If `DATABASE_URL`
 *    happens to connect as the superuser (dev, tests, ops mistake) the
 *    superuser bypasses RLS. Switching to the non-superuser application role
 *    inside the transaction re-engages RLS regardless of the connection
 *    user. In production where the URL already points at `assessiq_app`,
 *    this is a cheap no-op.
 *
 * 3. We use `set_config('app.current_tenant', $1, true)` rather than
 *    `SET LOCAL app.current_tenant = '<uuid>'`. The latter cannot accept
 *    placeholders — string-interpolating a uuid in would be a SQL-injection
 *    surface if `tenantId` were ever attacker-controlled. The third arg
 *    `true` makes the setting transaction-local (the LOCAL of SET LOCAL).
 *
 * 4. On exception we `ROLLBACK` (never `COMMIT`) and re-throw. The pg client
 *    is always returned to the pool via `release()`. If `ROLLBACK` itself
 *    fails (the connection is already broken) we swallow the secondary
 *    error and re-throw the original so the caller sees the real cause.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [
      tenantId,
    ]);

    const result = await fn(client);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary failure during rollback — connection is likely dead.
      // Swallow so the caller sees the original error.
    });
    throw err;
  } finally {
    client.release();
  }
}
