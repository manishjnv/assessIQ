/**
 * Repository layer for the attempts, attempt_questions, attempt_answers,
 * attempt_events tables.
 *
 * IMPORTANT — RLS-only scoping (CLAUDE.md hard rule #4):
 * Every query here runs through a PoolClient whose connection has already
 * received `SET LOCAL ROLE assessiq_app` and `set_config('app.current_tenant',
 * $tenantId, true)` from withTenant(). Row-Level Security enforces tenant
 * isolation at the Postgres layer.
 *
 * Exception — attempts INSERT passes tenant_id:
 * The attempts table has its own tenant_id column with a WITH CHECK RLS
 * policy. The three child tables (attempt_questions, attempt_answers,
 * attempt_events) have NO tenant_id column — tenancy derives through
 * attempt_id → attempts.tenant_id (JOIN-based RLS).
 */

import type { PoolClient } from "pg";
import type {
  Attempt,
  AttemptAnswer,
  AttemptEvent,
  AttemptIntegritySummary,
  AttemptQuestion,
  AttemptStatus,
  FrozenQuestion,
} from "./types.js";
import { answerGuidanceFor } from "./answer-guidance.js";

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const ATTEMPT_COLUMNS = `id, tenant_id, assessment_id, user_id, status, started_at, ends_at, submitted_at, duration_seconds, created_at, embed_origin`;

const ATTEMPT_QUESTION_COLUMNS = `attempt_id, question_id, position, question_version, option_order, section_index`;

const ATTEMPT_ANSWER_COLUMNS = `attempt_id, question_id, answer, flagged, time_spent_seconds, edits_count, client_revision, saved_at`;

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface AttemptRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  user_id: string;
  status: string;
  started_at: Date | null;
  ends_at: Date | null;
  submitted_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  embed_origin: boolean;
}

interface AttemptQuestionRow {
  attempt_id: string;
  question_id: string;
  position: number;
  question_version: number;
  // SMALLINT[] — node-pg parses int2[] to number[]. NULL = original option order.
  option_order: number[] | null;
  section_index: number | null;
}

interface AttemptAnswerRow {
  attempt_id: string;
  question_id: string;
  answer: unknown | null;
  flagged: boolean;
  time_spent_seconds: number;
  edits_count: number;
  client_revision: number;
  saved_at: Date | null;
}

interface AttemptEventRow {
  id: string;
  attempt_id: string;
  event_type: string;
  question_id: string | null;
  payload: unknown | null;
  at: Date;
}

interface FrozenQuestionRow {
  question_id: string;
  position: number;
  question_version: number;
  type: string;
  topic: string;
  points: number;
  section_index: number | null;
  content: unknown;
  // Live-read from the `questions` row (NOT the frozen snapshot), like topic/
  // points. NULL → resolved to a per-type default by answerGuidanceFor().
  answer_guidance: string | null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapAttemptRow(row: AttemptRow): Attempt {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    assessment_id: row.assessment_id,
    user_id: row.user_id,
    status: row.status as AttemptStatus,
    started_at: row.started_at,
    ends_at: row.ends_at,
    submitted_at: row.submitted_at,
    duration_seconds: row.duration_seconds,
    created_at: row.created_at,
    embed_origin: row.embed_origin,
  };
}

function mapAttemptQuestionRow(row: AttemptQuestionRow): AttemptQuestion {
  return {
    attempt_id: row.attempt_id,
    question_id: row.question_id,
    position: row.position,
    question_version: row.question_version,
    option_order: row.option_order,
    section_index: row.section_index,
  };
}

function mapAttemptAnswerRow(row: AttemptAnswerRow): AttemptAnswer {
  return {
    attempt_id: row.attempt_id,
    question_id: row.question_id,
    answer: row.answer,
    flagged: row.flagged,
    time_spent_seconds: row.time_spent_seconds,
    edits_count: row.edits_count,
    client_revision: row.client_revision,
    saved_at: row.saved_at,
  };
}

function mapAttemptEventRow(row: AttemptEventRow): AttemptEvent {
  return {
    id: row.id,
    attempt_id: row.attempt_id,
    event_type: row.event_type,
    question_id: row.question_id,
    payload: row.payload,
    at: row.at,
  };
}

// ---------------------------------------------------------------------------
// Attempt queries
// ---------------------------------------------------------------------------

export async function findAttemptById(
  client: PoolClient,
  id: string,
): Promise<Attempt | null> {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAttemptRow(row) : null;
}

/**
 * Same as findAttemptById but takes a row lock (FOR UPDATE). Used by saveAnswer
 * so an answer write serialises with submit/auto-submit (which UPDATE the same
 * row and score MCQ in that tx): the scored answer is always the stored answer.
 */
