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
    // version=2 + a question_versions snapshot at version=1 — this mirrors the
    // exact end-state publishPack leaves a normal active question in (snapshot at
    // v1, bump version to 2; attempt-start pins to MAX(qv.version)=1). A clone
    // copies the master's CURRENT (latest-published) content, so v1 holds it.
    // WITHOUT this snapshot, the attempt-start pool query — which INNER JOINs
    // question_versions — would EXCLUDE every cloned question and a candidate
    // could never start an attempt on a cloned-pack assessment.
    await client.query(
      `INSERT INTO questions
         (id, pack_id, level_id, type, topic, points, status, version, content,
          rubric, knowledge_base_sources, created_by, domain_id, category_id, source_question_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 2, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
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
    // The v1 content snapshot the attempt engine resolves via MAX(qv.version).
    await client.query(
      `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
       VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5)`,
      [
        uuidv7(),
        newQuestionId,
        JSON.stringify(q.content),
        q.rubric !== null ? JSON.stringify(q.rubric) : null,
        actorUserId,
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

// ===========================================================================
// B3 — Re-sync an existing clone with a newer master version (in-place refresh)
// ===========================================================================
//
// MODEL (decided 2026-05-25): a re-sync refreshes the clone's CONTENT in place.
// Future attempts on any assessment using this clone pick up the refreshed
// content; IN-FLIGHT/COMPLETED attempts are never disturbed (their
// `attempt_questions` snapshot is frozen at a specific question_versions row).
// This is behaviourally identical to an admin editing the pack's questions —
// the platform never version-pins a published assessment at attempt-start; it
// always serves the latest committed snapshot (MAX(qv.version)) of active
// questions. So re-sync deliberately does NOT try to keep old published
// assessments on old content for new attempts (that would require an attempt-
// engine rewrite and isn't how the platform works anywhere).
//
// Matching is by `questions.source_question_id` (master question id, recorded at
// clone time). For each master ACTIVE question:
//   - new (no clone match) → INSERT (version=2 + qv{v1}), taxonomy-remapped.
//   - changed content/rubric → version-bump: INSERT qv at the clone question's
//     CURRENT version holding the NEW content, then bump questions.version. The
//     new content becomes MAX(qv.version) (future attempts); the prior snapshot
//     stays untouched (in-flight attempts keep it).
//   - unchanged → left alone (no version churn); reactivated if it had been archived.
// Clone questions whose master source is gone from the active set → archived.
// Finally bump question_packs.version and set source_version = master.version.

interface CloneQuestionRow {
  id: string;
  source_question_id: string | null;
  content: unknown;
  rubric: unknown | null;
  version: number;
  status: string;
  // Live (non-versioned) metadata — read so re-sync can detect and apply
  // metadata-only master changes (level move, taxonomy change, points/topic/type)
  // that don't alter content/rubric. These fields live on the questions row, not
  // in question_versions, so updating them needs no version bump.
  level_id: string;
  points: number;
  topic: string;
  type: QuestionType;
  domain_id: string | null;
  category_id: string | null;
}

export interface ResyncResult {
  clonePackId: string;
  /** false when the clone was already at/above the master version (no-op). */
  updated: boolean;
  /** clone.source_version before the re-sync. */
  fromVersion: number;
  /** master version the clone is now synced to. */
  toVersion: number;
  added: number;
  changed: number;
  archived: number;
  skipped: number;
  /** the clone pack's new version after the bump. */
  newPackVersion: number;
}

/**
 * Build a taxonomy resolver (master domain/category id → target tenant id) by
 * SLUG — same semantics as clonePackToTenant: a non-null domain that has no
 * matching target domain (or a non-null category with no match) is unresolvable
 * and the question is skipped. MUST run under assessiq_system (reads platform +
 * target across tenants).
 */
async function buildTaxonomyResolver(
  client: PoolClient,
  platformTenantId: string,
  targetTenantId: string,
  srcQuestions: Array<{ domain_id: string | null; category_id: string | null }>,
): Promise<
  (
    domainId: string | null,
    categoryId: string | null,
  ) => { ok: true; domainId: string | null; categoryId: string | null } | { ok: false }
> {
  const srcDomainSlugById = new Map<string, string>();
  const srcDomainIds = uniqueNonNull(srcQuestions.map((q) => q.domain_id));
  if (srcDomainIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM domains WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcDomainIds, platformTenantId],
      )
    ).rows) {
      srcDomainSlugById.set(row.id, row.slug);
    }
  }
  const srcCatSlugById = new Map<string, string>();
  const srcCatIds = uniqueNonNull(srcQuestions.map((q) => q.category_id));
  if (srcCatIds.length > 0) {
    for (const row of (
      await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM categories WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [srcCatIds, platformTenantId],
      )
    ).rows) {
      srcCatSlugById.set(row.id, row.slug);
    }
  }
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

  return (domainId, categoryId) => {
    if (domainId === null) return { ok: true, domainId: null, categoryId: null };
    const dslug = srcDomainSlugById.get(domainId);
    const tgtDom = dslug !== undefined ? tgtDomainIdBySlug.get(dslug) : undefined;
    if (tgtDom === undefined) return { ok: false };
    if (categoryId === null) return { ok: true, domainId: tgtDom, categoryId: null };
    const cslug = srcCatSlugById.get(categoryId);
    const tgtCat = cslug !== undefined ? tgtCatIdByKey.get(`${tgtDom}::${cslug}`) : undefined;
    if (tgtCat === undefined) return { ok: false };
    return { ok: true, domainId: tgtDom, categoryId: tgtCat };
  };
}

/** Stable JSON for content/rubric equality (jsonb returns key-sorted objects). */
function stableJson(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/**
 * In-place content refresh of an existing clone from its (newer) master version.
 * MUST be called with `client` already in the `assessiq_system` role inside the
 * caller's transaction. Idempotent: if the clone is already at/above the master
 * version it returns `updated:false` and writes nothing.
 */
export async function resyncClonedPack(
  client: PoolClient,
  sourcePackId: string,
  targetTenantId: string,
  actorUserId: string,
): Promise<ResyncResult> {
  const platformTenantId = await getPlatformTenantId(client);
  if (targetTenantId === platformTenantId) {
    throw new ValidationError("cannot re-sync within the platform tenant", {
      details: { code: "RESYNC_IN_PLATFORM" },
    });
  }

  // ── Master (source) pack — must be platform + published ────────────────────
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
    throw new ValidationError("source pack must be published", {
      details: { code: "SOURCE_NOT_PUBLISHED" },
    });
  }

  // ── The clone in the target tenant ──────────────────────────────────────────
  const clone = (
    await client.query<{ id: string; source_version: number | null; version: number }>(
      `SELECT id, source_version, version FROM question_packs
        WHERE tenant_id = $1 AND source_pack_id = $2 LIMIT 1`,
      [targetTenantId, sourcePackId],
    )
  ).rows[0];
  if (clone === undefined) {
    throw new NotFoundError("no clone of this set exists in your workspace", {
      details: { code: "CLONE_NOT_FOUND" },
    });
  }

  const fromVersion = clone.source_version ?? 0;
  if (fromVersion >= srcPack.version) {
    // Already current — no-op.
    return {
      clonePackId: clone.id,
      updated: false,
      fromVersion,
      toVersion: srcPack.version,
      added: 0,
      changed: 0,
      archived: 0,
      skipped: 0,
      newPackVersion: clone.version,
    };
  }

  // ── Read master levels + ACTIVE questions ───────────────────────────────────
  const srcLevels = (
    await client.query<SourceLevelRow>(
      `SELECT id, position, label, description, duration_minutes,
              default_question_count, passing_score_pct, rubric_defaults
         FROM levels WHERE pack_id = $1 ORDER BY position ASC`,
      [sourcePackId],
    )
  ).rows;
  const srcLevelPosById = new Map<string, number>();
  for (const l of srcLevels) srcLevelPosById.set(l.id, l.position);

  const srcQuestions = (
    await client.query<SourceQuestionRow>(
      `SELECT id, level_id, type, topic, points, status, content, rubric,
              knowledge_base_sources, domain_id, category_id
         FROM questions WHERE pack_id = $1 AND status = 'active'
        ORDER BY created_at ASC, id ASC`,
      [sourcePackId],
    )
  ).rows;

  // ── Ensure clone levels exist (match by position) + refresh their metadata ──
  const cloneLevels = (
    await client.query<{ id: string; position: number }>(
      `SELECT id, position FROM levels WHERE pack_id = $1`,
      [clone.id],
    )
  ).rows;
  const cloneLevelIdByPos = new Map<number, string>();
  for (const l of cloneLevels) cloneLevelIdByPos.set(l.position, l.id);
  for (const lvl of srcLevels) {
    const existingId = cloneLevelIdByPos.get(lvl.position);
    const rubric = lvl.rubric_defaults !== null ? JSON.stringify(lvl.rubric_defaults) : null;
    if (existingId === undefined) {
      const newLevelId = uuidv7();
      await client.query(
        `INSERT INTO levels
           (id, pack_id, position, label, description, duration_minutes,
            default_question_count, passing_score_pct, rubric_defaults)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          newLevelId,
          clone.id,
          lvl.position,
          lvl.label,
          lvl.description,
          lvl.duration_minutes,
          lvl.default_question_count,
          lvl.passing_score_pct,
          rubric,
        ],
      );
      cloneLevelIdByPos.set(lvl.position, newLevelId);
    } else {
      await client.query(
        `UPDATE levels SET label=$2, description=$3, duration_minutes=$4,
                default_question_count=$5, passing_score_pct=$6, rubric_defaults=$7::jsonb
          WHERE id=$1`,
        [
          existingId,
          lvl.label,
          lvl.description,
          lvl.duration_minutes,
          lvl.default_question_count,
          lvl.passing_score_pct,
          rubric,
        ],
      );
    }
  }

  // ── Taxonomy resolver + existing clone questions keyed by source ────────────
  const resolveTaxonomy = await buildTaxonomyResolver(
    client,
    platformTenantId,
    targetTenantId,
    srcQuestions,
  );

  const cloneQs = (
    await client.query<CloneQuestionRow>(
      `SELECT id, source_question_id, content, rubric, version, status,
              level_id, points, topic, type, domain_id, category_id
         FROM questions WHERE pack_id = $1`,
      [clone.id],
    )
  ).rows;
  const cloneBySource = new Map<string, CloneQuestionRow>();
  for (const cq of cloneQs) {
    if (cq.source_question_id !== null) cloneBySource.set(cq.source_question_id, cq);
  }

  const masterIds = new Set<string>();
  let added = 0;
  let changed = 0;
  let archived = 0;
  let skipped = 0;

  for (const M of srcQuestions) {
    masterIds.add(M.id);

    const pos = srcLevelPosById.get(M.level_id);
    const tgtLevelId = pos !== undefined ? cloneLevelIdByPos.get(pos) : undefined;
    if (tgtLevelId === undefined) {
      skipped++;
      continue;
    }
    const tax = resolveTaxonomy(M.domain_id, M.category_id);
    if (!tax.ok) {
      skipped++;
      continue;
    }

    const Q = cloneBySource.get(M.id);
    const contentJson = JSON.stringify(M.content);
    const rubricJson = M.rubric !== null ? JSON.stringify(M.rubric) : null;

    if (Q === undefined) {
      // ── NEW master question → insert (version=2 + qv{v1}) ──
      const nqid = uuidv7();
      await client.query(
        `INSERT INTO questions
           (id, pack_id, level_id, type, topic, points, status, version, content,
            rubric, knowledge_base_sources, created_by, domain_id, category_id, source_question_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
        [
          nqid,
          clone.id,
          tgtLevelId,
          M.type,
          M.topic,
          M.points,
          M.status,
          contentJson,
          rubricJson,
          JSON.stringify(Array.isArray(M.knowledge_base_sources) ? M.knowledge_base_sources : []),
          actorUserId,
          tax.domainId,
          tax.categoryId,
          M.id,
        ],
      );
      await client.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
         VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5)`,
        [uuidv7(), nqid, contentJson, rubricJson, actorUserId],
      );
      // Tags (mirror clonePackToTenant): upsert source tags into target, link.
      const srcTags = (
        await client.query<{ name: string; category: string | null }>(
          `SELECT t.name, t.category FROM tags t
             JOIN question_tags qt ON qt.tag_id = t.id
            WHERE qt.question_id = $1`,
          [M.id],
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
            [nqid, tgtTagId.id],
          );
        }
      }
      added++;
      continue;
    }

    // ── EXISTING clone question ──
    const contentChanged =
      stableJson(M.content) !== stableJson(Q.content) ||
      stableJson(M.rubric) !== stableJson(Q.rubric);
    // Metadata lives on the live questions row (not in question_versions), so a
    // metadata-only master change must still be applied — otherwise the clone
    // goes stale (wrong level/taxonomy/points/type) yet source_version still
    // advances and future re-syncs no-op. Metadata needs NO version bump.
    const metadataChanged =
      Q.level_id !== tgtLevelId ||
      Q.domain_id !== tax.domainId ||
      Q.category_id !== tax.categoryId ||
      Q.points !== M.points ||
      Q.topic !== M.topic ||
      Q.type !== M.type ||
      Q.status !== "active";

    if (contentChanged) {
      // Snapshot the NEW content at the clone question's CURRENT version, then
      // bump. New content becomes MAX(qv.version) for future attempts; the prior
      // snapshot (lower version) is untouched, so in-flight attempts pinned to it
      // keep the old content. Metadata is refreshed in the same UPDATE.
      await client.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [uuidv7(), Q.id, Q.version, contentJson, rubricJson, actorUserId],
      );
      await client.query(
        `UPDATE questions
            SET content = $2::jsonb, rubric = $3::jsonb, level_id = $4,
                domain_id = $5, category_id = $6, points = $7, topic = $8,
                type = $9, status = 'active', version = $10, updated_at = now()
          WHERE id = $1`,
        [
          Q.id,
          contentJson,
          rubricJson,
          tgtLevelId,
          tax.domainId,
          tax.categoryId,
          M.points,
          M.topic,
          M.type,
          Q.version + 1,
        ],
      );
      changed++;
    } else if (metadataChanged) {
      // Content/rubric identical but level/taxonomy/points/topic/type changed
      // upstream (or it had been archived and master still ships it active).
      // Apply metadata to the live row; NO version bump (content snapshot stands).
      await client.query(
        `UPDATE questions
            SET level_id = $2, domain_id = $3, category_id = $4, points = $5,
                topic = $6, type = $7, status = 'active', updated_at = now()
          WHERE id = $1`,
        [Q.id, tgtLevelId, tax.domainId, tax.categoryId, M.points, M.topic, M.type],
      );
      changed++;
    }
    // else: fully unchanged (content + metadata) → leave untouched (no churn).
  }

  // ── Archive clone questions whose master source is gone from the active set ─
  for (const cq of cloneQs) {
    if (
      cq.source_question_id !== null &&
      !masterIds.has(cq.source_question_id) &&
      cq.status === "active"
    ) {
      await client.query(
        `UPDATE questions SET status = 'archived', updated_at = now() WHERE id = $1`,
        [cq.id],
      );
      archived++;
    }
  }

  // ── Bump the clone pack version + record the new source_version ─────────────
  const newPackVersion = clone.version + 1;
  await client.query(
    `UPDATE question_packs SET version = $2, source_version = $3, updated_at = now() WHERE id = $1`,
    [clone.id, newPackVersion, srcPack.version],
  );

  return {
    clonePackId: clone.id,
    updated: true,
    fromVersion,
    toVersion: srcPack.version,
    added,
    changed,
    archived,
    skipped,
    newPackVersion,
  };
}

