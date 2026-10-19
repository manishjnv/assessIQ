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
  KnowledgeBaseSource,
  Level,
  LevelRubricDefaults,
  ListPacksInput,
  ListQuestionsInput,
  QuestionFacets,
  FacetCount,
  FacetNodeCount,
  PackListItem,
  PackStatus,
  Question,
  QuestionOrigin,
  QuestionPack,
  QuestionSource,
  QuestionStatus,
  ReviewState,
  RightsStatus,
  QuestionType,
  QuestionVersion,
  Tag,
  UpdateLevelPatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const PACK_COLUMNS = `id, tenant_id, slug, name, domain, description, status, version, created_by, created_at, updated_at`;

const LEVEL_COLUMNS = `id, pack_id, position, label, description, duration_minutes, default_question_count, passing_score_pct, rubric_defaults`;

const QUESTION_COLUMNS = `id, pack_id, level_id, type, topic, points, negative_marks, status, version, content, rubric, answer_guidance, knowledge_base_sources, created_by, created_at, updated_at, domain_id, category_id, cognitive_level, nice_task_id, difficulty_params, attack_technique, difficulty_est, review_state, language_primary, content_i18n`;

const QUESTION_VERSION_COLUMNS = `id, question_id, version, content, rubric, saved_by, saved_at`; // N21: `type` is frozen per version but not surfaced here

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

/** PackRow plus the derived count columns from the list query. */
interface PackListRow extends PackRow {
  question_count: number;
  level_count: number;
}

/**
 * Attempt statuses that count as "the candidate finished" for the
 * completed-attempts column on the Question Bank grid. Mirrors the terminal /
 * post-submission states in the attempts CHECK constraint
 * (modules/06-attempt-engine/migrations/0030_attempts.sql); excludes draft,
 * in_progress, and cancelled.
 */
const COMPLETED_ATTEMPT_STATUSES = [
  "submitted",
  "auto_submitted",
  "pending_admin_grading",
  "graded",
  "released",
] as const;

interface LevelRow {
  id: string;
  pack_id: string;
  position: number;
  label: string;
  description: string | null;
  duration_minutes: number;
  default_question_count: number;
  passing_score_pct: number;
  rubric_defaults: LevelRubricDefaults | null;
}

