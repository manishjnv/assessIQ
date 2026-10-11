import type { PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { ValidationError, UUID_RE, streamLogger } from "@assessiq/core";
import { getPool } from "./pool.js";

const log = streamLogger("app");

// FU-D7 (2026-10-06): hardening, not a fix. Today an empty/malformed tenantId
// reaches set_config and the RLS policy comparison then fails closed (a cast
// error on `::uuid`), so no tenant isolation bug exists without this check.
// This just turns that into an explicit, named error at the one call site
// every tenant-scoped operation goes through, instead of a generic Postgres
// cast error surfacing from wherever `fn` first touches a tenant-scoped table.

function assertValidTenantId(tenantId: string): void {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new ValidationError(
      "withTenant: tenantId must be a non-empty UUID",
      { details: { code: "INVALID_TENANT_ID" } },
    );
  }
}

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

// Tracks which kind of scaffold the current async context is inside, so a
// system-role transaction can never be opened from within a tenant one.
const als = new AsyncLocalStorage<{ kind: "tenant" | "system" }>();

async function runInTx<T>(
  kind: "tenant" | "system",
  setup: (client: PoolClient) => Promise<void>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const hooks: Array<() => Promise<void>> = [];
  afterCommit.set(client, hooks);
  let result: T;
  // If ROLLBACK itself fails the connection may still sit in an open tx with the
  // elevated role; destroy it instead of returning it to the pool (RW-38 review).
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await setup(client);

    result = await als.run({ kind }, () => fn(client));

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary failure during rollback — connection is likely dead.
      // Swallow so the caller sees the original error.
      destroyClient = true;
    });
    throw err;
  } finally {
    afterCommit.delete(client);
    client.release(destroyClient || undefined);
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

export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertValidTenantId(tenantId);
  return runInTx(
    "tenant",
    async (client) => {
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [
        tenantId,
      ]);
    },
    fn,
  );
}

function callerFrame(): string {
  try {
    const lines = (new Error().stack ?? "").split("\n").slice(1);
    for (const l of lines) {
      if (l.includes("with-tenant")) continue;
      const m = /\(?([^()\s]+:\d+):\d+\)?\s*$/.exec(l);
      if (m) return m[1]!;
    }
  } catch {
    // best effort
  }
  return "unknown";
}

/**
 * Run `fn` in a transaction under the `assessiq_system` role (RLS bypass for
 * cross-tenant reads/writes). `reason` is logged with the caller. Refuses to
 * run inside a withTenant scope. Mixed pattern (system read, then
 * `SET LOCAL ROLE assessiq_app` + set_config in the same tx) stays the caller's job.
 */
export async function withSystemRole<T>(
  reason: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new ValidationError("withSystemRole: reason must be a non-empty string", {
      details: { code: "INVALID_SYSTEM_ROLE_REASON" },
    });
  }
  if (als.getStore()?.kind === "tenant") {
    const err = new Error("SYSTEM_ROLE_INSIDE_TENANT") as Error & { code: string };
    err.code = "SYSTEM_ROLE_INSIDE_TENANT";
    throw err;
  }
  log.info({ reason, caller: callerFrame() }, "system-role.tx");
  return runInTx(
    "system",
    async (client) => {
      await client.query("SET LOCAL ROLE assessiq_system");
    },
    fn,
  );
}

