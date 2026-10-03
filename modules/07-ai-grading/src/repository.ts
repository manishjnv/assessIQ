/**
 * Repository layer for the gradings and tenant_grading_budgets tables.
 *
 * Phase 2 G2.A Session 1.b — service-layer data access.
 *
 * Decision references:
 *   D4 — prompt_version_sha pinning on every gradings row.
 *   D6 — tenant_grading_budgets default-shape when no row exists.
 *   D7 — idempotency key: (attempt_id, question_id, prompt_version_sha) WHERE override_of IS NULL.
 *   D8 — admin override never UPDATEs existing rows; INSERT a new row only.
 *
 * IMPORTANT — RLS-only scoping (CLAUDE.md hard rule #4):
 *   Every query here runs through a PoolClient whose connection has already
 *   received SET LOCAL ROLE + set_config('app.current_tenant', ...) from
 *   withTenant(). RLS on gradings and tenant_grading_budgets enforces tenant
 *   isolation at the Postgres layer. NEVER add WHERE tenant_id = $N here —
 *   that pattern masks RLS bugs (CLAUDE.md rule #4, D7 idempotency backstop).
 *
 *   Exception — insertGrading passes tenant_id explicitly:
 *   The gradings INSERT has a WITH CHECK RLS policy that requires
 *   tenant_id = current_setting('app.current_tenant'). We pass the tenantId
 *   to satisfy that CHECK (same rationale as insertAttempt in 06-attempt-engine).
 *   The value must match what withTenant() set or Postgres will reject the row.
 */

import type { PoolClient } from "pg";
import { displayCandidate } from "@assessiq/core";
import type {
  AnchorFinding,
  GradingsRow,
  TenantGradingBudget,
} from "./types.js";

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const GRADING_COLUMNS = [
  "id",
  "tenant_id",
  "attempt_id",
  "question_id",
  "grader",
  "score_earned",
  "score_max",
  "status",
  "anchor_hits",
  "reasoning_band",
  "ai_justification",
  "error_class",
  "prompt_version_sha",
  "prompt_version_label",
  "model",
  "escalation_chosen_stage",
  "graded_at",
  "graded_by",
  "override_of",
  "override_reason",
].join(", ");

// ---------------------------------------------------------------------------
// Row interfaces (raw Postgres shapes before mapping)
// ---------------------------------------------------------------------------

interface GradingDbRow {
  id: string;
  tenant_id: string;
  attempt_id: string;
  question_id: string;
  grader: string;
  score_earned: string; // NUMERIC comes back as string from pg
  score_max: string;
  status: string;
  anchor_hits: unknown | null;
  reasoning_band: number | null;
  ai_justification: string | null;
  error_class: string | null;
  prompt_version_sha: string;
  prompt_version_label: string;
  model: string;
  escalation_chosen_stage: string | null;
  graded_at: Date;
  graded_by: string | null;
  override_of: string | null;
  override_reason: string | null;
}

interface BudgetDbRow {
  tenant_id: string;
  monthly_budget_usd: string;
  used_usd: string;
  period_start: Date;
  alert_threshold_pct: string;
  alerted_at: Date | null;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapGradingRow(row: GradingDbRow): GradingsRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    attempt_id: row.attempt_id,
    question_id: row.question_id,
    grader: row.grader as GradingsRow["grader"],
    score_earned: parseFloat(row.score_earned),
    score_max: parseFloat(row.score_max),
    status: row.status as GradingsRow["status"],
    anchor_hits: row.anchor_hits as AnchorFinding[] | null,
    reasoning_band: row.reasoning_band,
    ai_justification: row.ai_justification,
    error_class: row.error_class,
    prompt_version_sha: row.prompt_version_sha,
    prompt_version_label: row.prompt_version_label,
    model: row.model,
    escalation_chosen_stage:
      row.escalation_chosen_stage as GradingsRow["escalation_chosen_stage"],
    graded_at: row.graded_at,
    graded_by: row.graded_by,
    override_of: row.override_of,
    override_reason: row.override_reason,
  };
}

