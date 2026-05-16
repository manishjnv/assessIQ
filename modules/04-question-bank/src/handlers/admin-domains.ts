/**
 * Handlers: GET /api/admin/domains + GET /api/admin/categories
 *           POST /api/admin/domains + POST /api/admin/categories  (Slice 2.1b)
 *
 * Read-only GETs: RLS via withTenant() — no explicit tenant_id WHERE clauses
 * needed for reads (same pattern as admin-attempts-list.ts).
 *
 * Write POSTs: tenant_id is set EXPLICITLY on every INSERT — do NOT rely on RLS
 * for writes (RLS is enforced at the row-level by policy, but the FK from
 * categories → domains bypasses RLS at the Postgres FK-enforcement layer, so an
 * explicit SELECT 1 FROM domains WHERE id=$1 AND tenant_id=$2 guard runs before
 * every category INSERT). This is the same class of guard Opus added to Slice 2's
 * generateQuestions (service.ts:1340-1364).
 *
 * No external auth logic here: the Fastify route layer applies the
 * adminOnly preHandler before calling these handlers.
 */

import { ConflictError, ValidationError, uuidv7 } from "@assessiq/core";
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

// ---------------------------------------------------------------------------
// Slug helper (mirrors service.ts:81-91 generateSlugFromName — kept local so
// this handler file has no dep on service.ts which would create a cycle)
// ---------------------------------------------------------------------------

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// POST /api/admin/domains  — B1 write handler
// ---------------------------------------------------------------------------

export interface HandleAdminCreateDomainInput {
  tenantId: string;
  name: string;
  description?: string;
}

export type HandleAdminCreateDomainOutput = DomainRow;

/**
 * Creates a domain for the session tenant.
 *
 * Security notes:
 *  - tenant_id is set EXPLICITLY on INSERT (not relying on RLS alone for writes).
 *  - display_order = MAX(display_order)+1 within the tenant.
 *  - slug = server-generated kebab-case(name); unique violation → 409.
 *  - name is validated: required, non-empty, max 200 chars (defence-in-depth;
 *    route layer Zod schema also validates).
 */