/**
 * Transaction-owning wrapper for re-sync: opens its own connection, runs
 * `resyncClonedPack` under `assessiq_system`, and audits under the app role
 * (two-phase) only when something actually changed. Serialised per
 * (tenant, source) with the same advisory lock as materializeSetForTenant so a
 * re-sync can't race a concurrent clone-on-use of the same source. The CALLER
 * must perform the billing license check before invoking this.
 */
export async function resyncSetForTenant(
  sourcePackId: string,
  tenantId: string,
  actorUserId: string,
  // ADDITIVE: defaults to "user" so the existing manual-Update endpoint caller
  // is unchanged. The publish-time auto-sync push (autoSyncClonesForPack) passes
  // "system" so the clone tenant's audit row reads as an automated platform push
  // rather than a tenant-admin click, while still attributing the triggering
  // super_admin via actor_user_id.
  actorKind: "user" | "system" = "user",
): Promise<ResyncResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      tenantId,
      sourcePackId,
    ]);

    const result = await resyncClonedPack(client, sourcePackId, tenantId, actorUserId);

    if (result.updated) {
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await auditInTx(client, {
        tenantId,
        actorKind,
        actorUserId,
        action: "tenant.pack_resynced",
        entityType: "question_pack",
        entityId: result.clonePackId,
        after: {
          source_pack_id: sourcePackId,
          from_version: result.fromVersion,
          to_version: result.toVersion,
          added: result.added,
          changed: result.changed,
          archived: result.archived,
          skipped: result.skipped,
          new_pack_version: result.newPackVersion,
        },
      });
    }

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Enumerate every tenant that holds a (non-archived) clone of a platform source
 * pack. Cross-tenant read → runs under assessiq_system (BYPASSRLS) in its own
 * short transaction, then releases the connection before the caller loops
 * per-tenant re-syncs (each opens its own connection). Used by the publish-time
 * auto-sync push (autoSyncClonesForPack in service.ts). DISTINCT defends against
 * the (unique-index-prevented) possibility of more than one clone per tenant.
 */
export async function listCloneTenantIdsForSource(sourcePackId: string): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const rows = (
      await client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM question_packs
          WHERE source_pack_id = $1 AND status <> 'archived'`,
        [sourcePackId],
      )
    ).rows;
    await client.query("COMMIT");
    return rows.map((r) => r.tenant_id);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