export async function findAttemptByIdForUpdate(
  client: PoolClient,
  id: string,
): Promise<Attempt | null> {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAttemptRow(row) : null;
}

export async function findAttemptByAssessmentAndUser(
  client: PoolClient,
  assessmentId: string,
  userId: string,
): Promise<Attempt | null> {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts
     WHERE assessment_id = $1 AND user_id = $2
     LIMIT 1`,
    [assessmentId, userId],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAttemptRow(row) : null;
}

export async function insertAttempt(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    assessmentId: string;
    userId: string;
    status: AttemptStatus;
    startedAt: Date;
    endsAt: Date | null;
    durationSeconds: number;
    embedOrigin?: boolean;
  },
): Promise<Attempt | null> {
  // Returns null when UNIQUE(assessment_id, user_id) is violated (23505): a
  // concurrent Begin won the race. The INSERT runs under a SAVEPOINT so the
  // surrounding withTenant transaction is NOT left aborted and the caller can
  // re-read the winner's row.
  // tenant_id is explicitly passed to satisfy the WITH CHECK RLS policy.
  await client.query("SAVEPOINT insert_attempt");
  let result;
  try {
    result = await client.query<AttemptRow>(
    `INSERT INTO attempts
       (id, tenant_id, assessment_id, user_id, status, started_at, ends_at, duration_seconds, embed_origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ATTEMPT_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.assessmentId,
      input.userId,
      input.status,
      input.startedAt,
      input.endsAt,
      input.durationSeconds,
      input.embedOrigin ?? false,
    ],
  );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT insert_attempt");
      return null;
    }
    throw err;
  }
  await client.query("RELEASE SAVEPOINT insert_attempt");
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertAttempt: INSERT returned no row");
  }
  return mapAttemptRow(row);
}

/**
 * Append a candidate pre-test consent row to the module-20 consent_events
 * ledger (append-only; INSERT only). No dedicated writer exists in 20-data-rights
 * yet, so the attempt engine records the magic-link Begin consent directly.
 */
export async function hasConsentEvent(
  client: PoolClient,
  input: { userId: string; policyVersion: string },
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM consent_events
      WHERE user_id = $1 AND purpose = 'data_processing' AND policy_version = $2
        AND granted_at IS NOT NULL
      LIMIT 1`,
    [input.userId, input.policyVersion],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function insertConsentEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    policyVersion: string;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO consent_events
       (tenant_id, user_id, purpose, policy_version, granted_at, ip, user_agent, lawful_basis)
     VALUES ($1, $2, 'data_processing', $3, now(), $4::inet, $5, 'consent')`,
    [input.tenantId, input.userId, input.policyVersion, input.ip, input.userAgent],
  );
}