export async function handleAdminCreateDomain(
  input: HandleAdminCreateDomainInput,
): Promise<HandleAdminCreateDomainOutput> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("name must not be empty", {
      details: { code: "MISSING_REQUIRED", field: "name" },
    });
  }
  if (name.length > 200) {
    throw new ValidationError("name must not exceed 200 characters", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }

  const slug = slugFromName(name);
  if (slug.length === 0) {
    throw new ValidationError("name must contain at least one alphanumeric character", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }

  const id = uuidv7();

  try {
    return await withTenant(input.tenantId, async (client) => {
      // display_order = MAX(display_order)+1 for this tenant (RLS scopes the MAX to this tenant)
      const orderRes = await client.query<{ max: number | null }>(
        "SELECT MAX(display_order) AS max FROM domains",
      );
      const nextOrder = (orderRes.rows[0]?.max ?? 0) + 1;

      const res = await client.query<DomainRow>(
        `INSERT INTO domains (id, tenant_id, slug, name, description, status, display_order)
         VALUES ($1, $2, $3, $4, $5, 'active', $6)
         RETURNING id, slug, name, description, status, display_order`,
        [id, input.tenantId, slug, name, input.description ?? null, nextOrder],
      );
      return res.rows[0]!;
    });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new ConflictError(
        `A domain with slug '${slug}' already exists in this tenant.`,
        { details: { code: "DOMAIN_SLUG_EXISTS", slug } },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/categories  — B1 write handler
// ---------------------------------------------------------------------------

export interface HandleAdminCreateCategoryInput {
  tenantId: string;
  domain_id: string;
  name: string;
  description?: string;
  supported_types?: string[];
  default_question_count?: number;
}

export type HandleAdminCreateCategoryOutput = CategoryRow;

/**
 * Creates a category under domain_id for the session tenant.
 *
 * SECURITY — cross-tenant FK guard (load-bearing; DO NOT REMOVE):
 *   Before inserting, we explicitly check:
 *     SELECT 1 FROM domains WHERE id=$1 AND tenant_id=$2
 *   Postgres FK enforcement runs as the table owner and bypasses RLS, so a
 *   category in tenant A could reference a domain in tenant B without this
 *   guard. This is the same class of vulnerability Opus caught in the Slice 2
 *   generateQuestions guard (service.ts:1340-1364).
 *   Rejection → 422 CROSS_TENANT_FK_REJECTED.
 *
 * Other invariants:
 *  - tenant_id set explicitly on INSERT.
 *  - slug = server-generated kebab-case(name); unique violation → 409.
 *  - relevance_score = MAX(relevance_score)+1 within domain (RLS-scoped to tenant).
 *  - supported_types defaults to parent domain's supported_types if omitted.
 *  - default_question_count defaults to 1 if omitted.
 *  - default_selected = true.
 *  - status = 'active'.
 */
export async function handleAdminCreateCategory(
  input: HandleAdminCreateCategoryInput,
): Promise<HandleAdminCreateCategoryOutput> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("name must not be empty", {
      details: { code: "MISSING_REQUIRED", field: "name" },
    });
  }
  if (name.length > 200) {
    throw new ValidationError("name must not exceed 200 characters", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }

  if (!input.domain_id || !UUID_RE.test(input.domain_id)) {
    throw new ValidationError("domain_id must be a valid UUID", {
      details: { code: "INVALID_PARAM", field: "domain_id" },
    });
  }

  const slug = slugFromName(name);
  if (slug.length === 0) {
    throw new ValidationError("name must contain at least one alphanumeric character", {
      details: { code: "INVALID_PARAM", field: "name" },
    });
  }

  const id = uuidv7();

  try {
    return await withTenant(input.tenantId, async (client) => {
      // ── SECURITY: cross-tenant FK guard ─────────────────────────────────
      // Must verify the domain belongs to the session tenant BEFORE insert.
      // Postgres FK validation bypasses RLS; without this check a category
      // in tenant A could hold a domain_id from tenant B.
      const guardRes = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM domains WHERE id = $1 AND tenant_id = $2) AS exists",
        [input.domain_id, input.tenantId],
      );
      if (!guardRes.rows[0]?.exists) {
        throw new ValidationError(
          "domain_id does not exist or does not belong to this tenant",
          { details: { code: "CROSS_TENANT_FK_REJECTED", field: "domain_id" } },
        );
      }

      // Fetch parent domain's supported_types if caller omitted the field.
      let supportedTypes: string[] | null = null;
      if (input.supported_types !== undefined) {
        supportedTypes = input.supported_types;
      } else {
        const domainRes = await client.query<{ supported_types: unknown }>(
          "SELECT supported_types FROM domains WHERE id = $1",
          [input.domain_id],
        );
        const raw = domainRes.rows[0]?.supported_types;
        if (Array.isArray(raw)) {
          supportedTypes = raw as string[];
        }
      }

      // relevance_score = MAX(relevance_score)+1 within domain
      // (RLS ensures the MAX only sees this tenant's categories)
      const scoreRes = await client.query<{ max: number | null }>(
        "SELECT MAX(relevance_score) AS max FROM categories WHERE domain_id = $1",
        [input.domain_id],
      );
      const nextScore = (scoreRes.rows[0]?.max ?? 0) + 1;

      const defaultCount = input.default_question_count ?? 1;

      const res = await client.query<CategoryRow>(
        `INSERT INTO categories
           (id, tenant_id, domain_id, slug, name, description,
            relevance_score, default_selected, supported_types,
            default_question_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, 'active')
         RETURNING id, domain_id, slug, name, description,
                   relevance_score, default_selected, supported_types,
                   default_question_count, status`,
        [
          id,
          input.tenantId,
          input.domain_id,
          slug,
          name,
          input.description ?? null,
          nextScore,
          supportedTypes !== null ? JSON.stringify(supportedTypes) : null,
          defaultCount,
        ],
      );
      return res.rows[0]!;
    });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new ConflictError(
        `A category with slug '${slug}' already exists in this tenant.`,
        { details: { code: "CATEGORY_SLUG_EXISTS", slug } },
      );
    }
    throw err;
  }
}
