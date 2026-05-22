/**
 * modules/04-question-bank/src/clone.ts
 *
 * Clone-on-grant engine (Step 2 — question-set sharing).
 * See docs/design/question-set-sharing-clone-on-grant.md.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ READ THIS BEFORE EDITING — this file is the OPPOSITE of repository.ts.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 * repository.ts / service.ts run under `assessiq_app` with `app.current_tenant`
 * set; RLS scopes every query and tenant_id filters are FORBIDDEN there.
 *
 * `clonePackToTenant` runs under the **assessiq_system** role (BYPASSRLS),
 * inside the transaction owned by the Phase-3 grant handler. RLS does NOT scope
 * these queries. They are DELIBERATELY cross-tenant: they READ the platform
 * (source) tenant's published pack and WRITE copies into the company (target)
 * tenant. Therefore every query here MUST filter by tenant_id / id explicitly —
 * that is the correct, required pattern for THIS file (because RLS is bypassed).
 *
 * This is the ONE sanctioned cross-tenant WRITE path in the codebase. The
 * company never gains a cross-tenant READ at runtime — it only ever reads its
 * own cloned rows through normal RLS. Invariants enforced below:
 *   - source pack must live in the platform tenant (slug='platform') and be
 *     status='published'
 *   - target tenant must differ from the platform tenant
 *   - a question whose non-null domain/category cannot be remapped into the
 *     target tenant's own taxonomy is SKIPPED and counted — never attached to a
 *     foreign-tenant UUID (which would later fail blueprint FK validation)
 *
 * The clone copies DATA only; the audit row is written by the caller (Phase 3)
 * after it switches back to the app role, per the two-phase grant tx pattern.
 */

import { type PoolClient } from "pg";
import { uuidv7, NotFoundError, ValidationError, ConflictError } from "@assessiq/core";
import { getPool } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { QuestionType, QuestionStatus, LevelRubricDefaults, KnowledgeBaseSource } from "./types.js";

const MAX_SLUG_RETRIES = 10;

export interface ClonePackResult {
  /** id of the pack in the target (company) tenant. */
  clonedPackId: string;
  /** new clone slug in the target tenant. */
  clonedSlug: string;
  /** source platform pack version captured on the clone (provenance). */
  sourceVersion: number;
  /** questions actually copied. */
  questionCount: number;
  /** questions skipped because their domain/category has no match in the target tenant. */
  skippedCount: number;
  /** true when an existing clone of this source was reused (idempotent re-grant). */
  reusedExisting: boolean;
}

interface SourcePackRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  status: string;
  version: number;
}

interface SourceLevelRow {
  id: string;
  position: number;
  label: string;
  description: string | null;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct: number;
  rubric_defaults: LevelRubricDefaults | null;
}

interface SourceQuestionRow {
  id: string;
  level_id: string;
  type: QuestionType;
  topic: string;
  points: number;
  status: QuestionStatus;
  content: unknown;
  rubric: unknown | null;
  knowledge_base_sources: unknown;
  domain_id: string | null;
  category_id: string | null;
}

function uniqueNonNull(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((x): x is string => x !== null))];
}

