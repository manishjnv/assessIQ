/**
 * Repository layer for the question_packs, levels, questions,
 * question_versions, tags, and question_tags tables.
 *
 * IMPORTANT — RLS-only scoping (CLAUDE.md hard rule #4):
 * Every query here runs through a PoolClient whose connection has already
 * received `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant',
 * $tenantId, true)` from withTenant(). Row-Level Security enforces tenant
 * isolation at the Postgres layer. Adding `WHERE tenant_id = $1` filters here
 * would mask RLS bugs — a misconfigured role with BYPASSRLS would still return
 * correct rows because of the WHERE, silently breaking the RLS guarantee.
 * Do NOT add tenant_id filters to any query in this file.
 *
 * Exception — question_packs and tags INSERT passes tenant_id:
 * Both tables have their own `tenant_id` column and a WITH CHECK RLS policy
 * that requires the inserted row's tenant_id to match app.current_tenant.
 * Passing tenant_id in the INSERT column list satisfies that constraint.
 * This is an RLS-enforced write constraint, not a filter.
 *
 * Child tables (levels, questions, question_versions, question_tags) have NO
 * `tenant_id` column at all. Their RLS policies derive tenancy through parent
 * FK chains:
 *   levels          → question_packs.tenant_id      (one-hop EXISTS)
 *   questions       → question_packs.tenant_id      (one-hop EXISTS via pack_id)
 *   question_versions → questions → question_packs  (two-hop EXISTS)
 *   question_tags   → questions → question_packs    (two-hop EXISTS)
 * There is therefore no tenant_id to pass in those INSERTs — the WITH CHECK
 * policies resolve authorization through the parent FK, not a direct column
 * match. Do not attempt to add tenant_id to those INSERT statements.
 */

