// RW-55: keep domains.node_id / categories.node_id live for NEW rows (migration 0169
// maps existing rows). Helpers run inside a caller-owned transaction/client.
import { AppError } from "@assessiq/core";
import type { PoolClient } from "pg";

export interface NodeSpec {
  tenantId: string | null; // null = platform-owned node
  parentId: string | null;
  kind: "subject" | "unit";
  code: string;
  label: string;
  position: number;
  status?: "active" | "archived";
}

/** Framework 1 ('legacy-domains', NULL tenant). Visible under RLS; throws if 0169 data is absent. */
export async function legacyFrameworkId(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM frameworks WHERE tenant_id IS NULL AND slug = 'legacy-domains'`,
  );
  const id = r.rows[0]?.id;
  if (id === undefined) {
    throw new AppError("legacy-domains framework is missing", "FRAMEWORK_MISSING", 500);
  }
  return id;
}

/** Find an existing node by its natural key (null-safe on tenant and parent). */
export async function findNodeId(
  client: PoolClient,
  frameworkId: string,
  tenantId: string | null,
  parentId: string | null,
  code: string,
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM taxonomy_nodes
      WHERE framework_id = $1 AND tenant_id IS NOT DISTINCT FROM $2
        AND parent_id IS NOT DISTINCT FROM $3 AND code = $4`,
    [frameworkId, tenantId, parentId, code],
  );
  return r.rows[0]?.id ?? null;
}

/** INSERT ... ON CONFLICT DO NOTHING, then SELECT the id (as 0169 does). */
export async function ensureNode(client: PoolClient, n: NodeSpec): Promise<string> {
  const fw = await legacyFrameworkId(client);
  await client.query(
    `INSERT INTO taxonomy_nodes (tenant_id, framework_id, parent_id, kind, code, label, position, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, framework_id, parent_id, code) DO NOTHING`,
    [n.tenantId, fw, n.parentId, n.kind, n.code, n.label, n.position, n.status ?? "active"],
  );
  const id = await findNodeId(client, fw, n.tenantId, n.parentId, n.code);
  if (id === null) throw new AppError("taxonomy node not found after insert", "NODE_MISSING", 500);
  return id;
}

/**
 * Link a copied PLATFORM-source domain row to the existing NULL-tenant node by slug.
 * Creates no node. Returns the node id (null when the platform node does not exist).
 */
export async function linkPlatformDomain(
  client: PoolClient,
  domainId: string,
  slug: string,
): Promise<string | null> {
  const fw = await legacyFrameworkId(client);
  const nodeId = await findNodeId(client, fw, null, null, slug);
  if (nodeId !== null) await client.query(`UPDATE domains SET node_id = $2 WHERE id = $1`, [domainId, nodeId]);
  return nodeId;
}

/** Link every unlinked category of a platform-source domain to the NULL-tenant unit node (by slug). */
export async function linkPlatformCategories(
  client: PoolClient,
  domainId: string,
  domainNodeId: string | null,
): Promise<void> {
  if (domainNodeId === null) return;
  await client.query(
    `UPDATE categories c SET node_id = n.id
       FROM taxonomy_nodes n
      WHERE c.domain_id = $1 AND c.node_id IS NULL
        AND n.parent_id = $2 AND n.tenant_id IS NULL AND n.kind = 'unit' AND n.code = c.slug`,
    [domainId, domainNodeId],
  );
}
