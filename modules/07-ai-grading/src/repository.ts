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
// Grading queue query
// ---------------------------------------------------------------------------

export interface QueueRow {
  attempt_id: string;
  candidate_email: string;
  assessment_name: string;
  level_label: string;
  submitted_at: Date | null;
  status: string;
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
       a.status
     FROM attempts a
     JOIN users u ON u.id = a.user_id
     JOIN assessments asmnt ON asmnt.id = a.assessment_id
     LEFT JOIN levels al ON al.id = asmnt.level_id
     WHERE a.status IN ('submitted', 'pending_admin_grading')
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
    prompt_version_sha_drift: false,
  }));
}
