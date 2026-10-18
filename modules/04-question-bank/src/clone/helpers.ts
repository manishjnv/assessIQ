import { type PoolClient } from "pg";
import { ValidationError, ConflictError } from "@assessiq/core";
import type { QuestionType, QuestionStatus, LevelRubricDefaults } from "../types.js";

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

export interface SourcePackRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  status: string;
  version: number;
}

export interface SourceLevelRow {
  id: string;
  position: number;
  label: string;
  description: string | null;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct: number;
  rubric_defaults: LevelRubricDefaults | null;
}

export interface SourceQuestionRow {
  id: string;
  level_id: string;
  type: QuestionType;
  topic: string;
  points: number;
  status: QuestionStatus;
  content: unknown;
  rubric: unknown | null;
  // Live (non-versioned) candidate hint — copied like topic/points.
  answer_guidance: string | null;
  knowledge_base_sources: unknown;
  domain_id: string | null;
  category_id: string | null;
}

export function uniqueNonNull(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((x): x is string => x !== null))];
}

/** SQL fragment: skip master questions whose rights were withdrawn (EXP-2). */
export const NOT_WITHDRAWN_SQL = `NOT EXISTS (SELECT 1 FROM question_source ws
  WHERE ws.question_id = questions.id AND ws.rights_status = 'withdrawn')`;

/**
 * EXP-2: copy the master question's provenance row and exam columns onto a fresh clone.
 * New row id and target tenant_id; origin, rights, source and licence fields are kept;
 * import_id and uploaded_by point at the master tenant, so they are not carried over.
 * A master with no source row (should not exist after 0194) clones as original_human/original.
 * review_state is copied as-is (same content): a clone keeps the state of its source (EXP-18 owner decision).
 * MUST run in the same system-role tx as the INSERT of the clone question.
 */
export async function copyQuestionSource(
  client: PoolClient,
  masterQuestionId: string,
  cloneQuestionId: string,
  targetTenantId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO question_source
       (tenant_id, question_id, origin, rights_status, source_ref, source_url, seed_ref, licence_id,
        source_difficulty_raw, content_hash, normalised_text_hash,
        pyq_year, pyq_date, pyq_shift, pyq_paper_code, pyq_qno)
     SELECT $3, $2, COALESCE(s.origin, 'original_human'), COALESCE(s.rights_status, 'original'),
            s.source_ref, s.source_url, s.seed_ref, s.licence_id, s.source_difficulty_raw,
            s.content_hash, s.normalised_text_hash,
            s.pyq_year, s.pyq_date, s.pyq_shift, s.pyq_paper_code, s.pyq_qno
       FROM questions m LEFT JOIN question_source s ON s.question_id = m.id
      WHERE m.id = $1
     ON CONFLICT (question_id) DO NOTHING`,
    [masterQuestionId, cloneQuestionId, targetTenantId],
  );
  await client.query(
    `UPDATE questions c
        SET difficulty_est = m.difficulty_est, review_state = m.review_state,
            language_primary = m.language_primary, content_i18n = m.content_i18n
       FROM questions m WHERE c.id = $2 AND m.id = $1`,
    [masterQuestionId, cloneQuestionId],
  );
}

/** Resolve the platform tenant (master library) by its well-known slug. */
export async function getPlatformTenantId(client: PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'platform' LIMIT 1`,
  );
  const id = r.rows[0]?.id;
  if (id === undefined) {
    throw new ValidationError("platform organisation not found", {
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
export async function deriveCloneSlug(
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
    `Could not derive a unique clone slug for '${sourceSlug}' in organisation ${targetTenantId}`,
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
