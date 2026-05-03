// modules/12-embed-sdk/src/origin-verifier.ts
//
// Verify that a postMessage origin (or iframe src origin) is listed in
// tenants.embed_origins for the given tenant.
//
// Called by:
//   1. GET /embed handler — after JWT verify — to build the CSP frame-ancestors header.
//   2. Frontend embedBus (client-side) — checked against window.__AIQ_EMBED_CONFIG__.allowedOrigins.
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D2, D8.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";

interface TenantOriginsRow {
  embed_origins: string[];
}

/**
 * Returns the array of allowed embed origins for a tenant.
 * Never returns undefined — returns an empty array if none configured.
 *
 * Called server-side: tenant context is set by withTenant so the RLS policy
 * on tenants (id = current_setting('app.current_tenant')::uuid) applies.
 */
export async function getEmbedOrigins(tenantId: string): Promise<string[]> {
  const result = await withTenant(tenantId, async (client: PoolClient) => {
    const row = await client.query<TenantOriginsRow>(
      `SELECT embed_origins FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    return row.rows[0]?.embed_origins ?? [];
  });
  return result;
}

/**
 * Returns true iff `origin` is present in the tenant's embed_origins list.
 *
 * Security notes:
 *   - Comparison is exact string equality (no prefix/suffix matching).
 *   - Origins in the list should be scheme + hostname [+ port], e.g.
 *     "https://portal.wipro.com" — no path component.
 *   - An empty allow-list means NO origin is permitted (fail-closed).
 */
export async function verifyEmbedOrigin(
  tenantId: string,
  origin: string,
): Promise<boolean> {
  const allowed = await getEmbedOrigins(tenantId);
  return allowed.includes(origin);
}