/** Resolve the platform tenant (master library) by its well-known slug. */
async function getPlatformTenantId(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`,
  );
  const id = r.rows[0]?.id;
  if (id === undefined) {
    throw new ValidationError("platform tenant not found", {
      details: { code: "PLATFORM_TENANT_MISSING" },
    });
  }
  return id;
}

/**
 * Pick a collision-free slug `clone-<sourceSlug>[-N]` in the target tenant.
 *
 * Pre-computes a free slug from existing rows (single SELECT) rather than
 * catch-and-retry on a unique violation: this whole function runs inside the
 * caller's single transaction, where a Postgres error would abort the entire
 * tx (you cannot catch 23505 and continue). Concurrency is bounded by the
 * Phase-3 single-flight per (source_pack, target_tenant).
 */
async function deriveCloneSlug(
  client: PoolClient,
  targetTenantId: string,
  sourceSlug: string,
): Promise<string> {
  const base = `clone-${sourceSlug}`;
  const existing = new Set(
    (
      await client.query<{ slug: string }>(
        `SELECT slug FROM question_packs WHERE tenant_id = $1 AND slug LIKE $2`,
        [targetTenantId, `${base}%`],
      )
    ).rows.map((r) => r.slug),
  );
  if (!existing.has(base)) return base;
  for (let n = 2; n <= MAX_SLUG_RETRIES + 1; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ConflictError(
    `Could not derive a unique clone slug for '${sourceSlug}' in tenant ${targetTenantId}`,
    { details: { code: "CLONE_SLUG_EXHAUSTED" } },
  );
}

/**
 * Copy a published platform-library pack (+ its levels, questions, tags) into a
 * company tenant. MUST be called with `client` already in the `assessiq_system`
 * role inside the caller's transaction.
 *
 * Idempotent: if the target tenant already holds a clone of `sourcePackId`
 * (matched on question_packs.source_pack_id), that existing clone is returned
 * and nothing is copied again.
 */
export async function clonePackToTenant(
  client: PoolClient,
  sourcePackId: string,
  targetTenantId: string,
  actorUserId: string,
): Promise<ClonePackResult> {
  // ── Guards ────────────────────────────────────────────────────────────────
  const platformTenantId = await getPlatformTenantId(client);
  if (targetTenantId === platformTenantId) {
    throw new ValidationError("cannot clone a pack into the platform tenant", {
      details: { code: "CLONE_INTO_PLATFORM" },
    });
  }

  const srcPack = (
    await client.query<SourcePackRow>(
      `SELECT id, tenant_id, slug, name, domain, description, status, version
         FROM question_packs WHERE id = $1 LIMIT 1`,
      [sourcePackId],
    )
  ).rows[0];
  if (srcPack === undefined) {
    throw new NotFoundError(`Source pack not found: ${sourcePackId}`, {
      details: { code: "SOURCE_PACK_NOT_FOUND" },
    });
  }
  if (srcPack.tenant_id !== platformTenantId) {
    throw new ValidationError("source pack must be in the platform library", {
      details: { code: "SOURCE_NOT_PLATFORM" },
    });
  }
  if (srcPack.status !== "published") {
    throw new ValidationError("source pack must be published before it can be shared", {
      details: { code: "SOURCE_NOT_PUBLISHED" },
    });
  }

  // ── Idempotency: existing clone of this source in the target tenant? ───────
  const existingClone = (
    await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM question_packs
        WHERE tenant_id = $1 AND source_pack_id = $2 LIMIT 1`,
      [targetTenantId, sourcePackId],
    )
  ).rows[0];
  if (existingClone !== undefined) {
    const qc = (
      await client.query<{ count: string }>(
        `SELECT count(*) FROM questions WHERE pack_id = $1`,
        [existingClone.id],
      )
    ).rows[0];
    return {
      clonedPackId: existingClone.id,
      clonedSlug: existingClone.slug,
      sourceVersion: srcPack.version,
      questionCount: parseInt(qc?.count ?? "0", 10),
      skippedCount: 0,
      reusedExisting: true,
    };
  }

  // ── Read the source set ────────────────────────────────────────────────────
  const srcLevels = (
    await client.query<SourceLevelRow>(
      `SELECT id, position, label, description, duration_minutes,
              default_question_count, passing_score_pct, rubric_defaults
         FROM levels WHERE pack_id = $1 ORDER BY position ASC`,
      [sourcePackId],
    )
  ).rows;

  const srcQuestions = (
    await client.query<SourceQuestionRow>(
      `SELECT id, level_id, type, topic, points, status, content, rubric,
              knowledge_base_sources, domain_id, category_id
         FROM questions WHERE pack_id = $1 ORDER BY created_at ASC, id ASC`,
      [sourcePackId],
    )
  ).rows;

  // ── Build the taxonomy remap (by SLUG, never by UUID) ──────────────────────
  // Source domain/category id → slug (read from the PLATFORM tenant).
  const srcDomainSlugById = new Map<string, string>();
  const srcDomainIds = uniqueNonNull(srcQuestions.map((q) => q.domain_id));
  if (srcDomainIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string }>(
        // tenant_id filter is the ONLY isolation control here (system role
        // bypasses RLS) — pin the lookup to the platform tenant (review #4).
        `SELECT id, slug FROM domains WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcDomainIds, platformTenantId],
      )
    ).rows) {
      srcDomainSlugById.set(row.id, row.slug);
    }
  }
  const srcCatById = new Map<string, { slug: string; domainId: string }>();
  const srcCatIds = uniqueNonNull(srcQuestions.map((q) => q.category_id));
  if (srcCatIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string; domain_id: string }>(
        // Pin to the platform tenant — the only isolation control under the
        // system role (review #4).
        `SELECT id, slug, domain_id FROM categories WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcCatIds, platformTenantId],
      )
    ).rows) {
      srcCatById.set(row.id, { slug: row.slug, domainId: row.domain_id });
    }
  }

  // Target tenant: domain slug → id, and (domainId, categorySlug) → categoryId.
  const tgtDomainIdBySlug = new Map<string, string>();
  for (const row of (
    await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM domains WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtDomainIdBySlug.set(row.slug, row.id);
  }
  const tgtCatIdByKey = new Map<string, string>();
  for (const row of (
    await client.query<{ id: string; slug: string; domain_id: string }>(
      `SELECT id, slug, domain_id FROM categories WHERE tenant_id = $1`,
      [targetTenantId],
    )
  ).rows) {
    tgtCatIdByKey.set(`${row.domain_id}::${row.slug}`, row.id);
  }

  // ── Insert the cloned pack (published, with provenance) ────────────────────
  const newPackId = uuidv7();
  const clonedSlug = await deriveCloneSlug(client, targetTenantId, srcPack.slug);
  await client.query(
    `INSERT INTO question_packs
       (id, tenant_id, slug, name, domain, description, status, version, created_by, source_pack_id, source_version)
     VALUES ($1, $2, $3, $4, $5, $6, 'published', 1, $7, $8, $9)`,
    [
      newPackId,
      targetTenantId,
      clonedSlug,
      srcPack.name,
      srcPack.domain,
      srcPack.description,
      actorUserId,
      sourcePackId,
      srcPack.version,
    ],
  );

  // ── Insert levels; map sourceLevelId → newLevelId ──────────────────────────
  const levelIdMap = new Map<string, string>();
  for (const lvl of srcLevels) {
    const newLevelId = uuidv7();
    await client.query(
      `INSERT INTO levels
         (id, pack_id, position, label, description, duration_minutes,
          default_question_count, passing_score_pct, rubric_defaults)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        newLevelId,
        newPackId,
        lvl.position,
        lvl.label,
        lvl.description,
        lvl.duration_minutes,
        lvl.default_question_count,
        lvl.passing_score_pct,
        lvl.rubric_defaults !== null ? JSON.stringify(lvl.rubric_defaults) : null,
      ],
    );
    levelIdMap.set(lvl.id, newLevelId);
  }

  // ── Insert questions, remapping level + taxonomy; skip unresolvable ────────
  let questionCount = 0;
  let skippedCount = 0;
  for (const q of srcQuestions) {
    const newLevelId = levelIdMap.get(q.level_id);
    if (newLevelId === undefined) {
      // Question references a level that wasn't cloned — should not happen, but
      // never attach to a foreign level id.
      skippedCount++;
      continue;
    }

    // Remap taxonomy by slug. NULL domain → keep null (legacy/omnibus question,
    // still a valid question, just not blueprint-filterable).
    let newDomainId: string | null = null;
    let newCategoryId: string | null = null;
    if (q.domain_id !== null) {
      const domainSlug = srcDomainSlugById.get(q.domain_id);
      const resolvedDomainId =
        domainSlug !== undefined ? tgtDomainIdBySlug.get(domainSlug) : undefined;
      if (resolvedDomainId === undefined) {
        // Target tenant has no matching domain — cannot safely place this question.
        skippedCount++;
        continue;
      }
      newDomainId = resolvedDomainId;

      if (q.category_id !== null) {
        const srcCat = srcCatById.get(q.category_id);
        const resolvedCatId =
          srcCat !== undefined
            ? tgtCatIdByKey.get(`${resolvedDomainId}::${srcCat.slug}`)
            : undefined;
        if (resolvedCatId === undefined) {
          skippedCount++;
          continue;
        }
        newCategoryId = resolvedCatId;
      }
    }

    const newQuestionId = uuidv7();
    await client.query(
      `INSERT INTO questions
         (id, pack_id, level_id, type, topic, points, status, version, content,
          rubric, knowledge_base_sources, created_by, domain_id, category_id, source_question_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
      [
        newQuestionId,
        newPackId,
        newLevelId,
        q.type,
        q.topic,
        q.points,
        q.status,
        JSON.stringify(q.content),
        q.rubric !== null ? JSON.stringify(q.rubric) : null,
        JSON.stringify(Array.isArray(q.knowledge_base_sources) ? q.knowledge_base_sources : []),
        actorUserId,
        newDomainId,
        newCategoryId,
        q.id,
      ],
    );

    // Re-attach tags: upsert each source tag into the TARGET tenant, then link.
    const srcTags = (
      await client.query<{ name: string; category: string | null }>(
        `SELECT t.name, t.category FROM tags t
           JOIN question_tags qt ON qt.tag_id = t.id
          WHERE qt.question_id = $1`,
        [q.id],
      )
    ).rows;
    for (const tag of srcTags) {
      const tgtTagId = (
        await client.query<{ id: string }>(
          `INSERT INTO tags (id, tenant_id, name, category)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, name)
             DO UPDATE SET category = COALESCE(EXCLUDED.category, tags.category)
           RETURNING id`,
          [uuidv7(), targetTenantId, tag.name, tag.category],
        )
      ).rows[0];
      if (tgtTagId !== undefined) {
        await client.query(
          `INSERT INTO question_tags (question_id, tag_id)
           VALUES ($1, $2) ON CONFLICT (question_id, tag_id) DO NOTHING`,
          [newQuestionId, tgtTagId.id],
        );
      }
    }

    questionCount++;
  }

  return {
    clonedPackId: newPackId,
    clonedSlug,
    sourceVersion: srcPack.version,
    questionCount,
    skippedCount,
    reusedExisting: false,
  };
}

export interface MaterializeSetResult {
  clonedPackId: string;
  clonedSlug: string;
  reusedExisting: boolean;
  questionCount: number;
  skippedCount: number;
  /** The cloned pack's levels (id + position + label) — for level selection. */
  levels: Array<{ id: string; position: number; label: string }>;
}

/**
 * Transaction-owning wrapper for clone-on-use: opens its OWN connection, runs
 * `clonePackToTenant` under the `assessiq_system` role, audits the clone under
 * the app role (two-phase, only when a NEW clone was made), and returns the
 * cloned pack id + its levels so the caller can resolve a level selection.
 *
 * Idempotent: a second call for the same (source, target) reuses the existing
 * clone and writes no audit row. Called by 05-assessment-lifecycle
 * `createAssessmentFromSet` when a company assesses from a licensed platform set.
 * The CALLER is responsible for the license check (billing
 * `assertLicensedForSourcePack`) before invoking this.
 */
export async function materializeSetForTenant(
  sourcePackId: string,
  tenantId: string,
  actorUserId: string,
): Promise<MaterializeSetResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");

    // Serialize concurrent clone-on-use for the SAME (tenant, source): a burst of
    // POST /assessments/from-set could otherwise have two txns both observe "no
    // clone" and both INSERT (review #10). The xact advisory lock makes the
    // second caller wait until the first commits, then its idempotency SELECT
    // finds the clone and returns early. The 0085 partial UNIQUE index is the
    // structural backstop for any unlocked path.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      tenantId,
      sourcePackId,
    ]);

    const result = await clonePackToTenant(client, sourcePackId, tenantId, actorUserId);

    const levels = (
      await client.query<{ id: string; position: number; label: string }>(
        `SELECT id, position, label FROM levels WHERE pack_id = $1 ORDER BY position ASC`,
        [result.clonedPackId],
      )
    ).rows;

    // Phase B — audit under the app role + tenant GUC (auditInTx's required
    // context), only when a NEW clone was materialised (reuse changes nothing).
    if (!result.reusedExisting) {
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await auditInTx(client, {
        tenantId,
        actorKind: "user",
        actorUserId,
        action: "tenant.pack_cloned",
        entityType: "question_pack",
        entityId: result.clonedPackId,
        after: {
          source_pack_id: sourcePackId,
          source_version: result.sourceVersion,
          question_count: result.questionCount,
          skipped_count: result.skippedCount,
        },
      });
    }

    await client.query("COMMIT");
    return {
      clonedPackId: result.clonedPackId,
      clonedSlug: result.clonedSlug,
      reusedExisting: result.reusedExisting,
      questionCount: result.questionCount,
      skippedCount: result.skippedCount,
      levels,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
