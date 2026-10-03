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
// Post-commit hooks, keyed by the client of an OPEN withTenant transaction only.
// A hook registered on any other client is refused (returns false), so a pooled
// client can never carry a hook into its next checkout. FR2 / FU-B5.
const afterCommit = new WeakMap<PoolClient, Array<() => Promise<void>>>();

/**
 * Run `hook` after the enclosing withTenant transaction commits. Never runs on
 * rollback. Hooks must not throw (they run after COMMIT; a throw is swallowed so
 * the caller still gets its committed result). Returns false when `client` is not
 * inside withTenant — the hook is then dropped.
 */
export function onCommit(client: PoolClient, hook: () => Promise<void>): boolean {
  const hooks = afterCommit.get(client);
  if (hooks === undefined) return false;
  hooks.push(hook);
  return true;
}

export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const hooks: Array<() => Promise<void>> = [];
  afterCommit.set(client, hooks);
  let result: T;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_app");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [
      tenantId,
    ]);

    result = await fn(client);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary failure during rollback — connection is likely dead.
      // Swallow so the caller sees the original error.
    });
    throw err;
  } finally {
    afterCommit.delete(client);
    client.release();
  }

  // After release: a hook may open its own withTenant (fanout does), and holding
  // this client while waiting for another could starve a full pool.
  for (const hook of hooks) {
    try {
      await hook();
    } catch {
      // Already committed; the hook owns its own logging (see fanoutAuditEvent).
    }
  }
  return result;
}
