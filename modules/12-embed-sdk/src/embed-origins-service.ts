// modules/12-embed-sdk/src/embed-origins-service.ts
//
// CRUD service for tenant embed origins stored in tenants.embed_origins TEXT[].
//
// Spec: modules/12-embed-sdk/SKILL.md § Decisions captured D2.
// Admin endpoints: POST/GET/DELETE /api/admin/embed-origins.
//
// All mutations write an audit_log row via @assessiq/audit-log.audit().
// All queries run inside withTenant so RLS is respected.
//
// INVARIANT: this file MUST NOT import from @anthropic-ai, claude, or any AI SDK.

import { withTenant } from "@assessiq/tenancy";
import { audit } from "@assessiq/audit-log";
import type { PoolClient } from "pg";

export interface EmbedOriginRow {
  origin: string;
  position: number;
}

/** List all allowed embed origins for a tenant. */
export async function listEmbedOrigins(tenantId: string): Promise<EmbedOriginRow[]> {
  return withTenant(tenantId, async (client: PoolClient) => {
    const result = await client.query<{ embed_origins: string[] }>(
      `SELECT embed_origins FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const origins = result.rows[0]?.embed_origins ?? [];
    return origins.map((origin, position) => ({ origin, position }));
  });
}

/** Add an origin to the tenant's embed_origins array. Idempotent. */
export async function addEmbedOrigin(
  tenantId: string,
  origin: string,
  actorUserId: string,
): Promise<void> {
  // Validate origin shape: must be scheme://hostname[:port]
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(origin)) {
    throw new Error(`Invalid embed origin format: ${origin}`);
  }

  await withTenant(tenantId, async (client: PoolClient) => {
    // array_append + check for duplicates in one operation
    await client.query(
      `UPDATE tenants
       SET embed_origins = array_append(embed_origins, $2)
       WHERE id = $1
         AND NOT ($2 = ANY(embed_origins))`,
      [tenantId, origin],
    );
  });

  await audit({
    tenantId,
    actorKind: "user",
    actorUserId,
    action: "embed_origin.added",
    entityType: "tenant",
    entityId: tenantId,
    after: { origin },
  });
}

/** Remove an origin from the tenant's embed_origins array by value. */
export async function removeEmbedOrigin(
  tenantId: string,
  origin: string,
  actorUserId: string,
): Promise<void> {
  await withTenant(tenantId, async (client: PoolClient) => {
    await client.query(
      `UPDATE tenants
       SET embed_origins = array_remove(embed_origins, $2)
       WHERE id = $1`,
      [tenantId, origin],
    );
  });

  await audit({
    tenantId,
    actorKind: "user",
    actorUserId,
    action: "embed_origin.removed",
    entityType: "tenant",
    entityId: tenantId,
    before: { origin },
  });
}
