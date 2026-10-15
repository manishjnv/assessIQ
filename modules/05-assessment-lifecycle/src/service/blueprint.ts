import { ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { findOrCreatePackForDomain } from "../../../04-question-bank/src/service.js";
import { AL_ERROR_CODES } from "../types.js";
import type { AssessmentBlueprint, ResolvedBlueprint } from "../types.js";

// ---------------------------------------------------------------------------
// Blueprint helpers (Phase 2 Slice A)
// ---------------------------------------------------------------------------

/**
 * Count active questions for a single blueprint criterion
 * (pack_id + level_id + domain_id + category_id + type + status='active').
 *
 * Runs inside the caller's tenant-scoped withTenant client; RLS applies.
 * Used by publishAssessment pool pre-flight (C2) and previewAssessment (C4).
 */
export async function countActiveQuestionsForCriterion(
  client: PoolClient,
  packId: string,
  levelId: string,
  domainId: string,
  categoryId: string,
  type: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND domain_id = $3
       AND category_id = $4 AND type = $5 AND status = 'active'`,
    [packId, levelId, domainId, categoryId, type],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Pull up to `limit` active questions for a single blueprint criterion.
 * Used by previewAssessment (C4) to show sample topics.
 */
export async function listActiveQuestionsForCriterion(
  client: PoolClient,
  packId: string,
  levelId: string,
  domainId: string,
  categoryId: string,
  type: string,
  limit: number,
): Promise<unknown[]> {
  const result = await client.query(
    `SELECT id, topic, type, points FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND domain_id = $3
       AND category_id = $4 AND type = $5 AND status = 'active'
     ORDER BY created_at ASC, id ASC
     LIMIT $6`,
    [packId, levelId, domainId, categoryId, type, limit],
  );
  return result.rows;
}

/**
 * Validate blueprint cross-tenant FK integrity (C1 — primary security control).
 *
 * SECURITY: blueprint.domain_id and criterion.category_id are stored in JSONB.
 * Postgres FK validation bypasses RLS so a malicious request could reference
 * a domain or category from another tenant's JSONB blob. This explicit guard
 * is the only control preventing that — same class as the 2.1b/2.1c guard in
 * modules/04-question-bank/src/handlers/admin-domains.ts:261-273 and
 * modules/04-question-bank/src/service.ts:1286-1295.
 *
 * Steps:
 *   1. Verify domain_id belongs to session tenant.
 *   2. For each DISTINCT category_id, verify it belongs to session tenant
 *      AND is a child of blueprint.domain_id.
 *
 * Any miss → throws ValidationError 422 CROSS_TENANT_FK_REJECTED.
 *
 * Runs inside the caller's tenant-scoped withTenant client.
 */
export async function assertBlueprintFKOwnership(
  client: PoolClient,
  tenantId: string,
  blueprint: ResolvedBlueprint,
): Promise<void> {
  // 1. Domain guard
  const domainGuard = await client.query<{ slug: string }>(
    `SELECT slug FROM domains WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [blueprint.domain_id, tenantId],
  );
  if (domainGuard.rows.length === 0) {
    throw new ValidationError(
      "blueprint.domain_id does not exist or does not belong to this organisation",
      {
        details: {
          code: AL_ERROR_CODES.CROSS_TENANT_FK_REJECTED,
          field: "blueprint.domain_id",
          domain_id: blueprint.domain_id,
        },
      },
    );
  }

  // 2. Per-distinct-category guard
  const distinctCategoryIds = [...new Set(blueprint.criteria.map((c) => c.category_id))];
  for (const categoryId of distinctCategoryIds) {
    const catGuard = await client.query<{ id: string }>(
      `SELECT id FROM categories
       WHERE id = $1 AND domain_id = $2 AND tenant_id = $3
       LIMIT 1`,
      [categoryId, blueprint.domain_id, tenantId],
    );
    if (catGuard.rows.length === 0) {
      throw new ValidationError(
        `blueprint category_id does not exist, does not belong to this organisation, or does not belong to the specified subject`,
        {
          details: {
            code: AL_ERROR_CODES.CROSS_TENANT_FK_REJECTED,
            field: "blueprint.criteria[].category_id",
            category_id: categoryId,
            domain_id: blueprint.domain_id,
          },
        },
      );
    }
  }
}

