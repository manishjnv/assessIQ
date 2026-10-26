import { ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import type { PoolClient } from "pg";
import { findOrCreatePackForDomain } from "../../../04-question-bank/src/service.js";
import {
  nodeScopeArgs,
  taxonomyDrawPredicate,
  type NodeScope,
} from "../../../04-question-bank/src/taxonomy-nodes.js";
import { AL_ERROR_CODES } from "../types.js";
import { passesSectionTypeAndDifficulty } from "@assessiq/question-types";
import { levelAtSamePosition } from "./_shared.js";

interface PoolFact { type: string; difficulty_est: number | null }
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
  categoryId: string | undefined,
  type: string,
  node?: NodeScope,
): Promise<number> {
  if (node !== undefined) {
    const r = await client.query<{ count: string }>(
      `SELECT count(*) FROM questions q
       WHERE q.pack_id = $1 AND q.level_id = $2 AND q.type = $3 AND q.status = 'active'
         AND ${taxonomyDrawPredicate("q", "$4", "$5", "$6")}`,
      [packId, levelId, type, ...nodeScopeArgs(node)],
    );
    return parseInt(r.rows[0]?.count ?? "0", 10);
  }
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
  categoryId: string | undefined,
  type: string,
  limit: number,
  node?: NodeScope,
): Promise<unknown[]> {
  if (node !== undefined) {
    const r = await client.query(
      `SELECT q.id, q.topic, q.type, q.points FROM questions q
       WHERE q.pack_id = $1 AND q.level_id = $2 AND q.type = $3 AND q.status = 'active'
         AND ${taxonomyDrawPredicate("q", "$4", "$5", "$6")}
       ORDER BY q.created_at ASC, q.id ASC
       LIMIT $7`,
      [packId, levelId, type, ...nodeScopeArgs(node), limit],
    );
    return r.rows;
  }
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
  const distinctCategoryIds = [
    ...new Set(blueprint.criteria.map((c) => c.category_id).filter((c): c is string => c !== undefined)),
  ];
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
 * Z-122 / Z-123: settings.sections guard (writes only; old assessments are not re-checked).
 * Every section category_id must be a category of THIS tenant whose domain slug equals the pack's
 * subject (question_packs.domain). A section node_id must be a node visible to this tenant (RLS).
 * Runs inside the caller's tenant-scoped client, so a foreign-tenant id finds no row.
 */
export async function assertSectionCategoriesMatchPack(
  client: PoolClient,
  tenantId: string,
  packId: string,
  settings: unknown,
): Promise<void> {
  const raw = (settings as { sections?: unknown } | null | undefined)?.sections;
  if (!Array.isArray(raw) || raw.length === 0) return;
  const sections = raw as Array<{ name?: string; category_ids?: string[]; node_id?: string; pack_id?: string }>;
  if (!sections.some((s) => s.category_ids !== undefined || s.node_id !== undefined)) return;
  const subjects = new Map<string, string>(); // EXP-23: pack id -> subject (domain slug)
  const subjectOf = async (pid: string): Promise<string | null> => {
    if (!subjects.has(pid)) {
      const pr = await client.query<{ domain: string }>(`SELECT domain FROM question_packs WHERE id = $1 AND tenant_id = $2`, [pid, tenantId]);
      if (pr.rows.length === 0) return null;
      subjects.set(pid, pr.rows[0]!.domain);
    }
    return subjects.get(pid)!;
  };
  if ((await subjectOf(packId)) === null) return; // createAssessment reports the missing set itself
  const bad = (s: { name?: string }, what: string): ValidationError =>
    new ValidationError(`Section "${s.name ?? ""}": ${what}`, {
      details: { code: "INVALID_PARAM", param: "settings.sections" },
    });
  for (const s of sections) {
    const ids = [...new Set(s.category_ids ?? [])];
    const subject = await subjectOf(s.pack_id ?? packId);
    if (subject === null) throw bad(s, "the section question set does not exist or is not visible to this organisation");
    if (ids.length > 0) {
      const ok = await client.query<{ id: string }>(
        `SELECT c.id FROM categories c JOIN domains d ON d.id = c.domain_id
          WHERE c.id = ANY($1::uuid[]) AND c.tenant_id = $2 AND d.tenant_id = $2 AND d.slug = $3`,
        [ids, tenantId, subject],
      );
      if (ok.rows.length !== ids.length) throw bad(s, "a category is not from this pack's subject");
    }
    if (s.node_id !== undefined) {
      const n = await client.query(`SELECT 1 FROM taxonomy_nodes WHERE id = $1`, [s.node_id]);
      if (n.rows.length === 0) throw bad(s, "the topic node does not exist or is not visible to this organisation");
    }
  }
}

/**
 * Z-122: publish pre-flight. Counts each section's pool with the SAME filter the draw uses
 * (06 startAttempt: node_id by taxonomy descendants, else category_ids, else the whole pool).
 * Each section is counted on its own; overlap between sections and passage grouping are not modelled.
 */
export async function assertSectionPoolsFillable(
  client: PoolClient,
  packId: string,
  levelId: string,
  settings: unknown,
): Promise<void> {
  const raw = (settings as { sections?: unknown } | null | undefined)?.sections;
  if (!Array.isArray(raw)) return;
  for (const s of raw as Array<{ name?: string; category_ids?: string[]; node_id?: string; question_count?: number; pack_id?: string; allowed_types?: string[]; difficulty_min?: number; difficulty_max?: number }>) {
    if (s.question_count === undefined) continue;
    // EXP-23: a section with its own pack counts that pack's level at the assessment level's position.
    const sPack = s.pack_id ?? packId;
    const sLevel = sPack === packId ? levelId : await levelAtSamePosition(client, sPack, levelId);
    const base = `SELECT q.type, q.difficulty_est FROM questions q WHERE q.pack_id = $1 AND q.level_id = $2 AND q.status = 'active'`;
    if (sLevel === null) {
      throw new ValidationError(
        `Section "${s.name ?? ""}" has too few questions: 0 available, ${s.question_count} needed`,
        { details: { code: AL_ERROR_CODES.POOL_TOO_SMALL, section: s.name, available: 0, required: s.question_count } },
      );
    }
    const r =
      s.node_id !== undefined
        ? await client.query<PoolFact>(
            `${base} AND ${taxonomyDrawPredicate("q", "$3", "$4", "$5")}`,
            [sPack, sLevel, ...nodeScopeArgs({ nodeId: s.node_id })],
          )
        : s.category_ids !== undefined
          ? await client.query<PoolFact>(`${base} AND q.category_id = ANY($3::uuid[])`, [sPack, sLevel, s.category_ids])
          : await client.query<PoolFact>(base, [sPack, sLevel]);
    // CT-0: the same type and difficulty rule the draw applies (06 startAttempt), so publish cannot pass and the draw run short.
    const available = r.rows.filter((q) => passesSectionTypeAndDifficulty(s, q)).length;
    if (available < s.question_count) {
      throw new ValidationError(
        `Section "${s.name ?? ""}" has too few questions: ${available} available, ${s.question_count} needed`,
        { details: { code: AL_ERROR_CODES.POOL_TOO_SMALL, section: s.name, available, required: s.question_count } },
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
/** Z-43: a stored criterion with node_id and no category_id draws by taxonomy node. */
export function criterionNodeScope(c: ResolvedBlueprint["criteria"][number]): NodeScope | undefined {
  return c.category_id === undefined && c.node_id !== undefined
    ? { nodeId: c.node_id, difficultyMin: c.difficulty_min, difficultyMax: c.difficulty_max }
    : undefined;
}

const TAXONOMY_DRAW_KINDS: readonly string[] = ["subject", "unit", "outcome"];

/** A difficulty range only applies to a taxonomy-node draw; a category draw would silently drop it. */
const rangeNotSupported = (): ValidationError =>
  new ValidationError("difficulty_min/difficulty_max apply only to a taxonomy node criterion (no category)", {
    details: { code: AL_ERROR_CODES.BLUEPRINT_DIFFICULTY_INVALID },
  });

export async function resolveBlueprintNodes(
  client: PoolClient,
  blueprint: AssessmentBlueprint,
): Promise<ResolvedBlueprint> {
  let domainId = blueprint.domain_id;
  const criteria: ResolvedBlueprint["criteria"] = [];
  for (const crit of blueprint.criteria) {
    if (
      crit.difficulty_min !== undefined &&
      crit.difficulty_max !== undefined &&
      crit.difficulty_min > crit.difficulty_max
    ) {
      throw new ValidationError("blueprint difficulty_min must not be greater than difficulty_max", {
        details: {
          code: AL_ERROR_CODES.BLUEPRINT_DIFFICULTY_INVALID,
          difficulty_min: crit.difficulty_min,
          difficulty_max: crit.difficulty_max,
        },
      });
    }
    const hasRange = crit.difficulty_min !== undefined || crit.difficulty_max !== undefined;
    if (crit.node_id === undefined) {
      if (hasRange) throw rangeNotSupported();
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
    if (!TAXONOMY_DRAW_KINDS.includes(row.kind)) {
      throw new ValidationError(
        `blueprint node_id must be a 'subject', 'unit' or 'outcome' node (got '${row.kind}')`,
        { details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_KIND_UNSUPPORTED, node_id: crit.node_id, kind: row.kind } },
      );
    }
    if (row.kind !== "unit" || row.category_id === null || row.domain_id === null) {
      // Z-43: no category row for this node, so the criterion draws by taxonomy node.
      if (crit.category_id !== undefined) {
        throw new ValidationError("blueprint criterion category_id does not match its node_id", {
          details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_MISMATCH, node_id: crit.node_id, category_id: crit.category_id },
        });
      }
      // The pool must not be empty: an unlinked node would draw nothing.
      const scope = { nodeId: crit.node_id, difficultyMin: crit.difficulty_min, difficultyMax: crit.difficulty_max };
      const linked = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM questions q WHERE q.status = 'active' AND ${taxonomyDrawPredicate("q", "$1", "$2", "$3")}`,
        nodeScopeArgs(scope),
      );
      if (parseInt(linked.rows[0]?.n ?? "0", 10) === 0) {
        throw new ValidationError("blueprint node_id has no active questions linked to it or its children", {
          details: { code: AL_ERROR_CODES.BLUEPRINT_NODE_EMPTY, node_id: crit.node_id, kind: row.kind },
        });
      }
      criteria.push({
        node_id: crit.node_id,
        type: crit.type,
        count: crit.count,
        ...(crit.difficulty_min !== undefined ? { difficulty_min: crit.difficulty_min } : {}),
        ...(crit.difficulty_max !== undefined ? { difficulty_max: crit.difficulty_max } : {}),
      });
      continue;
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
    if (hasRange) throw rangeNotSupported();
    criteria.push({ category_id: row.category_id, node_id: crit.node_id, type: crit.type, count: crit.count });
  }
  if (domainId === undefined) {
    throw new ValidationError("blueprint domain_id is required when no criterion resolves to a subject category", {
      details: { code: AL_ERROR_CODES.BLUEPRINT_DOMAIN_REQUIRED },
    });
  }
  // Z-51: keep the optional whole-test fields when a node_id criterion is resolved.
  return {
    domain_id: domainId,
    level: blueprint.level,
    criteria,
    ...(blueprint.whole_test_minutes !== undefined ? { whole_test_minutes: blueprint.whole_test_minutes } : {}),
    ...(blueprint.marks_per_question !== undefined ? { marks_per_question: blueprint.marks_per_question } : {}),
  };
}

/** Entry used by create/update: no node_id anywhere = no extra query (legacy path untouched). */
export async function resolveBlueprint(
  tenantId: string,
  blueprint: AssessmentBlueprint,
): Promise<ResolvedBlueprint> {
  if (!blueprint.criteria.some((c) => c.node_id !== undefined || c.difficulty_min !== undefined || c.difficulty_max !== undefined)) {
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

