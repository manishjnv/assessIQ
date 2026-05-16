/**
 * Handlers: GET /api/admin/domains + GET /api/admin/categories
 *
 * Read-only endpoints for the domain-category taxonomy (Slice 2).
 *
 * RLS: withTenant() scopes to the current tenant. Queries do NOT add
 * WHERE tenant_id explicitly - RLS on domains/categories enforces isolation
 * (same pattern as admin-attempts-list.ts, CLAUDE.md hard rule #4).
 *
 * No external auth logic here: the Fastify route layer applies the
 * adminOnly preHandler before calling these handlers.
 */

import { withTenant } from "@assessiq/tenancy";

// UUID regex - validates domain_id query param before handler is called.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DomainRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  display_order: number;
}

export interface HandleAdminListDomainsInput {
  tenantId: string;
}

export interface HandleAdminListDomainsOutput {
  items: DomainRow[];
  total: number;
}

export interface CategoryRow {
  id: string;
  domain_id: string;
  slug: string;
  name: string;
  description: string | null;
  relevance_score: number;
  default_selected: boolean;
  supported_types: unknown;
  default_question_count: number;
  status: string;
}

export interface HandleAdminListCategoriesInput {
  tenantId: string;
  /** Already validated as UUID by the route layer. */
  domainId: string;
}

export interface HandleAdminListCategoriesOutput {
  items: CategoryRow[];
  total: number;
}

export async function handleAdminListDomains(
  input: HandleAdminListDomainsInput,
): Promise<HandleAdminListDomainsOutput> {
  return withTenant(input.tenantId, async (client) => {
    const result = await client.query<DomainRow & { count: string }>(
      "SELECT id, slug, name, description, status, display_order, COUNT(*) OVER() AS count FROM domains WHERE status = 'active' ORDER BY display_order ASC",
    );
    const total = result.rows.length > 0 ? parseInt(result.rows[0]!.count, 10) : 0;
    return {
      items: result.rows.map(({ count: _c, ...row }) => row),
      total,
    };
  });
}

export async function handleAdminListCategories(
  input: HandleAdminListCategoriesInput,
): Promise<HandleAdminListCategoriesOutput> {
  return withTenant(input.tenantId, async (client) => {
    const result = await client.query<CategoryRow & { count: string }>(
      "SELECT id, domain_id, slug, name, description, relevance_score, default_selected, supported_types, default_question_count, status, COUNT(*) OVER() AS count FROM categories WHERE status = 'active' AND domain_id = $1 ORDER BY relevance_score DESC",
      [input.domainId],
    );
    const total = result.rows.length > 0 ? parseInt(result.rows[0]!.count, 10) : 0;
    return {
      items: result.rows.map(({ count: _c, ...row }) => row),
      total,
    };
  });
}