/**
 * RW-55 — resolve node_id criteria to the tenant's (domain_id, category_id).
 * Runs inside the caller's tenant-scoped client (RLS applies to categories).
 * Returns the stored (resolved) shape; node_id is kept for traceability only.
 * The draw / count / preview / frozen pool read domain_id + category_id and never change.
 */
export async function resolveBlueprintNodes(
  client: PoolClient,
  blueprint: AssessmentBlueprint,
): Promise<ResolvedBlueprint> {
  let domainId = blueprint.domain_id;
  const criteria: ResolvedBlueprint["criteria"] = [];
  for (const crit of blueprint.criteria) {
    if (crit.node_id === undefined) {
      criteria.push({ category_id: crit.category_id!, type: crit.type, count: crit.count });
      continue;
    }
    const r = await client.query<{ kind: string; category_id: string | null; domain_id: string | null }>(
      `SELECT n.kind, c.id AS category_id, c.domain_id
         FROM taxonomy_nodes n
         LEFT JOIN categories c ON c.node_id = n.id
        WHERE n.id = $1
        ORDER BY c.created_at ASC
        LIMIT 1`,
      [crit.node_id],
    );
    const row = r.rows[0];
    if (row === undefined) {
      throw new ValidationError("blueprint node_id does not exist or is not visible to this organisation", {
        details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_UNRESOLVED, node_id: crit.node_id },
      });
    }
    if (row.kind !== "unit") {
      throw new ValidationError(`blueprint node_id must be a 'unit' node (got '${row.kind}')`, {
        details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_KIND_UNSUPPORTED, node_id: crit.node_id, kind: row.kind },
      });
    }
    if (row.category_id === null || row.domain_id === null) {
      throw new ValidationError("blueprint node_id has no category in this organisation", {
        details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_UNRESOLVED, node_id: crit.node_id },
      });
    }
    if (crit.category_id !== undefined && crit.category_id !== row.category_id) {
      throw new ValidationError("blueprint criterion category_id does not match its node_id", {
        details: {
          code: AL_ERROR_CODES.BLUEPRINT_NODE_MISMATCH,
          node_id: crit.node_id,
          category_id: crit.category_id,
          resolved_category_id: row.category_id,
        },
      });
    }
    domainId ??= row.domain_id;
    if (domainId !== row.domain_id) {
      throw new ValidationError("blueprint criteria resolve to more than one subject", {
        details: { code: AL_ERROR_CODES.BLUEPRINT_MIXED_DOMAINS, node_id: crit.node_id },
      });
    }
    criteria.push({ category_id: row.category_id, node_id: crit.node_id, type: crit.type, count: crit.count });
  }
  return { domain_id: domainId!, level: blueprint.level, criteria };
}

/** Entry used by create/update: no node_id anywhere = no extra query (legacy path untouched). */
export async function resolveBlueprint(
  tenantId: string,
  blueprint: AssessmentBlueprint,
): Promise<ResolvedBlueprint> {
  if (!blueprint.criteria.some((c) => c.node_id !== undefined)) {
    return blueprint as ResolvedBlueprint; // refine guarantees domain_id + category_id here
  }
  return withTenant(tenantId, (client) => resolveBlueprintNodes(client, blueprint));
}

/**
 * Resolve pack/level from blueprint + update assessment fields.
 * Calls findOrCreatePackForDomain (already Opus-reviewed, cross-tenant-guarded)
 * to get packId/levelIds, then returns the fields to persist.
 *
 * IMPORTANT: findOrCreatePackForDomain uses its own withTenant internally.
 * This is intentional — the resolver is designed as a standalone service call.
 * The resolved pack_id/level_id are then passed back into the caller's
 * withTenant scope for the INSERT/UPDATE.
 */
export async function resolveBlueprintPackLevel(
  tenantId: string,
  blueprint: ResolvedBlueprint,
  createdByUserId: string,
): Promise<{ packId: string; levelId: string; questionCount: number }> {
  const resolver = await findOrCreatePackForDomain(tenantId, blueprint.domain_id, createdByUserId);
  const levelId = resolver.levelIds[blueprint.level];
  const questionCount = blueprint.criteria.reduce((sum, c) => sum + c.count, 0);
  return { packId: resolver.packId, levelId, questionCount };
}

