// AssessIQ — modules/02-tenancy/src/lifecycle.ts
//
// Phase A lifecycle helpers for tenant-level status enforcement.
// These are read-only assertion functions; they have no side effects.

import { NotFoundError, ConflictError } from "@assessiq/core";
import { getPool } from "./pool.js";

interface TenantStatusRow {
  status: string;
}

/**
 * Assert that a tenant exists and is in a writable state.
 *
 * Runs under the `assessiq_system` BYPASSRLS role so it is safe to call from
 * super-admin paths that have no `app.current_tenant` context pinned (e.g. the
 * write-block guards on super-admin endpoints that operate across tenant
 * boundaries before any `withTenant` scope is established).
 *
 * Allowed statuses: 'active', 'provisioning'.
 * 'provisioning' is permitted so the `createTenant` orchestration window is
 * not blocked while post-create steps (seed, invite) are in flight.
 *
 * Throws:
 *   - NotFoundError  { code: 'TENANT_NOT_FOUND' }           — tenant row absent
 *   - ConflictError  { code: 'TENANT_NOT_ACTIVE', status }  — any other status
 * Returns: void on success (tenant is writable).
 */
export async function assertTenantActive(tenantId: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // BEGIN + SET LOCAL ROLE so the BYPASSRLS role is scoped to this tx only.
    // COMMIT fires AFTER the guard checks so a failed assertion rolls back
    // the empty read-only tx (no functional difference for a SELECT, but it
    // keeps the pattern auditable and consistent with how other system-role
    // helpers in this module wrap mutating + reading work in a single tx).
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const result = await client.query<TenantStatusRow>(
      `SELECT status FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      await client.query("ROLLBACK");
      throw new NotFoundError(`tenant not found`, {
        details: { code: "TENANT_NOT_FOUND", tenantId },
      });
    }

    if (row.status !== "active" && row.status !== "provisioning") {
      await client.query("ROLLBACK");
      // Generic message — internal status only in details (which is safe for
      // super-admin contexts that can already see status via GET /tenants).
      throw new ConflictError(`tenant is not in a writable state`, {
        details: { code: "TENANT_NOT_ACTIVE", status: row.status, tenantId },
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Secondary rollback failure — connection is likely dead OR we already
      // rolled back above before throwing. Either way, swallow — the original
      // error must propagate to the caller.
    });
    throw err;
  } finally {
    client.release();
  }
}
