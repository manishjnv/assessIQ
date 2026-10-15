import { type PoolClient } from "pg";
import { uuidv7, NotFoundError, ValidationError } from "@assessiq/core";
import { withSystemRole } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import { type SourcePackRow, type SourceLevelRow, type SourceQuestionRow, getPlatformTenantId } from "./helpers.js";
import { type CloneQuestionRow, type ResyncResult } from "./resync-types.js";
import { buildTaxonomyResolver, stableJson } from "./taxonomy.js";

export async function resyncClonedPack(
  client: PoolClient,
  sourcePackId: string,
  targetTenantId: string,
  actorUserId: string,
): Promise<ResyncResult> {
  const platformTenantId = await getPlatformTenantId(client);
  if (targetTenantId === platformTenantId) {
    throw new ValidationError("cannot re-sync within the platform organisation", {
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
    throw new NotFoundError(`Source question set not found: ${sourcePackId}`, {
      details: { code: "SOURCE_PACK_NOT_FOUND" },
    });
  }
  if (srcPack.tenant_id !== platformTenantId) {
    throw new ValidationError("source question set must be in the platform question bank", {
      details: { code: "SOURCE_NOT_PLATFORM" },
    });
  }
  if (srcPack.status !== "published") {
    throw new ValidationError("source question set must be published", {
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
              answer_guidance, knowledge_base_sources, domain_id, category_id
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
              level_id, points, topic, type, answer_guidance, domain_id, category_id
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
            rubric, answer_guidance, knowledge_base_sources, created_by, domain_id, category_id, source_question_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13, $14, $15)`,
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
          M.answer_guidance,
          JSON.stringify(Array.isArray(M.knowledge_base_sources) ? M.knowledge_base_sources : []),
          actorUserId,
          tax.domainId,
          tax.categoryId,
          M.id,
        ],
      );
      await client.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type)
         VALUES ($1, $2, 1, $3::jsonb, $4::jsonb, $5, $6)`,
        [uuidv7(), nqid, contentJson, rubricJson, actorUserId, M.type],
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
      stableJson(M.rubric) !== stableJson(Q.rubric) ||
      // N21: the type is frozen per version, so a type change must write a new version.
      Q.type !== M.type;
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
      Q.answer_guidance !== M.answer_guidance ||
      Q.status !== "active";

    if (contentChanged) {
      // Snapshot the NEW content at the clone question's CURRENT version, then
      // bump. New content becomes MAX(qv.version) for future attempts; the prior
      // snapshot (lower version) is untouched, so in-flight attempts pinned to it
      // keep the old content. Metadata is refreshed in the same UPDATE.
      await client.query(
        `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
        [uuidv7(), Q.id, Q.version, contentJson, rubricJson, actorUserId, M.type],
      );
      await client.query(
        `UPDATE questions
            SET content = $2::jsonb, rubric = $3::jsonb, level_id = $4,
                domain_id = $5, category_id = $6, points = $7, topic = $8,
                type = $9, status = 'active', version = $10,
                answer_guidance = $11, updated_at = now()
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
          M.answer_guidance,
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
                topic = $6, type = $7, answer_guidance = $8, status = 'active', updated_at = now()
          WHERE id = $1`,
        [Q.id, tgtLevelId, tax.domainId, tax.categoryId, M.points, M.topic, M.type, M.answer_guidance],
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
  return withSystemRole("platform pack resync into tenant", async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      tenantId,
      sourcePackId,
    ]);

    const result = await resyncClonedPack(client, sourcePackId, tenantId, actorUserId);

    if (result.updated) {
      // system read, then tenant-scoped write under assessiq_app in the same tx
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

    return result;
  });
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
  return withSystemRole("cross-tenant clone tenant list", async (client) => {
    const rows = (
      await client.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM question_packs
          WHERE source_pack_id = $1 AND status <> 'archived'`,
        [sourcePackId],
      )
    ).rows;
    return rows.map((r) => r.tenant_id);
  });
}