interface QuestionRow {
  id: string;
  pack_id: string;
  level_id: string;
  type: string;
  topic: string;
  points: number;
  /** NUMERIC(6,2): pg returns a string. */
  negative_marks?: string | number | null;
  status: string;
  version: number;
  content: unknown;
  rubric: unknown | null;
  answer_guidance: string | null;
  knowledge_base_sources: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  domain_id: string | null;
  category_id: string | null;
  /** FU-C13: difficulty tags (migration 0086); NULL on human-authored rows. */
  cognitive_level?: string | null;
  nice_task_id?: string | null;
  difficulty_params?: unknown;
  attack_technique?: string[] | null;
  /** EXP-2 (migration 0194). */
  difficulty_est?: number | null;
  review_state?: string | null;
  language_primary?: string;
  content_i18n?: unknown;
  /** Resolved from the parent level row by list projections; absent on single reads. */
  level_label?: string | null;
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
    rubric_defaults: row.rubric_defaults ?? null,
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
    negative_marks: row.negative_marks === null || row.negative_marks === undefined ? null : Number(row.negative_marks),
    status: row.status as QuestionStatus,
    version: row.version,
    content: row.content,
    rubric: row.rubric,
    level_label: row.level_label ?? null,
    answer_guidance: row.answer_guidance ?? null,
    knowledge_base_sources: Array.isArray(row.knowledge_base_sources)
      ? (row.knowledge_base_sources as KnowledgeBaseSource[])
      : [],
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    domain_id: row.domain_id ?? null,
    category_id: row.category_id ?? null,
    cognitive_level: (row.cognitive_level as Question["cognitive_level"]) ?? null,
    nice_task_id: row.nice_task_id ?? null,
    difficulty_params:
      row.difficulty_params !== null && typeof row.difficulty_params === "object"
        ? (row.difficulty_params as Record<string, unknown>)
        : null,
    attack_technique: Array.isArray(row.attack_technique) ? row.attack_technique : null,
    difficulty_est: row.difficulty_est ?? null,
    review_state: (row.review_state as Question["review_state"]) ?? null,
    language_primary: row.language_primary ?? "en",
    content_i18n:
      row.content_i18n !== null && typeof row.content_i18n === "object"
        ? (row.content_i18n as Record<string, unknown>)
        : null,
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

/**
 * True when both the attempts (module 06) and assessments (module 05) tables
 * exist — required before the completed-attempts join in listPackRows. Mirrors
 * the defensive pattern of hasAssessmentsTable so a question-bank-only test
 * schema (no lifecycle/attempt migrations) degrades to completed_count = 0
 * instead of throwing a "relation does not exist" error.
 */
export async function attemptCompletionsQueryable(
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('public.attempts') IS NOT NULL
        AND to_regclass('public.assessments') IS NOT NULL AS ok`,
  );
  return result.rows[0]?.ok ?? false;
}

export async function listPackRows(
  client: PoolClient,
  filters: ListPacksInput,
): Promise<{ items: PackListItem[]; total: number }> {
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

  if (filters.search !== undefined && filters.search.length > 0) {
    // Case-insensitive substring on name OR slug. Parameterised — the %…% is
    // built in SQL, not interpolated, so LIKE metachars in input only widen the
    // match, never inject.
    conditions.push(`(lower(name) LIKE '%' || lower($${i}) || '%' OR lower(slug) LIKE '%' || lower($${i}) || '%')`);
    values.push(filters.search);
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

  // question_count is a correlated subquery against `questions`, an own-module
  // table that always exists wherever this query runs. RLS scopes both the
  // outer packs and the inner questions to the current tenant — no explicit
  // tenant_id filter (see the file header's RLS-only rule).
  const dataResult = await client.query<PackListRow>(
    `SELECT ${PACK_COLUMNS},
       (SELECT count(*)::int FROM questions q WHERE q.pack_id = question_packs.id) AS question_count,
       (SELECT count(*)::int FROM levels l WHERE l.pack_id = question_packs.id) AS level_count
     FROM question_packs ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  const packs = dataResult.rows;
  const packIds = packs.map((p) => p.id);

  // completed_count = candidate attempts that reached a finished state, for any
  // assessment built on this pack. attempts/assessments are owned by modules
  // 06/05; guard the join behind a table-existence check exactly like
  // countAssessmentsReferencingPack. RLS on attempts AND assessments scopes the
  // counts to the current tenant, so cross-tenant completions never leak.
  const completedByPack = new Map<string, number>();
  if (packIds.length > 0 && (await attemptCompletionsQueryable(client))) {
    const statusList = COMPLETED_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(", ");
    const completedResult = await client.query<{ pack_id: string; count: number }>(
      `SELECT asm.pack_id, count(*)::int AS count
         FROM attempts a
         JOIN assessments asm ON asm.id = a.assessment_id
        WHERE asm.pack_id = ANY($1::uuid[])
          AND a.status IN (${statusList})
        GROUP BY asm.pack_id`,
      [packIds],
    );
    for (const row of completedResult.rows) {
      completedByPack.set(row.pack_id, row.count);
    }
  }

  const items: PackListItem[] = packs.map((row) => ({
    ...mapPackRow(row),
    question_count: row.question_count,
    level_count: row.level_count,
    completed_count: completedByPack.get(row.id) ?? 0,
  }));

  return { items, total };
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
  if (patch.rubric_defaults !== undefined) {
    if (patch.rubric_defaults === null) {
      sets.push(`rubric_defaults = NULL`);
    } else {
      sets.push(`rubric_defaults = $${i}`);
      values.push(JSON.stringify(patch.rubric_defaults));
      i++;
    }
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

// ---------------------------------------------------------------------------
// EXP-5 list filters + facets
// ---------------------------------------------------------------------------

/** Facet keys a filter belongs to; a facet's own filter is left out of its own counts. */
type FilterKey =
  | "type" | "status" | "origin" | "rights_status" | "review_state" | "language"
  | "difficulty" | "has_solution" | "stage" | "subject" | "unit" | "outcome";

const HAS_SOLUTION_SQL = `(btrim(coalesce(q.content->>'rationale', '')) <> '')`;
const NODE_KINDS = ["stage", "subject", "unit", "outcome"] as const;

interface BuiltWhere {
  joins: string;
  where: string;
  values: unknown[];
  next: number;
  /** 1-based parameter index of the search text, or 0 when there is no search. */
  qParam: number;
}

/**
 * Build the JOIN and WHERE clauses for a ListQuestionsInput. Every user value is a bound
 * parameter; the only inlined SQL is fixed literals. `exclude` drops one facet's own filter
 * (disjunctive facet counts). RLS scopes every table touched; no tenant_id predicate here.
 */
function buildQuestionWhere(filters: ListQuestionsInput, exclude?: FilterKey, forceSource = false, fuzzy = true): BuiltWhere {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  let qParam = 0;
  const bind = (v: unknown): string => { values.push(v); return `$${i++}`; };

  if (filters.pack_id !== undefined) conditions.push(`q.pack_id = ${bind(filters.pack_id)}`);
  if (filters.level_id !== undefined) conditions.push(`q.level_id = ${bind(filters.level_id)}`);
  if (filters.type !== undefined && exclude !== "type") conditions.push(`q.type = ${bind(filters.type)}`);
  if (filters.status !== undefined && exclude !== "status") conditions.push(`q.status = ${bind(filters.status)}`);
  // The JOIN to question_tags + tags is added below; here we bind the name.
  if (filters.tag !== undefined) conditions.push(`t.name = ${bind(filters.tag)}`);
  if (filters.search !== undefined && filters.search.length > 0) {
    conditions.push(`lower(q.topic) LIKE lower(${bind(filters.search)}) || '%'`);
  }
  // Slice 2.2/D5: read-only domain/category filters — RLS-scoped via withTenant.
  if (filters.domain_id !== undefined) conditions.push(`q.domain_id = ${bind(filters.domain_id)}`);
  if (filters.category_id !== undefined) conditions.push(`q.category_id = ${bind(filters.category_id)}`);

  // Full-text (simple config, stored tsvector) and, in fuzzy mode, OR trigram word similarity
  // (default pg_trgm.word_similarity_threshold 0.6) for typos. See needsFuzzySearch().
  if (filters.q !== undefined && filters.q.length > 0) {
    const p = bind(filters.q);
    qParam = i - 1;
    conditions.push(
      fuzzy
        ? `(q.search_tsv @@ plainto_tsquery('simple', ${p}) OR ${p} <% q.search_text)`
        : `q.search_tsv @@ plainto_tsquery('simple', ${p})`,
    );
  }
  const multi = (key: FilterKey, col: string, vals: readonly string[] | undefined): void => {
    if (vals === undefined || vals.length === 0 || exclude === key) return;
    conditions.push(`${col} = ANY(${bind([...vals])}::text[])`);
  };
  multi("origin", "s.origin", filters.origin);
  multi("rights_status", "s.rights_status", filters.rights_status);
  multi("language", "q.language_primary", filters.language);
  multi("review_state", "coalesce(q.review_state, 'none')", filters.review_state);
  if (exclude !== "difficulty") {
    if (filters.difficulty_min !== undefined) conditions.push(`q.difficulty_est >= ${bind(filters.difficulty_min)}`);
    if (filters.difficulty_max !== undefined) conditions.push(`q.difficulty_est <= ${bind(filters.difficulty_max)}`);
  }
  if (filters.has_solution !== undefined && exclude !== "has_solution") {
    conditions.push(filters.has_solution ? HAS_SOLUTION_SQL : `NOT ${HAS_SOLUTION_SQL}`);
  }
  // Not a facet (no counts), so it is never excluded. q.passage_id is set by migration 0211.
  if (filters.has_passage !== undefined) {
    conditions.push(filters.has_passage ? "q.passage_id IS NOT NULL" : "q.passage_id IS NULL");
  }
  // Taxonomy node filters: the node must have the named kind; matches the node and all descendants.
  for (const kind of NODE_KINDS) {
    const id = filters[`${kind}_id` as const];
    if (id === undefined || exclude === kind) continue;
    conditions.push(
      `EXISTS (SELECT 1 FROM question_taxonomy qx WHERE qx.question_id = q.id AND qx.node_id IN (
         WITH RECURSIVE sub AS (
           SELECT id FROM taxonomy_nodes WHERE id = ${bind(id)} AND kind = '${kind}'
           UNION
           SELECT c.id FROM taxonomy_nodes c JOIN sub ON c.parent_id = sub.id)
         SELECT id FROM sub))`,
    );
  }

  const needSource = forceSource || filters.origin !== undefined || filters.rights_status !== undefined;
  const joins =
    (filters.tag !== undefined
      ? `JOIN question_tags qt ON qt.question_id = q.id JOIN tags t ON t.id = qt.tag_id `
      : "") +
    (needSource ? `LEFT JOIN question_source s ON s.question_id = q.id` : "");
  return { joins, where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", values, next: i, qParam };
}

/**
 * The trigram scan is the slow part of a search (RLS stops Postgres using the GIN index), so it
 * runs only when the exact full-text match finds nothing for the current filters.
 */
async function needsFuzzySearch(client: PoolClient, filters: ListQuestionsInput): Promise<boolean> {
  if (filters.q === undefined || filters.q.length === 0) return false;
  const b = buildQuestionWhere(filters, undefined, false, false);
  const r = await client.query(`SELECT 1 FROM questions q ${b.joins} ${b.where} LIMIT 1`, b.values);
  return r.rowCount === 0;
}

export async function listQuestionRows(
  client: PoolClient,
  filters: ListQuestionsInput,
): Promise<{ items: Question[]; total: number }> {
  const fuzzy = await needsFuzzySearch(client, filters);
  const { joins, where, values, next: i, qParam } = buildQuestionWhere(filters, undefined, false, fuzzy);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  // A search ranks by trigram word similarity; otherwise newest first.
  const orderBy = qParam > 0
    ? `word_similarity($${qParam}, q.search_text) DESC, q.created_at DESC, q.id DESC`
    : `q.created_at DESC, q.id DESC`;

  // One scan: count(*) OVER () gives the total with the page (a search filter is the costly part,
  // and RLS stops Postgres using its GIN indexes, so a second count scan would double the time).
  // Qualify all columns to avoid ambiguity when the tag JOIN is present.
  const dataResult = await client.query<QuestionRow & { total_count: string }>(
    `SELECT q.id, q.pack_id, q.level_id, q.type, q.topic, q.points, q.negative_marks, q.status,
            q.version, q.content, q.rubric, q.answer_guidance, q.knowledge_base_sources,
            q.created_by, q.created_at, q.updated_at,
            q.domain_id, q.category_id,
            q.cognitive_level, q.nice_task_id, q.difficulty_params, q.attack_technique,
            q.difficulty_est, q.review_state, q.language_primary, q.content_i18n,
            (SELECT label FROM levels WHERE levels.id = q.level_id) AS level_label,
            count(*) OVER () AS total_count
     FROM questions q
     ${joins}
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  let total: number;
  if (dataResult.rows.length > 0) {
    total = parseInt(dataResult.rows[0]!.total_count, 10);
  } else if (offset === 0) {
    total = 0;
  } else {
    // Page past the end: the window count is not available, count separately.
    const c = await client.query<{ count: string }>(`SELECT count(*) FROM questions q ${joins} ${where}`, values);
    total = parseInt(c.rows[0]?.count ?? "0", 10);
  }

  return { items: dataResult.rows.map(mapQuestionRow), total };
}

/** Counts per facet value for the current filter set (a facet ignores its own filter). */
export async function questionFacetCounts(
  client: PoolClient,
  filters: ListQuestionsInput,
): Promise<QuestionFacets> {
  const fuzzy = await needsFuzzySearch(client, filters);

  const bucket = async (key: FilterKey, expr: string): Promise<FacetCount[]> => {
    const b = buildQuestionWhere(filters, key, true, fuzzy);
    const r = await client.query<FacetCount>(
      `SELECT ${expr} AS value, count(*)::int AS count FROM questions q ${b.joins} ${b.where}
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      b.values,
    );
    return r.rows;
  };
  const nodes = async (kind: (typeof NODE_KINDS)[number]): Promise<FacetNodeCount[]> => {
    const b = buildQuestionWhere(filters, kind, true, fuzzy);
    const r = await client.query<FacetNodeCount>(
      `WITH RECURSIVE base AS (SELECT q.id FROM questions q ${b.joins} ${b.where}),
       up AS (
         SELECT qt.question_id, n.id, n.parent_id
           FROM question_taxonomy qt JOIN taxonomy_nodes n ON n.id = qt.node_id
          WHERE qt.question_id IN (SELECT id FROM base)
         UNION
         SELECT up.question_id, p.id, p.parent_id FROM up JOIN taxonomy_nodes p ON p.id = up.parent_id)
       SELECT n.id AS node_id, n.code, n.label, count(DISTINCT up.question_id)::int AS count
         FROM up JOIN taxonomy_nodes n ON n.id = up.id
        WHERE n.kind = '${kind}'
        GROUP BY n.id, n.code, n.label ORDER BY 4 DESC, n.label`,
      b.values,
    );
    return r.rows;
  };

  const all = buildQuestionWhere(filters, undefined, true, fuzzy);
  const totalRes = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions q ${all.joins} ${all.where}`,
    all.values,
  );
  // Sequential on purpose: one PoolClient runs one query at a time.
  return {
    total: parseInt(totalRes.rows[0]?.count ?? "0", 10),
    type: await bucket("type", `q.type`),
    status: await bucket("status", `q.status`),
    origin: await bucket("origin", `coalesce(s.origin, 'none')`),
    rights_status: await bucket("rights_status", `coalesce(s.rights_status, 'none')`),
    review_state: await bucket("review_state", `coalesce(q.review_state, 'none')`),
    language: await bucket("language", `q.language_primary`),
    difficulty: await bucket("difficulty", `coalesce(q.difficulty_est::text, 'none')`),
    has_solution: await bucket("has_solution", `(${HAS_SOLUTION_SQL})::text`),
    stage: await nodes("stage"),
    subject: await nodes("subject"),
    unit: await nodes("unit"),
    outcome: await nodes("outcome"),
  };
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
    negativeMarks?: number | null;
    content: unknown;
    rubric?: unknown;
    answerGuidance?: string | null;
    createdBy: string;
    /** EXP-2: provenance; defaults to a human-authored original. */
    origin?: QuestionOrigin;
    rightsStatus?: RightsStatus;
    /** EXP-4: import v2 provenance, written into the same question_source row. */
    sourceExtra?: QuestionSourceExtra;
    difficultyEst?: number | null;
    languagePrimary?: string;
    /** EXP-18 / Z-52 gap 5: omitted = 'in_review' (every new row starts unverified); legacy NULL rows are not backfilled. */
    reviewState?: ReviewState | null;
  },
): Promise<Question> {
  // questions has no tenant_id column — the WITH CHECK RLS policy derives
  // authorization through pack_id → question_packs.tenant_id. status defaults
  // to 'draft' per DB schema; content and rubric are stored as JSONB.
  // answer_guidance is plain text (candidate hint); NULL when not authored.
  const result = await client.query<QuestionRow>(
    `INSERT INTO questions (id, pack_id, level_id, type, topic, points, content, rubric, answer_guidance, created_by, negative_marks,
                            difficulty_est, language_primary, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, COALESCE($13, 'en'), $14)
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
      input.answerGuidance ?? null,
      input.createdBy,
      input.negativeMarks ?? null,
      input.difficultyEst ?? null,
      input.languagePrimary ?? null,
      input.reviewState === undefined ? "in_review" : input.reviewState,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertQuestion: INSERT returned no row");
  }
  await insertQuestionSource(client, input.id, input.packId, input.origin ?? "original_human", input.rightsStatus ?? "original", input.sourceExtra);
  return mapQuestionRow(row);
}

/**
 * Insert an AI-generated question draft.  Unlike `insertQuestion`, this
 * explicitly sets `status='ai_draft'` and persists the knowledge-base sources
 * embedded in the generator prompt so admins can see provenance citation chips.
 */
export async function insertAiDraftQuestion(
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
    knowledgeBaseSources: KnowledgeBaseSource[];
    createdBy: string;
  },
): Promise<Question> {
  const result = await client.query<QuestionRow>(
    `INSERT INTO questions
       (id, pack_id, level_id, type, topic, points, status, content, rubric, knowledge_base_sources, created_by, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, 'ai_draft', $7::jsonb, $8::jsonb, $9::jsonb, $10, 'in_review')
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
      JSON.stringify(input.knowledgeBaseSources),
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertAiDraftQuestion: INSERT returned no row");
  }
  await insertQuestionSource(client, input.id, input.packId, "ai_original", "original");
  return mapQuestionRow(row);
}

export interface QuestionSourceExtra {
  sourceRef?: string | null;
  sourceUrl?: string | null;
  seedRef?: string | null;
  importId?: string | null;
  uploadedBy?: string | null;
  sourceDifficultyRaw?: string | null;
  contentHash?: string | null;
  normalisedTextHash?: string | null;
  pyqYear?: number | null;
  pyqShift?: string | null;
}

/**
 * EXP-2: write the one question_source row for a new question. tenant_id comes from the
 * pack row (questions has no tenant_id), so the row always matches the pack's tenant.
 * Every create path calls this; publishPack treats a missing row as "rights not cleared".
 */
export async function insertQuestionSource(
  client: PoolClient,
  questionId: string,
  packId: string,
  origin: QuestionOrigin,
  rightsStatus: RightsStatus,
  x: QuestionSourceExtra = {},
): Promise<void> {
  await client.query(
    `INSERT INTO question_source (tenant_id, question_id, origin, rights_status, source_ref, source_url, seed_ref,
                                  import_id, uploaded_by, source_difficulty_raw, content_hash, normalised_text_hash,
                                  pyq_year, pyq_shift)
     SELECT tenant_id, $1::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::uuid, $10::text, $11::text,
            $12::text, $13::int, $14::text FROM question_packs WHERE id = $2
     ON CONFLICT (question_id) DO NOTHING`,
    [questionId, packId, origin, rightsStatus, x.sourceRef ?? null, x.sourceUrl ?? null, x.seedRef ?? null,
      x.importId ?? null, x.uploadedBy ?? null, x.sourceDifficultyRaw ?? null, x.contentHash ?? null,
      x.normalisedTextHash ?? null, x.pyqYear ?? null, x.pyqShift ?? null],
  );
}

const SOURCE_COLUMNS = `question_id, origin, rights_status, source_ref, source_url, seed_ref, licence_id,
  source_difficulty_raw, content_hash, normalised_text_hash, pyq_year, pyq_date::text AS pyq_date,
  pyq_shift, pyq_paper_code, pyq_qno`;

/** EXP-2: provenance rows for every question of a pack (RLS-scoped to the current tenant). */
export async function listQuestionSourcesForPack(client: PoolClient, packId: string): Promise<QuestionSource[]> {
  const r = await client.query<QuestionSource>(
    `SELECT ${SOURCE_COLUMNS} FROM question_source
      WHERE question_id IN (SELECT id FROM questions WHERE pack_id = $1)`,
    [packId],
  );
  return r.rows;
}

/**
 * EXP-2: takedown. Archives the question and upserts its source row to 'withdrawn', then bumps
 * the pack version so clones see a newer master at the next re-sync. Idempotent: a question
 * already withdrawn changes nothing. Returns 'missing' (not visible to the tenant), 'withdrawn'
 * (done now) or 'already' (no-op).
 */
export async function withdrawQuestionRow(client: PoolClient, questionId: string): Promise<"missing" | "withdrawn" | "already"> {
  const found = await client.query<{ pack_id: string; withdrawn: boolean }>(
    `SELECT q.pack_id, COALESCE(s.rights_status = 'withdrawn', false) AS withdrawn
       FROM questions q LEFT JOIN question_source s ON s.question_id = q.id WHERE q.id = $1`,
    [questionId],
  );
  const row = found.rows[0];
  if (row === undefined) return "missing";
  if (row.withdrawn) return "already";
  await client.query(`UPDATE questions SET status = 'archived', updated_at = now() WHERE id = $1`, [questionId]);
  await client.query(
    `INSERT INTO question_source (tenant_id, question_id, origin, rights_status)
     SELECT tenant_id, $1, 'original_human', 'withdrawn' FROM question_packs WHERE id = $2
     ON CONFLICT (question_id) DO UPDATE SET rights_status = 'withdrawn'`,
    [questionId, row.pack_id],
  );
  await client.query(`UPDATE question_packs SET version = version + 1, updated_at = now() WHERE id = $1`, [row.pack_id]);
  return "withdrawn";
}

/**
 * EXP-2 allowlist: a question may go live only when its source row exists with one of these
 * rights. metadata_only, scraped_raw, withdrawn and a missing row all block. Shared by the
 * publish gate and every activation path; references the unaliased `questions` table.
 */
export const RIGHTS_CLEARED_SQL = `EXISTS (SELECT 1 FROM question_source s WHERE s.question_id = questions.id
  AND s.rights_status IN ('original','derived_from_source','licensed'))`;

/** EXP-2: ids of a pack's non-archived questions whose rights are not cleared. */
export async function listRightsBlockedQuestionIds(client: PoolClient, packId: string): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM questions
      WHERE pack_id = $1 AND status <> 'archived' AND NOT ${RIGHTS_CLEARED_SQL}
      LIMIT 50`,
    [packId],
  );
  return r.rows.map((x) => x.id);
}

export async function updateQuestionRow(
  client: PoolClient,
  id: string,
  patch: {
    topic?: string;
    points?: number;
    negative_marks?: number | null;
    status?: QuestionStatus;
    content?: unknown;
    rubric?: unknown | null;
    answer_guidance?: string | null;
    version?: number;
    /** EXP-2 (metadata-only, no version bump). */
    difficulty_est?: number | null;
    review_state?: ReviewState | null;
    language_primary?: string;
    content_i18n?: unknown | null;
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
  if (patch.negative_marks !== undefined) {
    if (patch.negative_marks === null) {
      sets.push(`negative_marks = NULL`);
    } else {
      sets.push(`negative_marks = $${i}`);
      values.push(patch.negative_marks);
      i++;
    }
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
  // answer_guidance is plain text, metadata-only (no version bump). null clears
  // it so the per-type default applies again.
  if (patch.answer_guidance !== undefined) {
    if (patch.answer_guidance === null) {
      sets.push(`answer_guidance = NULL`);
    } else {
      sets.push(`answer_guidance = $${i}`);
      values.push(patch.answer_guidance);
      i++;
    }
  }
  if (patch.difficulty_est !== undefined) {
    sets.push(`difficulty_est = $${i}`);
    values.push(patch.difficulty_est);
    i++;
  }
  if (patch.review_state !== undefined) {
    sets.push(`review_state = $${i}`);
    values.push(patch.review_state);
    i++;
  }
  if (patch.language_primary !== undefined) {
    sets.push(`language_primary = $${i}`);
    values.push(patch.language_primary);
    i++;
  }
  if (patch.content_i18n !== undefined) {
    sets.push(`content_i18n = $${i}::jsonb`);
    values.push(patch.content_i18n === null ? null : JSON.stringify(patch.content_i18n));
    i++;
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
     WHERE pack_id = $1 AND status = 'draft' AND ${RIGHTS_CLEARED_SQL}`,
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
    // N21: every caller snapshots the question's CURRENT row before changing it, so the
    // frozen type is the question's current type.
    `INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by, type)
     SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6, q.type FROM questions q WHERE q.id = $2
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

/** Z-52 gap 6: append one reviewer note (append-only table, migration 0214). Returns the note id. */
export async function insertReviewNote(
  client: PoolClient,
  n: { tenantId: string; questionId: string; version: number; state: string; note: string; authorUserId: string },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO question_review_notes (tenant_id, question_id, version, state, note, author_user_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [n.tenantId, n.questionId, n.version, n.state, n.note, n.authorUserId],
  );
  return r.rows[0]!.id;
}