export async function updateAttemptStatus(
  client: PoolClient,
  id: string,
  patch: { status: AttemptStatus; submittedAt?: Date },
): Promise<Attempt> {
  if (patch.submittedAt !== undefined) {
    const result = await client.query<AttemptRow>(
      `UPDATE attempts SET status = $1, submitted_at = $2 WHERE id = $3
       RETURNING ${ATTEMPT_COLUMNS}`,
      [patch.status, patch.submittedAt, id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`updateAttemptStatus: no row for id ${id}`);
    }
    return mapAttemptRow(row);
  }
  const result = await client.query<AttemptRow>(
    `UPDATE attempts SET status = $1 WHERE id = $2
     RETURNING ${ATTEMPT_COLUMNS}`,
    [patch.status, id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateAttemptStatus: no row for id ${id}`);
  }
  return mapAttemptRow(row);
}

/**
 * Bulk auto-submit — called by the boundary sweep.
 * Returns the count of rows transitioned and the ids that were affected
 * (caller may want to emit events for each).
 */
export async function bulkAutoSubmitExpired(
  client: PoolClient,
  now: Date,
): Promise<{ count: number; ids: string[] }> {
  const result = await client.query<{ id: string }>(
    `UPDATE attempts
     SET status = 'auto_submitted', submitted_at = $1
     WHERE status = 'in_progress'
       AND ends_at IS NOT NULL
       AND ends_at <= $1
     RETURNING id`,
    [now],
  );
  return {
    count: result.rowCount ?? 0,
    ids: result.rows.map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Attempt-questions queries
// ---------------------------------------------------------------------------

export async function insertAttemptQuestions(
  client: PoolClient,
  attemptId: string,
  rows: ReadonlyArray<{
    questionId: string;
    position: number;
    questionVersion: number;
    /** Per-attempt MCQ option permutation (display position -> original index); null/omitted = original order. */
    optionOrder?: ReadonlyArray<number> | null;
    /** Test sections: index into settings.sections; null/omitted = assessment has no sections. */
    sectionIndex?: number | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;

  // Multi-row INSERT: build $1,$2,$3,$4,$5,$6,... placeholder grid.
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const r of rows) {
    // points = the question's points AT START (E12): scoring reads this frozen copy, never live questions.points.
    placeholders.push(
      `($${i++}, $${i++}::uuid, $${i++}, $${i++}, $${i++}::smallint[], (SELECT points FROM questions WHERE id = $${i - 4}::uuid), $${i++}::smallint)`,
    );
    values.push(attemptId, r.questionId, r.position, r.questionVersion, r.optionOrder ?? null, r.sectionIndex ?? null);
  }

  await client.query(
    `INSERT INTO attempt_questions (attempt_id, question_id, position, question_version, option_order, points, section_index)
     VALUES ${placeholders.join(", ")}`,
    values,
  );
}

/**
 * The frozen `content.options` of each picked MCQ, keyed by question id — what
 * startAttempt needs to decide whether (and how) to shuffle. Reads the SAME frozen
 * (question_id, version) rows the candidate is later served from
 * (listFrozenQuestionsForAttempt), so the stored order always matches the options
 * shown. Non-MCQ picks and picks without a snapshot are simply absent from the map.
 */
export async function listMcqOptionsForPicks(
  client: PoolClient,
  picks: ReadonlyArray<{ id: string; version: number }>,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (picks.length === 0) return out;
  const result = await client.query<{ question_id: string; options: unknown }>(
    `SELECT p.question_id::text AS question_id, qv.content -> 'options' AS options
       FROM unnest($1::uuid[], $2::int[]) AS p(question_id, version)
       JOIN question_versions qv
         ON qv.question_id = p.question_id AND qv.version = p.version
        AND qv.type IN ('mcq', 'multi_select')`,
    [picks.map((p) => p.id), picks.map((p) => p.version)],
  );
  for (const r of result.rows) out.set(r.question_id, r.options);
  return out;
}

/**
 * The frozen `items` + `correct_order` of each picked ordering question, keyed by question id —
 * what startAttempt needs to draw a per-attempt display order that is never the correct order.
 * Same frozen (question_id, version) rows the candidate is served from. Server-internal.
 */
export async function listOrderingKeysForPicks(
  client: PoolClient,
  picks: ReadonlyArray<{ id: string; version: number }>,
): Promise<Map<string, { items: unknown; correct_order: unknown }>> {
  const out = new Map<string, { items: unknown; correct_order: unknown }>();
  if (picks.length === 0) return out;
  const result = await client.query<{ question_id: string; items: unknown; correct_order: unknown }>(
    `SELECT p.question_id::text AS question_id, qv.content -> 'items' AS items, qv.content -> 'correct_order' AS correct_order
       FROM unnest($1::uuid[], $2::int[]) AS p(question_id, version)
       JOIN question_versions qv
         ON qv.question_id = p.question_id AND qv.version = p.version
        AND qv.type = 'ordering'`,
    [picks.map((p) => p.id), picks.map((p) => p.version)],
  );
  for (const r of result.rows) out.set(r.question_id, { items: r.items, correct_order: r.correct_order });
  return out;
}

/**
 * Stored option permutations of an attempt, keyed by question id (only questions
 * that were shuffled). SERVER-INTERNAL: used to translate the candidate's view;
 * the values are never returned to a caller outside this module.
 */
export async function listOptionOrders(
  client: PoolClient,
  attemptId: string,
): Promise<Map<string, number[]>> {
  const result = await client.query<{ question_id: string; option_order: number[] }>(
    `SELECT question_id, option_order FROM attempt_questions
      WHERE attempt_id = $1 AND option_order IS NOT NULL`,
    [attemptId],
  );
  return new Map(result.rows.map((r) => [r.question_id, r.option_order]));
}

/** Question ids of an attempt's `ordering` questions: their answers translate under `order`, not `selected`. */
export async function listOrderingQuestionIds(client: PoolClient, attemptId: string): Promise<Set<string>> {
  const result = await client.query<{ question_id: string }>(
    `SELECT aq.question_id::text AS question_id
       FROM attempt_questions aq
       JOIN question_versions qv
         ON qv.question_id = aq.question_id AND qv.version = aq.question_version
      WHERE aq.attempt_id = $1 AND qv.type = 'ordering'`,
    [attemptId],
  );
  return new Set(result.rows.map((r) => r.question_id));
}

/**
 * Type of one question (RLS-scoped), or null when the row is not visible.
 * N21: the type is the one frozen on the attempt's question_version (not the live question row).
 */
/** Frozen question_versions.content of an attempt question (SERVER-INTERNAL: contains the answer key). */
export async function findFrozenContent(
  client: PoolClient,
  questionId: string,
  version: number,
): Promise<unknown> {
  const result = await client.query<{ content: unknown }>(
    `SELECT content FROM question_versions WHERE question_id = $1 AND version = $2`,
    [questionId, version],
  );
  return result.rows[0]?.content ?? null;
}

export async function findQuestionType(
  client: PoolClient,
  questionId: string,
  version: number,
): Promise<string | null> {
  const result = await client.query<{ type: string }>(
    `SELECT type FROM question_versions WHERE question_id = $1 AND version = $2`,
    [questionId, version],
  );
  return result.rows[0]?.type ?? null;
}

/**
 * Strip answer-key fields from a question's `content` JSONB for the candidate
 * take-flow. CANDIDATE-PATH-ONLY — the admin grading path
 * (modules/07-ai-grading) must NEVER call this function; admins must see the
 * full content including the answer key.
 *
 * Allowlist per type (fail-closed: unknown types keep `question` only):
 *   mcq          → question, options
 *   ordering     → question, items
 *   log_analysis → question, log_format, log_excerpt, hint
 *   kql          → question, tables
 *   scenario     → title, intro, step_dependency, steps
 *                  (steps elements: `prompt`; mcq-typed steps also id/type/options;
 *                   `correct`, `trap`, `expected` and everything else dropped)
 *   subjective   → question
 *   <unknown>    → question only
 *
 * If `content` is not a non-null plain object at the top level, it is returned
 * unchanged — there is no answer key to strip and we must not crash.
 */
export function sanitizeContentForCandidate(type: string, content: unknown): unknown {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    return content;
  }
  const c = content as Record<string, unknown>;

  function pick(keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(c, k)) {
        out[k] = c[k];
      }
    }
    return out;
  }

  switch (type) {
    case "mcq":
      return pick(["question", "options"]);

    // Answer keys (`correct`, `answer`, `tolerance`, `scoring`, `rationale`) never leave the server.
    case "multi_select":
      return pick(["question", "options"]);

    case "numeric":
      return pick(["question", "unit"]);

    // ordering: `correct_order`, `scoring` and `explanation` never leave the server. The items are
    // re-arranged into the attempt's (never-correct) display order by displayQuestions().
    case "ordering":
      return pick(["question", "items"]);

    // structured_case: per-step allowlist id/prompt/select/options; `correct`, `scoring` and
    // `explanation` never leave the server. Not shuffled (ponytail: shuffle per step is the upgrade).
    case "structured_case": {
      const base = pick(["title", "context", "log_excerpt"]);
      const rawSteps = c["steps"];
      base["steps"] = Array.isArray(rawSteps)
        ? rawSteps.map((st) => {
            const s = st !== null && typeof st === "object" ? (st as Record<string, unknown>) : {};
            return { id: s["id"], prompt: s["prompt"], select: s["select"], options: s["options"] };
          })
        : [];
      return base;
    }

    case "log_analysis":
      return pick(["question", "log_format", "log_excerpt", "hint"]);

    case "kql":
      return pick(["question", "tables"]);

    case "scenario": {
      const base = pick(["title", "intro", "step_dependency"]);
      if (Object.prototype.hasOwnProperty.call(c, "steps")) {
        const rawSteps = c["steps"];
        if (Array.isArray(rawSteps)) {
          base["steps"] = rawSteps.map((step) => {
            if (step !== null && typeof step === "object" && !Array.isArray(step)) {
              const s = step as Record<string, unknown>;
              const stepOut: Record<string, unknown> = {};
              if (Object.prototype.hasOwnProperty.call(s, "prompt")) {
                stepOut["prompt"] = s["prompt"];
              }
              // Bank-schema mcq step: allowlist id/type/prompt/options only. `correct`, `trap`
              // and everything else stay server-side. Keyed on the declared step type; the
              // generated `{prompt, expected}` shape has no type and keeps `prompt` only.
              if (s["type"] === "mcq" && Array.isArray(s["options"])) {
                stepOut["type"] = "mcq";
                if (typeof s["id"] === "string") stepOut["id"] = s["id"];
                stepOut["options"] = (s["options"] as unknown[]).filter(
                  (o): o is string => typeof o === "string",
                );
              }
              return stepOut;
            }
            return step;
          });
        }
        // if steps is not an array, omit it entirely
      }
      return base;
    }

    case "subjective":
      return pick(["question"]);

    default:
      // fail-closed: unknown type → question only
      return pick(["question"]);
  }
}

/**
 * List frozen questions for an attempt — JOINs question_versions on
 * (question_id, version) and questions for type/topic/points. Ordered by
 * attempt_questions.position.
 *
 * The `rubric` column is intentionally NOT selected — candidates must never
 * see grading anchors / band thresholds (CLAUDE.md AssessIQ-specific rule
 * about audit-grade Phase 1 grading: rubric is internal-only).
 */
export async function listFrozenQuestionsForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<FrozenQuestion[]> {
  const result = await client.query<FrozenQuestionRow>(
    `SELECT
       aq.question_id,
       aq.position,
       aq.question_version,
       qv.type,
       q.topic,
       aq.points,
       aq.section_index,
       q.answer_guidance,
       qv.content
     FROM attempt_questions aq
     JOIN questions q ON q.id = aq.question_id
     JOIN question_versions qv
       ON qv.question_id = aq.question_id
      AND qv.version    = aq.question_version
     WHERE aq.attempt_id = $1
     ORDER BY aq.position ASC, aq.question_id ASC`,
    [attemptId],
  );
  return result.rows.map((r) => ({
    question_id: r.question_id,
    position: r.position,
    question_version: r.question_version,
    type: r.type,
    topic: r.topic,
    points: r.points,
    section_index: r.section_index,
    // Instructional, candidate-safe hint — resolved to a per-type default when
    // the question carries no authored guidance.
    answer_guidance: answerGuidanceFor(r.type, r.answer_guidance),
    content: sanitizeContentForCandidate(r.type, r.content),
  }));
}

export async function findAttemptQuestion(
  client: PoolClient,
  attemptId: string,
  questionId: string,
): Promise<AttemptQuestion | null> {
  const result = await client.query<AttemptQuestionRow>(
    `SELECT ${ATTEMPT_QUESTION_COLUMNS} FROM attempt_questions
     WHERE attempt_id = $1 AND question_id = $2 LIMIT 1`,
    [attemptId, questionId],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAttemptQuestionRow(row) : null;
}

// ---------------------------------------------------------------------------
// Attempt-answers queries
// ---------------------------------------------------------------------------

/**
 * Insert empty answer rows for every (attempt_id, question_id) — called once
 * at startAttempt time so client_revision starts at 0 deterministically and
 * the candidate UI can render "no answer yet" rows without distinguishing
 * present-with-null from missing.
 */
export async function insertEmptyAttemptAnswers(
  client: PoolClient,
  attemptId: string,
  questionIds: ReadonlyArray<string>,
): Promise<void> {
  if (questionIds.length === 0) return;

  const placeholders: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const qid of questionIds) {
    placeholders.push(`($${i++}, $${i++})`);
    values.push(attemptId, qid);
  }

  await client.query(
    `INSERT INTO attempt_answers (attempt_id, question_id) VALUES ${placeholders.join(", ")}`,
    values,
  );
}

export async function findAttemptAnswer(
  client: PoolClient,
  attemptId: string,
  questionId: string,
): Promise<AttemptAnswer | null> {
  const result = await client.query<AttemptAnswerRow>(
    `SELECT ${ATTEMPT_ANSWER_COLUMNS} FROM attempt_answers
     WHERE attempt_id = $1 AND question_id = $2 LIMIT 1`,
    [attemptId, questionId],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAttemptAnswerRow(row) : null;
}

export async function listAttemptAnswers(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptAnswer[]> {
  const result = await client.query<AttemptAnswerRow>(
    `SELECT ${ATTEMPT_ANSWER_COLUMNS} FROM attempt_answers
     WHERE attempt_id = $1
     ORDER BY question_id ASC`,
    [attemptId],
  );
  return result.rows.map(mapAttemptAnswerRow);
}

/**
 * Save (UPDATE) an answer row. Last-write-wins: client_revision is set to
 * GREATEST(stored, incoming) + 1 in SQL itself so concurrent saves can never
 * regress the counter.
 *
 * Returns the previous client_revision (caller decides whether to log a
 * multi_tab_conflict event when incoming < previous).
 */
export async function saveAttemptAnswer(
  client: PoolClient,
  input: {
    attemptId: string;
    questionId: string;
    answer: unknown;
    incomingRevision: number;
    editsCount: number | undefined;
    timeSpentSeconds: number | undefined;
  },
): Promise<{ previousRevision: number; newRevision: number }> {
  // Read-modify-write inside the same transaction so the SQL `RETURNING`
  // surfaces the previous revision the caller needs for multi_tab_conflict
  // detection. The GREATEST + 1 expression makes the new revision strictly
  // monotonic regardless of concurrent calls.

  const incEdits = input.editsCount;
  const incTime = input.timeSpentSeconds;

  const sets: string[] = [
    `answer = $3::jsonb`,
    `client_revision = GREATEST(client_revision, $4) + 1`,
    `saved_at = now()`,
  ];
  const values: unknown[] = [
    input.attemptId,
    input.questionId,
    JSON.stringify(input.answer),
    input.incomingRevision,
  ];
  let i = 5;

  if (incEdits !== undefined) {
    sets.push(`edits_count = $${i}`);
    values.push(incEdits);
    i++;
  }
  if (incTime !== undefined) {
    sets.push(`time_spent_seconds = $${i}`);
    values.push(incTime);
    i++;
  }

  // RETURNING old.client_revision (via WITH CTE) is awkward; simpler: use
  // a sub-select that captures the prior value before the UPDATE writes it.
  const sql = `
    WITH prior AS (
      SELECT client_revision AS pr
      FROM attempt_answers
      WHERE attempt_id = $1 AND question_id = $2
    )
    UPDATE attempt_answers
    SET ${sets.join(", ")}
    FROM prior
    WHERE attempt_answers.attempt_id = $1
      AND attempt_answers.question_id = $2
    RETURNING prior.pr AS previous_revision, attempt_answers.client_revision AS new_revision
  `;

  const result = await client.query<{ previous_revision: number; new_revision: number }>(sql, values);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `saveAttemptAnswer: no row for (${input.attemptId}, ${input.questionId})`,
    );
  }
  return {
    previousRevision: row.previous_revision,
    newRevision: row.new_revision,
  };
}

export async function setAnswerFlag(
  client: PoolClient,
  attemptId: string,
  questionId: string,
  flagged: boolean,
): Promise<{ flagged: boolean }> {
  const result = await client.query<{ flagged: boolean }>(
    `UPDATE attempt_answers SET flagged = $1
     WHERE attempt_id = $2 AND question_id = $3
     RETURNING flagged`,
    [flagged, attemptId, questionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `setAnswerFlag: no row for (${attemptId}, ${questionId})`,
    );
  }
  return { flagged: row.flagged };
}

// ---------------------------------------------------------------------------
// Attempt-events queries
// ---------------------------------------------------------------------------

export async function insertAttemptEvent(
  client: PoolClient,
  input: {
    attemptId: string;
    event_type: string;
    question_id?: string | null;
    payload?: unknown;
  },
): Promise<AttemptEvent> {
  const result = await client.query<AttemptEventRow>(
    `INSERT INTO attempt_events (attempt_id, event_type, question_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, attempt_id, event_type, question_id, payload, at`,
    [
      input.attemptId,
      input.event_type,
      input.question_id ?? null,
      input.payload !== undefined ? JSON.stringify(input.payload) : null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertAttemptEvent: INSERT returned no row");
  }
  return mapAttemptEventRow(row);
}

export async function countAttemptEvents(
  client: PoolClient,
  attemptId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM attempt_events WHERE attempt_id = $1`,
    [attemptId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/** Integrity summary counts. RLS (attempt_events policy via attempts.tenant_id) scopes rows. */
export async function countIntegrityEvents(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptIntegritySummary> {
  const r = await client.query<{ event_type: string; blocked: boolean; n: string }>(
    `SELECT event_type, COALESCE(payload->>'blocked' = 'true', false) AS blocked, count(*) AS n
     FROM attempt_events
     WHERE attempt_id = $1
       AND event_type IN ('tab_blur','copy','paste','fullscreen_exit','multi_tab_conflict')
     GROUP BY 1, 2`,
    [attemptId],
  );
  const out: AttemptIntegritySummary = {
    tab_switches: 0, copy: 0, paste: 0, paste_blocked: 0, fullscreen_exits: 0, multi_tab_conflicts: 0,
  };
  for (const row of r.rows) {
    const n = parseInt(row.n, 10);
    if (row.event_type === "tab_blur") out.tab_switches += n;
    else if (row.event_type === "copy") out.copy += n;
    else if (row.event_type === "paste") {
      out.paste += n;
      if (row.blocked) out.paste_blocked += n;
    } else if (row.event_type === "fullscreen_exit") out.fullscreen_exits += n;
    else if (row.event_type === "multi_tab_conflict") out.multi_tab_conflicts += n;
  }
  return out;
}

export async function listAttemptEvents(
  client: PoolClient,
  attemptId: string,
): Promise<AttemptEvent[]> {
  const result = await client.query<AttemptEventRow>(
    `SELECT id, attempt_id, event_type, question_id, payload, at
     FROM attempt_events
     WHERE attempt_id = $1
     ORDER BY at ASC, id ASC`,
    [attemptId],
  );
  return result.rows.map(mapAttemptEventRow);
}

// ---------------------------------------------------------------------------
// Helpers used by the service layer's startAttempt pre-flight
// ---------------------------------------------------------------------------

/**
 * Pull active questions for a (pack_id, level_id) pair, with the LATEST
 * `question_versions.version` per question — that's the version startAttempt
 * pins into `attempt_questions.question_version`.
 *
 * WHY MAX(qv.version), not q.version:
 *   `publishPack` (and `updateQuestion`) snapshot the CURRENT state into
 *   `question_versions(version=q.version)` and THEN bump `q.version` by one.
 *   So at any moment, `q.version` is one HIGHER than the most recent snapshot
 *   that actually exists. If the attempt pinned to `q.version`, the JOIN
 *   `question_versions ON (question_id, version)` in
 *   `listFrozenQuestionsForAttempt` would find no row and return empty.
 *
 *   Pinning to MAX(qv.version) instead means the candidate sees the most
 *   recently committed snapshot — i.e., the latest "published" state. Admin
 *   edits-in-progress (which write new content to `questions.content` but do
 *   NOT yet have a corresponding snapshot row) are correctly invisible to
 *   in-flight attempts; the candidate continues to see the pre-edit content
 *   until the admin re-publishes.
 *
 *   INNER JOIN excludes questions without any snapshot at all — those
 *   shouldn't reach status='active' under the normal publishPack flow, but
 *   the JOIN is the structural backstop.
 *
 * RCA: docs/RCA_LOG.md 2026-05-02 — "publishPack version bump leaves
 * attempt_questions JOIN empty when pinning to questions.version".
 */
export async function listActiveQuestionPoolForPick(
  client: PoolClient,
  packId: string,
  levelId: string,
): Promise<Array<{ id: string; version: number }>> {
  const result = await client.query<{ id: string; version: number }>(
    `SELECT q.id, MAX(qv.version)::int AS version
     FROM questions q
     JOIN question_versions qv ON qv.question_id = q.id
     WHERE q.pack_id = $1 AND q.level_id = $2 AND q.status = 'active'
     GROUP BY q.id
     ORDER BY q.id ASC`,
    [packId, levelId],
  );
  return result.rows;
}

/**
 * Pull active questions for a SINGLE BLUEPRINT CRITERION (C3 — Phase 2 Slice A).
 *
 * Same MAX(qv.version) logic as listActiveQuestionPoolForPick — pins to the
 * most recently committed snapshot per question (see WHY MAX comment above).
 *
 * The domain_id / category_id came from assessment.settings.blueprint which
 * was written-time-guarded by assertBlueprintFKOwnership (C1); this query
 * runs inside the existing withTenant RLS scope as a defence-in-depth layer.
 *
 * Runs inside the caller's withTenant client — RLS enforces tenant isolation.
 */
export async function listActiveQuestionPoolForCriterion(
  client: PoolClient,
  packId: string,
  levelId: string,
  domainId: string,
  categoryId: string,
  type: string,
): Promise<Array<{ id: string; version: number }>> {
  const result = await client.query<{ id: string; version: number }>(
    `SELECT q.id, MAX(qv.version)::int AS version
     FROM questions q
     JOIN question_versions qv ON qv.question_id = q.id
     WHERE q.pack_id = $1 AND q.level_id = $2
       AND q.domain_id = $3 AND q.category_id = $4
       AND q.type = $5 AND q.status = 'active'
     GROUP BY q.id
     ORDER BY q.id ASC`,
    [packId, levelId, domainId, categoryId, type],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// FROZEN-POOL reads ("lock at assignment", migration 0096) — ADDITIVE.
//
// When an assessment was frozen at publish (assessment_frozen_pool has rows),
// the draw reads from the frozen snapshot instead of the live questions table,
// so master-pack revisions / clone auto-sync never change an already-published
// assessment's content. These return the EXACT same shape ({ id, version }) and
// ORDER (question_id ASC) as listActiveQuestionPoolForPick / ...ForCriterion, so
// the caller's shuffle/take/snapshot logic is byte-identical — only the pool
// SOURCE changes. Assessments with NO frozen rows fall back to the live queries
// above (legacy/un-frozen). See countFrozenPool for the fallback decision.
// ---------------------------------------------------------------------------

/**
 * How many questions were frozen for this assessment. 0 ⇒ never frozen
 * (legacy/pre-0096) ⇒ caller uses the live-pool fallback.
 */
export async function countFrozenPool(
  client: PoolClient,
  assessmentId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessment_frozen_pool WHERE assessment_id = $1`,
    [assessmentId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * Frozen equivalent of listActiveQuestionPoolForPick (whole-pool, no blueprint).
 * The frozen snapshot already pinned each question to the version that was
 * MAX(qv.version) at publish, so no JOIN/aggregation is needed here.
 */
export async function listFrozenPoolForPick(
  client: PoolClient,
  assessmentId: string,
): Promise<Array<{ id: string; version: number }>> {
  const result = await client.query<{ id: string; version: number }>(
    `SELECT question_id AS id, question_version AS version
       FROM assessment_frozen_pool
      WHERE assessment_id = $1
      ORDER BY question_id ASC`,
    [assessmentId],
  );
  return result.rows;
}

/**
 * Frozen equivalent of listActiveQuestionPoolForCriterion (blueprint draw).
 * Re-filters the frozen set by the criterion's (domain_id, category_id, type),
 * matching the live criterion query's predicate.
 */
export async function listFrozenPoolForCriterion(
  client: PoolClient,
  assessmentId: string,
  domainId: string,
  categoryId: string,
  type: string,
): Promise<Array<{ id: string; version: number }>> {
  const result = await client.query<{ id: string; version: number }>(
    `SELECT question_id AS id, question_version AS version
       FROM assessment_frozen_pool
      WHERE assessment_id = $1
        AND domain_id = $2 AND category_id = $3 AND type = $4
      ORDER BY question_id ASC`,
    [assessmentId, domainId, categoryId, type],
  );
  return result.rows;
}

/**
 * Test sections: the whole pool WITH each question's category, so startAttempt can
 * partition it per section. Frozen snapshot when `useFrozen`, else the live pool —
 * same two sources and same MAX(version) rule as the pick queries above.
 */
export async function listPoolWithCategory(
  client: PoolClient,
  input: { assessmentId: string; packId: string; levelId: string; useFrozen: boolean },
): Promise<Array<{ id: string; version: number; category_id: string | null }>> {
  if (input.useFrozen) {
    const r = await client.query<{ id: string; version: number; category_id: string | null }>(
      `SELECT question_id AS id, question_version AS version, category_id
         FROM assessment_frozen_pool WHERE assessment_id = $1 ORDER BY question_id ASC`,
      [input.assessmentId],
    );
    return r.rows;
  }
  const r = await client.query<{ id: string; version: number; category_id: string | null }>(
    `SELECT q.id, MAX(qv.version)::int AS version, q.category_id
       FROM questions q
       JOIN question_versions qv ON qv.question_id = q.id
      WHERE q.pack_id = $1 AND q.level_id = $2 AND q.status = 'active'
      GROUP BY q.id
      ORDER BY q.id ASC`,
    [input.packId, input.levelId],
  );
  return r.rows;
}

/** attempts.section_progress (migration 0132); null = still in section 0. */
export async function getSectionProgress(
  client: PoolClient,
  attemptId: string,
): Promise<{ current: number; started_at: string } | null> {
  const r = await client.query<{ section_progress: { current: number; started_at: string } | null }>(
    `SELECT section_progress FROM attempts WHERE id = $1`,
    [attemptId],
  );
  return r.rows[0]?.section_progress ?? null;
}

/** Persist the section position; `endsAt` (optional) re-pins attempts.ends_at (Finish section). */
export async function setSectionProgress(
  client: PoolClient,
  attemptId: string,
  progress: { current: number; started_at: string },
  endsAt?: Date,
): Promise<void> {
  await client.query(
    `UPDATE attempts SET section_progress = $2::jsonb, ends_at = COALESCE($3, ends_at) WHERE id = $1`,
    [attemptId, JSON.stringify(progress), endsAt ?? null],
  );
}

export async function findInvitationForCandidate(
  client: PoolClient,
  assessmentId: string,
  userId: string,
): Promise<{ id: string; status: string; expires_at: Date } | null> {
  // FOR UPDATE: attempt start and an admin "Resend" (05 resendInvitation, which locks
  // the same row) must take turns. Without it a resend could check "not started", then
  // this start commit, and the resend rotate + email a link for a started candidate.
  // startAttempt re-validates status / expiry on the row it gets under this lock.
  const result = await client.query<{ id: string; status: string; expires_at: Date }>(
    `SELECT id, status, expires_at FROM assessment_invitations
     WHERE assessment_id = $1 AND user_id = $2 LIMIT 1
     FOR UPDATE`,
    [assessmentId, userId],
  );
  const row = result.rows[0];
  return row !== undefined ? row : null;
}

export async function markInvitationStarted(
  client: PoolClient,
  invitationId: string,
): Promise<void> {
  await client.query(
    `UPDATE assessment_invitations SET status = 'started'
     WHERE id = $1 AND status IN ('pending', 'viewed')`,
    [invitationId],
  );
}

export async function markInvitationSubmitted(
  client: PoolClient,
  assessmentId: string,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE assessment_invitations SET status = 'submitted'
     WHERE assessment_id = $1 AND user_id = $2 AND status IN ('started', 'viewed', 'pending')`,
    [assessmentId, userId],
  );
}