import type { PoolClient } from "pg";
import type {
  AddLevelInput,
  CreatePackInput,
  CreateQuestionInput,
  Level,
  ListPacksInput,
  ListQuestionsInput,
  PackStatus,
  Question,
  QuestionPack,
  QuestionStatus,
  QuestionType,
  QuestionVersion,
  Tag,
  UpdateLevelPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const PACK_COLUMNS = `id, tenant_id, slug, name, domain, description, status, version, created_by, created_at, updated_at`;

const LEVEL_COLUMNS = `id, pack_id, position, label, description, duration_minutes, default_question_count, passing_score_pct`;

const QUESTION_COLUMNS = `id, pack_id, level_id, type, topic, points, status, version, content, rubric, created_by, created_at, updated_at`;

const QUESTION_VERSION_COLUMNS = `id, question_id, version, content, rubric, saved_by, saved_at`;

const TAG_COLUMNS = `id, tenant_id, name, category`;

// ---------------------------------------------------------------------------
// Row interfaces (raw Postgres types before mapping)
// ---------------------------------------------------------------------------

interface PackRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  domain: string;
  description: string | null;
  status: string;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface LevelRow {
  id: string;
  pack_id: string;
  position: number;
  label: string;
  description: string | null;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct: number;
}

interface QuestionRow {
  id: string;
  pack_id: string;
  level_id: string;
  type: string;
  topic: string;
  points: number;
  status: string;
  version: number;
  content: unknown;
  rubric: unknown | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface QuestionVersionRow {
  id: string;
  question_id: string;
  version: number;
  content: unknown;
  rubric: unknown | null;
  saved_by: string;
  saved_at: Date;
}

interface TagRow {
  id: string;
  tenant_id: string;
  name: string;
  category: string | null;
}

// ---------------------------------------------------------------------------
// Mapper functions
// ---------------------------------------------------------------------------

function mapPackRow(row: PackRow): QuestionPack {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    description: row.description,
    status: row.status as PackStatus,
    version: row.version,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapLevelRow(row: LevelRow): Level {
  return {
    id: row.id,
    pack_id: row.pack_id,
    position: row.position,
    label: row.label,
    description: row.description,
    duration_minutes: row.duration_minutes,
    default_question_count: row.default_question_count,
    passing_score_pct: row.passing_score_pct,
  };
}

function mapQuestionRow(row: QuestionRow): Question {
  return {
    id: row.id,
    pack_id: row.pack_id,
    level_id: row.level_id,
    type: row.type as QuestionType,
    topic: row.topic,
    points: row.points,
    status: row.status as QuestionStatus,
    version: row.version,
    content: row.content,
    rubric: row.rubric,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapQuestionVersionRow(row: QuestionVersionRow): QuestionVersion {
  return {
    id: row.id,
    question_id: row.question_id,
    version: row.version,
    content: row.content,
    rubric: row.rubric,
    saved_by: row.saved_by,
    saved_at: row.saved_at,
  };
}

function mapTagRow(row: TagRow): Tag {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    category: row.category,
  };
}

// ---------------------------------------------------------------------------
// Pack queries
// ---------------------------------------------------------------------------

export async function findPackById(
  client: PoolClient,
  id: string,
): Promise<QuestionPack | null> {
  const result = await client.query<PackRow>(
    `SELECT ${PACK_COLUMNS} FROM question_packs WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapPackRow(row) : null;
}

/**
 * Find a pack by (slug, version). Used by the importer to detect re-import
 * collisions — a pack with the same slug+version already exists in this tenant.
 */
export async function findPackBySlug(
  client: PoolClient,
  slug: string,
  version: number,
): Promise<QuestionPack | null> {
  const result = await client.query<PackRow>(
    `SELECT ${PACK_COLUMNS} FROM question_packs WHERE slug = $1 AND version = $2 LIMIT 1`,
    [slug, version],
  );
  const row = result.rows[0];
  return row !== undefined ? mapPackRow(row) : null;
}

export async function listPackRows(
  client: PoolClient,
  filters: ListPacksInput,
): Promise<{ items: QuestionPack[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (filters.domain !== undefined) {
    conditions.push(`domain = $${i}`);
    values.push(filters.domain);
    i++;
  }

  if (filters.status !== undefined) {
    conditions.push(`status = $${i}`);
    values.push(filters.status);
    i++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Separate count query against the same WHERE clause.
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM question_packs ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const dataResult = await client.query<PackRow>(
    `SELECT ${PACK_COLUMNS} FROM question_packs ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  return { items: dataResult.rows.map(mapPackRow), total };
}

export async function insertPack(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    domain: string;
    description?: string;
    createdBy: string;
  },
): Promise<QuestionPack> {
  // tenant_id is explicitly passed to satisfy the WITH CHECK RLS policy on
  // question_packs (requires inserted row's tenant_id = app.current_tenant).
  // status defaults to 'draft', version defaults to 1 per DB schema.
  const result = await client.query<PackRow>(
    `INSERT INTO question_packs (id, tenant_id, slug, name, domain, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PACK_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.slug,
      input.name,
      input.domain,
      input.description ?? null,
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertPack: INSERT returned no row");
  }
  return mapPackRow(row);
}

export async function updatePackRow(
  client: PoolClient,
  id: string,
  patch: {
    name?: string;
    domain?: string;
    description?: string | null;
    status?: PackStatus;
    version?: number;
  },
): Promise<QuestionPack> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i}`);
    values.push(patch.name);
    i++;
  }
  if (patch.domain !== undefined) {
    sets.push(`domain = $${i}`);
    values.push(patch.domain);
    i++;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) {
      sets.push(`description = NULL`);
    } else {
      sets.push(`description = $${i}`);
      values.push(patch.description);
      i++;
    }
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i}`);
    values.push(patch.status);
    i++;
  }
  if (patch.version !== undefined) {
    sets.push(`version = $${i}`);
    values.push(patch.version);
    i++;
  }

  sets.push(`updated_at = now()`);

  values.push(id);
  const result = await client.query<PackRow>(
    `UPDATE question_packs SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${PACK_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updatePack: no row found for id ${id}`);
  }
  return mapPackRow(row);
}

// ---------------------------------------------------------------------------
// Level queries
// ---------------------------------------------------------------------------

export async function findLevelById(
  client: PoolClient,
  id: string,
): Promise<Level | null> {
  const result = await client.query<LevelRow>(
    `SELECT ${LEVEL_COLUMNS} FROM levels WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapLevelRow(row) : null;
}

export async function listLevelsByPack(
  client: PoolClient,
  packId: string,
): Promise<Level[]> {
  const result = await client.query<LevelRow>(
    `SELECT ${LEVEL_COLUMNS} FROM levels WHERE pack_id = $1 ORDER BY position ASC`,
    [packId],
  );
  return result.rows.map(mapLevelRow);
}

export async function insertLevel(
  client: PoolClient,
  input: {
    id: string;
    packId: string;
    position: number;
    label: string;
    description?: string;
    durationMinutes: number;
    defaultQuestionCount: number;
    passingScorePct?: number;
  },
): Promise<Level> {
  // levels has no tenant_id column — the WITH CHECK RLS policy derives
  // authorization through the pack_id FK to question_packs. No tenant_id
  // is passed here and none should ever be added.
  const result = await client.query<LevelRow>(
    `INSERT INTO levels (id, pack_id, position, label, description, duration_minutes, default_question_count, passing_score_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${LEVEL_COLUMNS}`,
    [
      input.id,
      input.packId,
      input.position,
      input.label,
      input.description ?? null,
      input.durationMinutes,
      input.defaultQuestionCount,
      input.passingScorePct ?? 60,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertLevel: INSERT returned no row");
  }
  return mapLevelRow(row);
}

export async function updateLevelRow(
  client: PoolClient,
  id: string,
  patch: UpdateLevelPatch,
): Promise<Level> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.label !== undefined) {
    sets.push(`label = $${i}`);
    values.push(patch.label);
    i++;
  }
  if (patch.description !== undefined) {
    if (patch.description === null) {
      sets.push(`description = NULL`);
    } else {
      sets.push(`description = $${i}`);
      values.push(patch.description);
      i++;
    }
  }
  if (patch.duration_minutes !== undefined) {
    sets.push(`duration_minutes = $${i}`);
    values.push(patch.duration_minutes);
    i++;
  }
  if (patch.default_question_count !== undefined) {
    sets.push(`default_question_count = $${i}`);
    values.push(patch.default_question_count);
    i++;
  }
  if (patch.passing_score_pct !== undefined) {
    sets.push(`passing_score_pct = $${i}`);
    values.push(patch.passing_score_pct);
    i++;
  }

  if (sets.length === 0) {
    // Nothing to update — re-fetch and return current state.
    const existing = await findLevelById(client, id);
    if (existing === null) {
      throw new Error(`updateLevel: no row found for id ${id}`);
    }
    return existing;
  }

  values.push(id);
  const result = await client.query<LevelRow>(
    `UPDATE levels SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${LEVEL_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateLevel: no row found for id ${id}`);
  }
  return mapLevelRow(row);
}

// ---------------------------------------------------------------------------
// Question queries
// ---------------------------------------------------------------------------

export async function findQuestionById(
  client: PoolClient,
  id: string,
): Promise<Question | null> {
  const result = await client.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapQuestionRow(row) : null;
}

export async function listQuestionRows(
  client: PoolClient,
  filters: ListQuestionsInput,
): Promise<{ items: Question[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // When filtering by tag name we need the JOIN; build that join clause only
  // when required so untagged queries avoid the extra join overhead.
  const useTagJoin = filters.tag !== undefined;

  if (filters.pack_id !== undefined) {
    conditions.push(`q.pack_id = $${i}`);
    values.push(filters.pack_id);
    i++;
  }
  if (filters.level_id !== undefined) {
    conditions.push(`q.level_id = $${i}`);
    values.push(filters.level_id);
    i++;
  }
  if (filters.type !== undefined) {
    conditions.push(`q.type = $${i}`);
    values.push(filters.type);
    i++;
  }
  if (filters.status !== undefined) {
    conditions.push(`q.status = $${i}`);
    values.push(filters.status);
    i++;
  }
  if (filters.tag !== undefined) {
    // The JOIN to question_tags + tags is added below; here we bind the name.
    conditions.push(`t.name = $${i}`);
    values.push(filters.tag);
    i++;
  }
  if (filters.search !== undefined && filters.search.length > 0) {
    conditions.push(`lower(q.topic) LIKE lower($${i}) || '%'`);
    values.push(filters.search);
    i++;
  }

  const joinClause = useTagJoin
    ? `JOIN question_tags qt ON qt.question_id = q.id
       JOIN tags t ON t.id = qt.tag_id`
    : "";

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Separate count query.
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions q ${joinClause} ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  // Qualify all columns to avoid ambiguity when the tag JOIN is present.
  const dataResult = await client.query<QuestionRow>(
    `SELECT q.id, q.pack_id, q.level_id, q.type, q.topic, q.points, q.status,
            q.version, q.content, q.rubric, q.created_by, q.created_at, q.updated_at
     FROM questions q
     ${joinClause}
     ${where}
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  return { items: dataResult.rows.map(mapQuestionRow), total };
}

export async function insertQuestion(
  client: PoolClient,
  input: {
    id: string;
    packId: string;
    levelId: string;
    type: QuestionType;
    topic: string;
    points: number;
    content: unknown;
    rubric?: unknown;
    createdBy: string;
  },
): Promise<Question> {
  // questions has no tenant_id column — the WITH CHECK RLS policy derives
  // authorization through pack_id → question_packs.tenant_id. status defaults
  // to 'draft' per DB schema; content and rubric are stored as JSONB.
  const result = await client.query<QuestionRow>(
    `INSERT INTO questions (id, pack_id, level_id, type, topic, points, content, rubric, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     RETURNING ${QUESTION_COLUMNS}`,
    [
      input.id,
      input.packId,
      input.levelId,
      input.type,
      input.topic,
      input.points,
      JSON.stringify(input.content),
      input.rubric !== undefined ? JSON.stringify(input.rubric) : null,
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertQuestion: INSERT returned no row");
  }
  return mapQuestionRow(row);
}

export async function updateQuestionRow(
  client: PoolClient,
  id: string,
  patch: {
    topic?: string;
    points?: number;
    status?: QuestionStatus;
    content?: unknown;
    rubric?: unknown | null;
    version?: number;
  },
): Promise<Question> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.topic !== undefined) {
    sets.push(`topic = $${i}`);
    values.push(patch.topic);
    i++;
  }
  if (patch.points !== undefined) {
    sets.push(`points = $${i}`);
    values.push(patch.points);
    i++;
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i}`);
    values.push(patch.status);
    i++;
  }
  if (patch.content !== undefined) {
    sets.push(`content = $${i}::jsonb`);
    values.push(JSON.stringify(patch.content));
    i++;
  }
  if (patch.rubric !== undefined) {
    if (patch.rubric === null) {
      sets.push(`rubric = NULL`);
    } else {
      sets.push(`rubric = $${i}::jsonb`);
      values.push(JSON.stringify(patch.rubric));
      i++;
    }
  }
  // version is set explicitly by the service when bumping after a snapshot.
  if (patch.version !== undefined) {
    sets.push(`version = $${i}`);
    values.push(patch.version);
    i++;
  }

  sets.push(`updated_at = now()`);

  values.push(id);
  const result = await client.query<QuestionRow>(
    `UPDATE questions SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${QUESTION_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateQuestionRow: no row found for id ${id}`);
  }
  return mapQuestionRow(row);
}

/**
 * Bulk-activate every `status='draft'` question in a pack — the admin
 * "activate all" affordance that closes the question-status workflow gap
 * RCA'd 2026-05-02. `archived` questions are skipped (they were intentionally
 * pulled from circulation); `active` questions are skipped (already active,
 * idempotent). Returns the counts so the route layer can surface them to the
 * admin UI.
 *
 * No tenant_id filter is added — RLS scopes the UPDATE to the current tenant
 * via the JOIN through `question_packs.tenant_id`.
 */
export async function bulkActivateDraftQuestionsForPack(
  client: PoolClient,
  packId: string,
): Promise<{ activated: number; alreadyActive: number; archived: number }> {
  // First read counts so we can return the breakdown for the admin UI.
  const counts = await client.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM questions
     WHERE pack_id = $1
     GROUP BY status`,
    [packId],
  );
  let alreadyActive = 0;
  let archived = 0;
  for (const row of counts.rows) {
    if (row.status === "active") alreadyActive = parseInt(row.count, 10);
    else if (row.status === "archived") archived = parseInt(row.count, 10);
  }

  const result = await client.query(
    `UPDATE questions SET status = 'active', updated_at = now()
     WHERE pack_id = $1 AND status = 'draft'`,
    [packId],
  );
  return {
    activated: result.rowCount ?? 0,
    alreadyActive,
    archived,
  };
}

/**
 * Count questions belonging to a pack. Used by publishPack to confirm the
 * pack has at least one question before transitioning to 'published'.
 */
export async function countQuestionsInPack(
  client: PoolClient,
  packId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions WHERE pack_id = $1`,
    [packId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Return all questions in a pack ordered by creation time, used by publishPack
 * to snapshot every question into question_versions at publish time.
 */
export async function listAllQuestionsForPack(
  client: PoolClient,
  packId: string,
): Promise<Question[]> {
  const result = await client.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM questions WHERE pack_id = $1
     ORDER BY created_at ASC, id ASC`,
    [packId],
  );
  return result.rows.map(mapQuestionRow);
}

// ---------------------------------------------------------------------------
// Question version queries
// ---------------------------------------------------------------------------

export async function insertQuestionVersion(
  client: PoolClient,
  input: {
    id: string;
    questionId: string;
    version: number;
    content: unknown;
    rubric?: unknown;
    savedBy: string;
  },
): Promise<QuestionVersion> {
  // question_versions has no tenant_id column — the WITH CHECK RLS policy
  // derives authorization via question_id → questions.pack_id → question_packs.
  const result = await client.query<QuestionVersionRow>(
    `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING ${QUESTION_VERSION_COLUMNS}`,
    [
      input.id,
      input.questionId,
      input.version,
      JSON.stringify(input.content),
      input.rubric !== undefined ? JSON.stringify(input.rubric) : null,
      input.savedBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertQuestionVersion: INSERT returned no row");
  }
  return mapQuestionVersionRow(row);
}

export async function listQuestionVersions(
  client: PoolClient,
  questionId: string,
): Promise<QuestionVersion[]> {
  const result = await client.query<QuestionVersionRow>(
    `SELECT ${QUESTION_VERSION_COLUMNS} FROM question_versions
     WHERE question_id = $1
     ORDER BY version DESC`,
    [questionId],
  );
  return result.rows.map(mapQuestionVersionRow);
}

/**
 * Find a specific version snapshot by (questionId, version number).
 * Used by restoreVersion in the service to retrieve the historical content
 * before writing it back onto the live question row.
 */
export async function findQuestionVersion(
  client: PoolClient,
  questionId: string,
  version: number,
): Promise<QuestionVersion | null> {
  const result = await client.query<QuestionVersionRow>(
    `SELECT ${QUESTION_VERSION_COLUMNS} FROM question_versions
     WHERE question_id = $1 AND version = $2
     LIMIT 1`,
    [questionId, version],
  );
  const row = result.rows[0];
  return row !== undefined ? mapQuestionVersionRow(row) : null;
}

// ---------------------------------------------------------------------------
// Tag queries
// ---------------------------------------------------------------------------

/**
 * Find a tag by name within the current tenant context (RLS scopes to tenant).
 * Used by the importer and question creator to check existence before upserting.
 */
export async function findTagByName(
  client: PoolClient,
  name: string,
): Promise<Tag | null> {
  const result = await client.query<TagRow>(
    `SELECT ${TAG_COLUMNS} FROM tags WHERE name = $1 LIMIT 1`,
    [name],
  );
  const row = result.rows[0];
  return row !== undefined ? mapTagRow(row) : null;
}

export async function insertTag(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    name: string;
    category?: string;
  },
): Promise<Tag> {
  // tenant_id is explicitly passed to satisfy the WITH CHECK RLS policy on tags.
  const result = await client.query<TagRow>(
    `INSERT INTO tags (id, tenant_id, name, category)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TAG_COLUMNS}`,
    [input.id, input.tenantId, input.name, input.category ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertTag: INSERT returned no row");
  }
  return mapTagRow(row);
}

/**
 * Upsert a tag by (tenantId, name).
 *
 * A freshly minted id (uuidv7) is passed as the candidate key for new rows.
 * If the row already exists the ON CONFLICT branch fires and the EXISTING id
 * is preserved — the caller's passed id is NOT used for the returned row.
 * Callers should treat the returned tag.id as the authoritative id regardless
 * of whether the row was inserted or updated.
 *
 * `created` is true when a new row was inserted (xmax = 0 in Postgres means
 * the row has never been updated — i.e., it was just inserted).
 *
 * Two exported names point at this same function for caller-clarity:
 *   - `upsertTag(...)` — used when the caller doesn't need the created/reused
 *     distinction (createQuestion / updateQuestion paths).
 *   - `upsertTagWithStatus(...)` — used by bulkImport to count tags created
 *     vs reused for the ImportReport.
 */
export async function upsertTagWithStatus(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    name: string;
    category?: string;
  },
): Promise<{ tag: Tag; created: boolean }> {
  interface UpsertTagRow extends TagRow {
    inserted: number;
  }

  const result = await client.query<UpsertTagRow>(
    `WITH ins AS (
       INSERT INTO tags (id, tenant_id, name, category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name)
         DO UPDATE SET category = COALESCE(EXCLUDED.category, tags.category)
       RETURNING id, tenant_id, name, category, (xmax = 0)::int AS inserted
     )
     SELECT * FROM ins`,
    [input.id, input.tenantId, input.name, input.category ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("upsertTag: CTE returned no row");
  }
  return {
    tag: mapTagRow(row),
    created: row.inserted === 1,
  };
}

// Alias for callers that don't need the created/reused distinction.
export const upsertTag = upsertTagWithStatus;

export async function listTagsForQuestion(
  client: PoolClient,
  questionId: string,
): Promise<Tag[]> {
  const result = await client.query<TagRow>(
    `SELECT t.${TAG_COLUMNS.split(", ").join(", t.")}
     FROM tags t
     JOIN question_tags qt ON qt.tag_id = t.id
     WHERE qt.question_id = $1`,
    [questionId],
  );
  return result.rows.map(mapTagRow);
}

// ---------------------------------------------------------------------------
// Question-tag junction queries
// ---------------------------------------------------------------------------

/**
 * Attach a tag to a question. Idempotent — duplicate attach is silently
 * ignored via ON CONFLICT DO NOTHING.
 */
export async function attachTagToQuestion(
  client: PoolClient,
  questionId: string,
  tagId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO question_tags (question_id, tag_id)
     VALUES ($1, $2)
     ON CONFLICT (question_id, tag_id) DO NOTHING`,
    [questionId, tagId],
  );
}

/**
 * Remove all tag associations for a question.
 * Used by updateQuestion to atomically replace the tag set: detach-all first,
 * then attach the new set. This avoids needing a diff and is safe because the
 * whole operation runs within a single service-level transaction.
 */
export async function detachAllTagsFromQuestion(
  client: PoolClient,
  questionId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM question_tags WHERE question_id = $1`,
    [questionId],
  );
}

// ---------------------------------------------------------------------------
// Existence-check helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the `assessments` table exists in the public schema.
 *
 * archivePack needs to verify no published/active assessments reference the
 * pack before archiving. The assessments table is delivered in Phase 1 G1.B
 * (modules/05-assessment-lifecycle). Until that migration runs, this returns
 * false and archivePack skips the referential check. Once G1.B lands the table
 * exists and the check kicks in automatically — no code change required.
 */
export async function hasAssessmentsTable(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.assessments') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Count assessments in 'published' or 'active' status that reference the given
 * pack. Used by archivePack to block archiving a pack that is still in use.
 *
 * IMPORTANT: Callers MUST gate this with hasAssessmentsTable() first — calling
 * this function before the assessments table exists will throw a Postgres error.
 */
export async function countAssessmentsReferencingPack(
  client: PoolClient,
  packId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessments WHERE pack_id = $1 AND status IN ('published', 'active')`,
    [packId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}