function mapBudgetRow(row: BudgetDbRow): TenantGradingBudget {
  return {
    tenant_id: row.tenant_id,
    monthly_budget_usd: parseFloat(row.monthly_budget_usd),
    used_usd: parseFloat(row.used_usd),
    period_start: row.period_start,
    alert_threshold_pct: parseFloat(row.alert_threshold_pct),
    alerted_at: row.alerted_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Gradings queries
// ---------------------------------------------------------------------------

export async function findGradingById(
  client: PoolClient,
  id: string,
): Promise<GradingsRow | null> {
  const result = await client.query<GradingDbRow>(
    `SELECT ${GRADING_COLUMNS} FROM gradings WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapGradingRow(row) : null;
}

export async function findGradingsForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<GradingsRow[]> {
  const result = await client.query<GradingDbRow>(
    `SELECT ${GRADING_COLUMNS} FROM gradings
     WHERE attempt_id = $1
     ORDER BY question_id ASC, graded_at ASC`,
    [attemptId],
  );
  return result.rows.map(mapGradingRow);
}

export interface InsertGradingInput {
  attempt_id: string;
  question_id: string;
  grader: GradingsRow["grader"];
  score_earned: number;
  score_max: number;
  status: GradingsRow["status"];
  anchor_hits: AnchorFinding[] | null;
  reasoning_band: number | null;
  ai_justification: string | null;
  error_class: string | null;
  prompt_version_sha: string;
  prompt_version_label: string;
  model: string;
  escalation_chosen_stage: GradingsRow["escalation_chosen_stage"];
  graded_by: string | null;
  override_of: string | null;
  override_reason: string | null;
}

/**
 * INSERT a grading row and return it.
 *
 * D8 invariant: caller MUST pass override_of=null for new AI gradings and
 * override_of=<original.id> for admin overrides. This function never UPDATEs.
 * One more legitimate use of override_of: an AI RE-RUN accepted on an already-graded
 * (sent-back) attempt whose prompt SHA did not change — the new row points at the
 * same-SHA row it supersedes, which keeps the D7 partial unique index satisfied
 * (admin-accept.ts). The newest row wins either way.
 *
 * tenantId is passed explicitly to satisfy the WITH CHECK RLS policy on
 * gradings (mirrors insertAttempt in 06-attempt-engine). The value must match
 * what withTenant() set in the current transaction or Postgres rejects the row.
 *
 * D7 idempotency backstop: if a duplicate (attempt_id, question_id,
 * prompt_version_sha) WHERE override_of IS NULL is attempted, Postgres raises
 * a unique-constraint violation. Callers should call findGradingByIdempotencyKey
 * first to avoid the error path.
 */
export async function insertGrading(
  client: PoolClient,
  tenantId: string,
  input: InsertGradingInput,
): Promise<GradingsRow> {
  const result = await client.query<GradingDbRow>(
    `INSERT INTO gradings (
       tenant_id, attempt_id, question_id, grader,
       score_earned, score_max, status,
       anchor_hits, reasoning_band, ai_justification, error_class,
       prompt_version_sha, prompt_version_label, model,
       escalation_chosen_stage, graded_by, override_of, override_reason
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8::jsonb, $9, $10, $11,
       $12, $13, $14,
       $15, $16, $17, $18
     )
     RETURNING ${GRADING_COLUMNS}`,
    [
      tenantId,
      input.attempt_id,
      input.question_id,
      input.grader,
      input.score_earned,
      input.score_max,
      input.status,
      input.anchor_hits !== null ? JSON.stringify(input.anchor_hits) : null,
      input.reasoning_band,
      input.ai_justification,
      input.error_class,
      input.prompt_version_sha,
      input.prompt_version_label,
      input.model,
      input.escalation_chosen_stage,
      input.graded_by,
      input.override_of,
      input.override_reason,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertGrading: INSERT returned no row");
  }
  return mapGradingRow(row);
}

/**
 * D7 idempotency-key fetch.
 * Returns an existing row for (attempt_id, question_id, prompt_version_sha)
 * WHERE override_of IS NULL, or null if none exists.
 *
 * Call this before insertGrading to avoid unique-constraint violations on
 * the D7 idempotency backstop index.
 */
export async function findGradingByIdempotencyKey(
  client: PoolClient,
  attemptId: string,
  questionId: string,
  promptVersionSha: string,
): Promise<GradingsRow | null> {
  const result = await client.query<GradingDbRow>(
    `SELECT ${GRADING_COLUMNS} FROM gradings
     WHERE attempt_id = $1
       AND question_id = $2
       AND prompt_version_sha = $3
       AND override_of IS NULL
     LIMIT 1`,
    [attemptId, questionId, promptVersionSha],
  );
  const row = result.rows[0];
  return row !== undefined ? mapGradingRow(row) : null;
}

/**
 * Is this proposal NEWER than every grading already written for (attempt, question)
 * — any grader, so a human override counts? Compared in SQL (timestamptz, exact), not in
 * JS. False for an unparsable timestamp or a question with no grading.
 *
 * Used by accept on an already-graded attempt to tell a fresh AI pass (a re-run after a
 * send-back: same prompt SHA, new verdict) from a replay or a stale tab: a proposal
 * generated at or before the newest grading can never overwrite it.
 */
export async function isProposalNewerThanGradings(
  client: PoolClient,
  attemptId: string,
  questionId: string,
  generatedAt: string,
): Promise<boolean> {
  if (!Number.isFinite(Date.parse(generatedAt))) return false;
  const result = await client.query<{ newer: boolean | null }>(
    `SELECT (MAX(graded_at) < $3::timestamptz) AS newer
       FROM gradings
      WHERE attempt_id = $1
        AND question_id = $2`,
    [attemptId, questionId, generatedAt],
  );
  return result.rows[0]?.newer === true;
}

/**
 * Has the attempt's candidate been erased (DPDP/GDPR, users.erased_at)? Same source as
 * release-to-tenant's gate. The platform completion path uses it under the attempt lock:
 * an erased candidate's result is never handed over to the tenant automatically.
 */
export async function isAttemptCandidateErased(
  client: PoolClient,
  attemptId: string,
): Promise<boolean> {
  const result = await client.query<{ erased: boolean }>(
    `SELECT (u.erased_at IS NOT NULL) AS erased
       FROM attempts a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1`,
    [attemptId],
  );
  return result.rows[0]?.erased === true;
}

// ---------------------------------------------------------------------------
// Tenant grading budget queries
// ---------------------------------------------------------------------------

/**
 * Fetch the tenant grading budget row for the current RLS-scoped tenant.
 * Returns null when no row exists — callers interpret absence as
 * "unlimited / not yet configured" (D6 default-shape in the handler layer).
 */
export async function findTenantBudget(
  client: PoolClient,
): Promise<TenantGradingBudget | null> {
  const result = await client.query<BudgetDbRow>(
    `SELECT
       tenant_id, monthly_budget_usd, used_usd,
       period_start, alert_threshold_pct, alerted_at, updated_at
     FROM tenant_grading_budgets
     LIMIT 1`,
  );
  const row = result.rows[0];
  return row !== undefined ? mapBudgetRow(row) : null;
}

// ---------------------------------------------------------------------------
// Evaluation status (Phase II — platform evaluation queue)
// ---------------------------------------------------------------------------

/**
 * Where an attempt is in the platform-evaluation lifecycle, as the TENANT sees it.
 * Derived (never stored) from attempts.status + attempts.evaluation_released_at:
 *   - 'published'           status 'released' (the candidate can see the result)
 *   - 'ready_to_publish'    status 'graded' AND the platform released the evaluation
 *   - 'awaiting_evaluation' everything else (still queued with AssessIQ, or sent back)
 * The attempts.status enum is untouched (spec invariant 7).
 */
export type EvaluationStatus = "awaiting_evaluation" | "ready_to_publish" | "published";

export function deriveEvaluationStatus(
  status: string,
  evaluationReleased: boolean,
): EvaluationStatus {
  if (status === "released") return "published";
  if (status === "graded" && evaluationReleased) return "ready_to_publish";
  return "awaiting_evaluation";
}

// ---------------------------------------------------------------------------
// Admin attempts list query
// ---------------------------------------------------------------------------

/**
 * Row returned by listAttemptsForAdmin.
 *
 * Timestamps are pre-formatted to ISO-8601 strings in the SQL SELECT so no
 * JS-side mapping is needed (same pattern as listGradingQueue's use of raw
 * Date columns is avoided here because we need the ISO string for the FE).
 */
export interface AttemptListRow {
  id: string;
  status: string;
  /** Phase II: tenant-facing evaluation state (see deriveEvaluationStatus). */
  evaluation_status: EvaluationStatus;
  started_at: string;
  submitted_at: string | null;
  candidate_email: string;
  candidate_name: string;
  isErased: boolean;
  assessment_name: string;
  level_label: string;
}

/**
 * List attempts for the admin dashboard with pagination and optional status filter.
 *
 * RLS-scoped — returns only attempts for the current tenant (set by withTenant).
 * NEVER add WHERE tenant_id = $N here — RLS enforces isolation via
 * app.current_tenant; an explicit filter masks RLS bugs (CLAUDE.md rule #4).
 *
 * Join path: attempts → users (email), assessments (name), levels (label via
 * assessments.level_id → levels.id). All joins are LEFT JOIN so orphaned rows
 * (e.g. a deleted user) still appear with COALESCE fallback values.
 *
 * Ordering: submitted_at DESC NULLS LAST, then started_at DESC for stability
 * so in-progress attempts (null submitted_at) sort after completed ones.
 */
export async function listAttemptsForAdmin(
  client: PoolClient,
  opts: { limit: number; offset: number; status?: string | string[] },
): Promise<{ items: AttemptListRow[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (opts.status !== undefined) {
    params.push(Array.isArray(opts.status) ? opts.status : [opts.status]);
    conditions.push(`a.status = ANY($${params.length}::text[])`);
  }
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count query (RLS scopes via app.current_tenant — no explicit tenant filter)
  const countResult = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM attempts a ${whereClause}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total ?? "0");

  params.push(opts.limit);
  const limitParam = `$${params.length}`;
  params.push(opts.offset);
  const offsetParam = `$${params.length}`;

  // Raw DB row before displayCandidate substitution
  interface AttemptListDbRow {
    id: string;
    status: string;
    evaluation_released: boolean;
    started_at: string;
    submitted_at: string | null;
    candidate_email: string | null;
    candidate_name: string | null;
    erased_at: string | null;
    assessment_name: string;
    level_label: string;
  }

  const result = await client.query<AttemptListDbRow>(
    `SELECT
       a.id::text                                                                   AS id,
       a.status,
       (a.evaluation_released_at IS NOT NULL)                                       AS evaluation_released,
       to_char(a.started_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')     AS started_at,
       CASE WHEN a.submitted_at IS NULL THEN NULL
            ELSE to_char(a.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       END                                                                           AS submitted_at,
       u.email                                                                       AS candidate_email,
       u.name                                                                        AS candidate_name,
       u.erased_at,
       COALESCE(asm.name,  '(unknown)')                                              AS assessment_name,
       COALESCE(lvl.label, '(unknown)')                                              AS level_label
     FROM attempts a
     LEFT JOIN users       u   ON u.id   = a.user_id
     LEFT JOIN assessments asm ON asm.id = a.assessment_id
     LEFT JOIN levels      lvl ON lvl.id = asm.level_id
     ${whereClause}
     ORDER BY a.submitted_at DESC NULLS LAST, a.started_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const items: AttemptListRow[] = result.rows.map((r) => {
    const display = displayCandidate({
      id: r.id,
      name: r.candidate_name,
      email: r.candidate_email,
      erased_at: r.erased_at,
    });
    return {
      id: r.id,
      status: r.status,
      evaluation_status: deriveEvaluationStatus(r.status, r.evaluation_released),
      started_at: r.started_at,
      submitted_at: r.submitted_at,
      candidate_email: display.email ?? '(erased)',
      candidate_name: display.name,
      isErased: display.isErased,
      assessment_name: r.assessment_name,
      level_label: r.level_label,
    };
  });

  return { items, total };
}

// ---------------------------------------------------------------------------
// Grading queue query
// ---------------------------------------------------------------------------

export interface QueueRow {
  attempt_id: string;
  candidate_email: string;
  assessment_name: string;
  level_label: string;
  submitted_at: Date | null;
  status: string;
  /** Phase II: tenant-facing evaluation state (see deriveEvaluationStatus). */
  evaluation_status: EvaluationStatus;
  /** Always false in Phase 2 G2 — drift detection deferred to later session. */
  prompt_version_sha_drift: boolean;
}

interface QueueDbRow {
  attempt_id: string;
  candidate_email: string;
  assessment_name: string;
  level_label: string;
  submitted_at: Date | null;
  status: string;
  evaluation_released: boolean;
}

/**
 * List attempts awaiting grading for the admin queue dashboard.
 *
 * RLS-scoped — returns only attempts for the current tenant.
 * Joins: attempts → assessments → levels (for level_label) →
 *        users (for candidate email). The table is `levels` (module 04
 *        question-bank) — earlier draft used `assessment_levels` which
 *        does not exist; fixed in Phase 3 critique pass.
 *
 * `prompt_version_sha_drift` is always false in Phase 2 G2: no AI gradings
 * exist yet pre-grade, so drift detection is a no-op at this stage. It will
 * be implemented when the admin panel compares stored SHA against skillSha()
 * at load time.
 *
 * D3: no grading_jobs table in Phase 1 — queue is derived from attempts.status.
 */
export async function listGradingQueue(
  client: PoolClient,
  opts?: { limit?: number },
): Promise<QueueRow[]> {
  const limit = opts?.limit ?? 100;
  const result = await client.query<QueueDbRow>(
    `SELECT
       a.id                  AS attempt_id,
       u.email               AS candidate_email,
       asmnt.name            AS assessment_name,
       COALESCE(al.label, '') AS level_label,
       a.submitted_at,
       a.status,
       (a.evaluation_released_at IS NOT NULL) AS evaluation_released
     FROM attempts a
     JOIN users u ON u.id = a.user_id
     JOIN assessments asmnt ON asmnt.id = a.assessment_id
     LEFT JOIN levels al ON al.id = asmnt.level_id
     WHERE a.status IN ('submitted', 'auto_submitted', 'pending_admin_grading')
     ORDER BY a.submitted_at ASC NULLS LAST, a.id ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    attempt_id: r.attempt_id,
    candidate_email: r.candidate_email,
    assessment_name: r.assessment_name,
    level_label: r.level_label,
    submitted_at: r.submitted_at,
    status: r.status,
    evaluation_status: deriveEvaluationStatus(r.status, r.evaluation_released),
    prompt_version_sha_drift: false,
  }));
}

/** Dashboard KPI counts for the current tenant. Not limited by the queue page size. */
export interface QueueCounts {
  /** Same predicate as listGradingQueue: not evaluated yet. */
  in_queue: number;
  /** in_queue + evaluated but not yet released to the tenant (see deriveEvaluationStatus). */
  awaiting_evaluation: number;
  /** status 'graded' AND evaluation released: the tenant can publish. */
  ready_to_publish: number;
}

/**
 * Count attempts for the dashboard KPI cards. RLS-scoped like listGradingQueue
 * (no tenant predicate; the caller runs inside withTenant). KEEP IN SYNC with the
 * listGradingQueue status filter and with deriveEvaluationStatus.
 * Index: attempts_dashboard_count_idx (migration 0150) is a partial index on
 * (tenant_id, status) with this exact status list. KEEP the WHERE list below IN
 * SYNC with that index, or the count falls back to a scan of the tenant's attempts.
 */
export async function countGradingQueue(client: PoolClient): Promise<QueueCounts> {
  const result = await client.query<QueueCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE a.status <> 'graded')::int                                        AS in_queue,
       COUNT(*) FILTER (WHERE a.status <> 'graded' OR a.evaluation_released_at IS NULL)::int     AS awaiting_evaluation,
       COUNT(*) FILTER (WHERE a.status = 'graded' AND a.evaluation_released_at IS NOT NULL)::int AS ready_to_publish
     FROM attempts a
     WHERE a.status IN ('submitted', 'auto_submitted', 'pending_admin_grading', 'graded')`,
  );
  return result.rows[0] ?? { in_queue: 0, awaiting_evaluation: 0, ready_to_publish: 0 };
}

// ---------------------------------------------------------------------------
// Attempt completeness (shared by release-to-tenant)
// ---------------------------------------------------------------------------

/**
 * How many frozen questions the attempt has, and how many of them have an
 * EFFECTIVE grading that is not 'review_needed'. Same rule as module 09
 * finalizeAttemptIfComplete (newest row per question; an admin_override row wins a
 * graded_at tie) — release-to-tenant re-checks it because a later re-run / accept
 * can add a newer flagged row to an attempt that is already 'graded'.
 * Complete iff total > 0 AND done = total. Runs inside the caller's withTenant tx.
 */
export async function getAttemptProgress(
  client: PoolClient,
  attemptId: string,
): Promise<{ total: number; done: number }> {
  const res = await client.query<{ total: number; done: number }>(
    `WITH effective AS (
       SELECT DISTINCT ON (g.question_id) g.question_id, g.status
         FROM gradings g
        WHERE g.attempt_id = $1
        ORDER BY g.question_id, g.graded_at DESC, (g.grader = 'admin_override') DESC
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE e.question_id IS NOT NULL AND e.status <> 'review_needed')::int AS done
       FROM attempt_questions aq
       LEFT JOIN effective e ON e.question_id = aq.question_id
      WHERE aq.attempt_id = $1`,
    [attemptId],
  );
  return res.rows[0] ?? { total: 0, done: 0 };
}

// ---------------------------------------------------------------------------
// Platform evaluation queue (cross-tenant — super admin only)
// ---------------------------------------------------------------------------

/**
 * One row of the platform evaluation queue. DELIBERATELY carries no candidate
 * name / email / user id: the platform evaluator reviews blind (owner decision
 * 2026-10-01). Everything here is tenant/assessment metadata or a count.
 */
export interface SuperEvaluationRow {
  attempt_id: string;
  tenant_id: string;
  tenant_name: string;
  assessment_id: string;
  assessment_name: string;
  level_label: string;
  submitted_at: string | null;
  /** Hours since submission, 1 decimal place. */
  age_hours: number;
  /** subjective + scenario + log_analysis answers (the AI-evaluated types). */
  written_count: number;
  kql_count: number;
  status: string;
  /** status === 'graded': fully evaluated, waiting for release-to-tenant. */
  complete: boolean;
  /** An AI run started within the last 10 minutes (attempts.grading_started_at). */
  grading_in_progress: boolean;
  /** The tenant sent it back for re-evaluation (evaluation_sent_back_at set). */
  sent_back: boolean;
  sent_back_note: string | null;
}

interface SuperEvaluationDbRow {
  attempt_id: string;
  tenant_id: string;
  tenant_name: string;
  assessment_id: string;
  assessment_name: string;
  level_label: string;
  submitted_at: Date | null;
  age_hours: number;
  written_count: number;
  kql_count: number;
  status: string;
  grading_in_progress: boolean;
  sent_back: boolean;
  sent_back_note: string | null;
  total: number;
  older_than_24h: number;
}

/** Hard cap on one queue response; counts below are over the WHOLE queue, not the page. */
export const SUPER_QUEUE_LIMIT = 500;

/**
 * List the platform evaluation queue across ALL tenants, oldest first.
 *
 * MUST run on a client inside `BEGIN … SET LOCAL ROLE assessiq_system` (RLS
 * bypass — there is no tenant context). Same read-only cross-tenant pattern as
 * apps/api admin-super.ts and 02-tenancy listActiveTenantIds. The explicit tenant
 * predicate is the optional UI filter, NOT an isolation mechanism.
 *
 * Eligible = at least one non-MCQ question (MCQ-only attempts complete at submit
 * and never need the platform) AND either still unevaluated (submitted /
 * auto_submitted / pending_admin_grading) or graded-but-not-yet-released (sent back
 * by the tenant, or finished and not yet released), the candidate is not erased,
 * and the tenant is active. KEEP IN SYNC with the overdue count in
 * apps/api/src/jobs/evaluation-queue-alert.ts (the worker may not import this
 * module — lint:ambient-ai — so that predicate is duplicated there).
 */
export async function listSuperEvaluationQueue(
  client: PoolClient,
  opts: { tenantId?: string } = {},
): Promise<{ items: SuperEvaluationRow[]; counts: { pending: number; older_than_24h: number } }> {
  const res = await client.query<SuperEvaluationDbRow>(
    `SELECT a.id                                   AS attempt_id,
            a.tenant_id,
            t.name                                 AS tenant_name,
            a.assessment_id,
            COALESCE(asm.name, '(unknown)')        AS assessment_name,
            COALESCE(lvl.label, '')                AS level_label,
            a.submitted_at,
            ROUND((EXTRACT(EPOCH FROM (now() - COALESCE(a.submitted_at, a.started_at))) / 3600.0)::numeric, 1)::float8
                                                   AS age_hours,
            qc.written_count,
            qc.kql_count,
            a.status,
            (a.grading_started_at IS NOT NULL
               AND a.grading_started_at > now() - interval '10 minutes') AS grading_in_progress,
            (a.evaluation_sent_back_at IS NOT NULL) AS sent_back,
            a.evaluation_note                      AS sent_back_note,
            (COUNT(*) OVER ())::int                AS total,
            (COUNT(*) FILTER (WHERE COALESCE(a.submitted_at, a.started_at) <= now() - interval '24 hours') OVER ())::int
                                                   AS older_than_24h
       FROM attempts a
       JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active'
       JOIN users u   ON u.id = a.user_id  AND u.erased_at IS NULL
       LEFT JOIN assessments asm ON asm.id = a.assessment_id
       LEFT JOIN levels lvl      ON lvl.id = asm.level_id
       JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE qv.type IN ('subjective', 'scenario', 'log_analysis'))::int AS written_count,
                COUNT(*) FILTER (WHERE qv.type = 'kql')::int                                       AS kql_count,
                COUNT(*) FILTER (WHERE qv.type NOT IN ('mcq', 'numeric', 'multi_select', 'ordering', 'structured_case'))::int                                      AS non_mcq
           FROM attempt_questions aq
           JOIN question_versions qv -- N21: frozen type, same as 06/09
             ON qv.question_id = aq.question_id AND qv.version = aq.question_version
          WHERE aq.attempt_id = a.id
       ) qc ON qc.non_mcq > 0
      WHERE (a.status IN ('submitted', 'auto_submitted', 'pending_admin_grading')
             OR (a.status = 'graded' AND a.evaluation_released_at IS NULL))
        AND ($1::uuid IS NULL OR a.tenant_id = $1::uuid)
      ORDER BY COALESCE(a.submitted_at, a.started_at) ASC, a.id ASC
      LIMIT ${SUPER_QUEUE_LIMIT}`,
    [opts.tenantId ?? null],
  );

  const items: SuperEvaluationRow[] = res.rows.map((r) => ({
    attempt_id: r.attempt_id,
    tenant_id: r.tenant_id,
    tenant_name: r.tenant_name,
    assessment_id: r.assessment_id,
    assessment_name: r.assessment_name,
    level_label: r.level_label,
    submitted_at: r.submitted_at !== null ? r.submitted_at.toISOString() : null,
    age_hours: r.age_hours,
    written_count: r.written_count,
    kql_count: r.kql_count,
    status: r.status,
    complete: r.status === "graded",
    grading_in_progress: r.grading_in_progress,
    sent_back: r.sent_back,
    sent_back_note: r.sent_back ? r.sent_back_note : null,
  }));

  return {
    items,
    counts: {
      pending: res.rows[0]?.total ?? 0,
      older_than_24h: res.rows[0]?.older_than_24h ?? 0,
    },
  };
}
