/**
 * Repository layer for the assessments and assessment_invitations tables.
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
 * Exception — assessments INSERT passes tenant_id:
 * The assessments table has its own `tenant_id` column and a WITH CHECK RLS
 * policy that requires the inserted row's tenant_id to match app.current_tenant.
 * Passing tenant_id in the INSERT column list satisfies that constraint.
 * This is an RLS-enforced write constraint, not a filter.
 *
 * Child table (assessment_invitations) has NO `tenant_id` column at all.
 * Its RLS policies derive tenancy through the assessment_id foreign key:
 *   assessment_invitations → assessments.tenant_id  (one-hop EXISTS)
 * There is therefore no tenant_id to pass in that INSERT — the WITH CHECK
 * policy resolves authorization through the parent FK, not a direct column
 * match. Do not attempt to add tenant_id to the assessment_invitations INSERT.
 *
 * Transaction semantics:
 * This module issues individual queries against the supplied PoolClient. It
 * does NOT call BEGIN, COMMIT, or ROLLBACK. The caller is responsible for
 * wrapping operations in a transaction (via withTenant or explicit
 * BEGIN/COMMIT). Functions that run multiple statements (bulkUpdateBoundaries)
 * are safe to call inside an existing transaction — they do not start a nested
 * transaction.
 */

import type { PoolClient } from "pg";
import type {
  Assessment,
  AssessmentInvitation,
  AssessmentStatus,
  InvitationStatus,
  ListAssessmentsInput,
  ListInvitationsInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Column constants
// ---------------------------------------------------------------------------

const ASSESSMENT_COLUMNS = `id, tenant_id, pack_id, level_id, pack_version, name, description, status, question_count, randomize, opens_at, closes_at, settings, created_by, created_at, updated_at`;

const INVITATION_COLUMNS = `id, assessment_id, user_id, token_hash, expires_at, status, invited_by, created_at`;

// ---------------------------------------------------------------------------
// Row interfaces (raw Postgres types before mapping)
// ---------------------------------------------------------------------------

interface AssessmentRow {
  id: string;
  tenant_id: string;
  pack_id: string;
  level_id: string;
  pack_version: number;
  name: string;
  description: string | null;
  status: string;
  question_count: number;
  randomize: boolean;
  opens_at: Date | null;
  closes_at: Date | null;
  settings: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface InvitationRow {
  id: string;
  assessment_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  status: string;
  invited_by: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Mapper functions
// ---------------------------------------------------------------------------

function mapAssessmentRow(row: AssessmentRow): Assessment {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    pack_id: row.pack_id,
    level_id: row.level_id,
    pack_version: row.pack_version,
    name: row.name,
    description: row.description,
    status: row.status as AssessmentStatus,
    question_count: row.question_count,
    randomize: row.randomize,
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    // settings comes back as unknown from JSONB; cast through the domain type.
    // The DB DEFAULT is '{}'::jsonb; AssessmentSettings is z.object({}).passthrough().
    settings: (row.settings ?? {}) as Assessment["settings"],
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapInvitationRow(row: InvitationRow): AssessmentInvitation {
  return {
    id: row.id,
    assessment_id: row.assessment_id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    expires_at: row.expires_at,
    status: row.status as InvitationStatus,
    invited_by: row.invited_by,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Assessment queries
// ---------------------------------------------------------------------------

export async function findAssessmentById(
  client: PoolClient,
  id: string,
): Promise<Assessment | null> {
  const result = await client.query<AssessmentRow>(
    `SELECT ${ASSESSMENT_COLUMNS} FROM assessments WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapAssessmentRow(row) : null;
}

export async function listAssessmentRows(
  client: PoolClient,
  filters: ListAssessmentsInput,
): Promise<{ items: Assessment[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (filters.status !== undefined) {
    conditions.push(`status = $${i}`);
    values.push(filters.status);
    i++;
  }

  if (filters.packId !== undefined) {
    conditions.push(`pack_id = $${i}`);
    values.push(filters.packId);
    i++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Separate count query against the same WHERE clause.
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessments ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const dataResult = await client.query<AssessmentRow>(
    `SELECT ${ASSESSMENT_COLUMNS} FROM assessments ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  return { items: dataResult.rows.map(mapAssessmentRow), total };
}

export async function insertAssessment(
  client: PoolClient,
  input: {
    id: string;
    tenantId: string;
    packId: string;
    levelId: string;
    packVersion: number;
    name: string;
    description?: string;
    questionCount: number;
    randomize: boolean;
    opensAt?: Date | null;
    closesAt?: Date | null;
    settings: Record<string, unknown>;
    createdBy: string;
  },
): Promise<Assessment> {
  // tenant_id is explicitly passed to satisfy the WITH CHECK RLS policy on
  // assessments (requires inserted row's tenant_id = app.current_tenant).
  // status defaults to 'draft' per DB schema — not included in the column list.
  const result = await client.query<AssessmentRow>(
    `INSERT INTO assessments
       (id, tenant_id, pack_id, level_id, pack_version, name, description,
        question_count, randomize, opens_at, closes_at, settings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     RETURNING ${ASSESSMENT_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.packId,
      input.levelId,
      input.packVersion,
      input.name,
      input.description ?? null,
      input.questionCount,
      input.randomize,
      input.opensAt ?? null,
      input.closesAt ?? null,
      JSON.stringify(input.settings),
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertAssessment: INSERT returned no row");
  }
  return mapAssessmentRow(row);
}

export async function updateAssessmentRow(
  client: PoolClient,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    questionCount?: number;
    randomize?: boolean;
    opensAt?: Date | null;
    closesAt?: Date | null;
    settings?: Record<string, unknown>;
    status?: AssessmentStatus;
  },
): Promise<Assessment> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i}`);
    values.push(patch.name);
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
  if (patch.questionCount !== undefined) {
    sets.push(`question_count = $${i}`);
    values.push(patch.questionCount);
    i++;
  }
  if (patch.randomize !== undefined) {
    sets.push(`randomize = $${i}`);
    values.push(patch.randomize);
    i++;
  }
  if (patch.opensAt !== undefined) {
    if (patch.opensAt === null) {
      sets.push(`opens_at = NULL`);
    } else {
      sets.push(`opens_at = $${i}`);
      values.push(patch.opensAt);
      i++;
    }
  }
  if (patch.closesAt !== undefined) {
    if (patch.closesAt === null) {
      sets.push(`closes_at = NULL`);
    } else {
      sets.push(`closes_at = $${i}`);
      values.push(patch.closesAt);
      i++;
    }
  }
  if (patch.settings !== undefined) {
    sets.push(`settings = $${i}::jsonb`);
    values.push(JSON.stringify(patch.settings));
    i++;
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i}`);
    values.push(patch.status);
    i++;
  }

  sets.push(`updated_at = now()`);

  values.push(id);
  const result = await client.query<AssessmentRow>(
    `UPDATE assessments SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${ASSESSMENT_COLUMNS}`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateAssessmentRow: no row found for id ${id}`);
  }
  return mapAssessmentRow(row);
}

/**
 * Bulk status boundary update — called by the cron boundary job once per
 * tenant (the caller iterates tenants externally and wraps each call in
 * withTenant so RLS scopes to exactly one tenant).
 *
 * Three atomic UPDATEs in one server round-trip each:
 *
 *   (1) published → active:
 *       opens_at <= now  AND  (closes_at IS NULL OR closes_at > now)
 *       — the window is open and the far end has not passed yet.
 *
 *   (2) active → closed:
 *       closes_at IS NOT NULL AND closes_at <= now
 *       — the close boundary has been crossed.
 *
 *   (3) published → closed (skip straight to closed):
 *       opens_at IS NOT NULL AND closes_at IS NOT NULL
 *       AND opens_at <= now AND closes_at <= now
 *       — the entire window is already in the past; the job
 *         ran late or the assessment was published after closes_at.
 *
 * Returns { activated, closed } where `closed` is the sum of (2) and (3).
 */
export async function bulkUpdateBoundaries(
  client: PoolClient,
  now: Date,
): Promise<{ activated: number; closed: number }> {
  // (1) published → active
  const activateResult = await client.query(
    `UPDATE assessments
     SET status = 'active', updated_at = now()
     WHERE status = 'published'
       AND opens_at IS NOT NULL
       AND opens_at <= $1
       AND (closes_at IS NULL OR closes_at > $1)`,
    [now],
  );
  const activated = activateResult.rowCount ?? 0;

  // (2) active → closed
  const closeActiveResult = await client.query(
    `UPDATE assessments
     SET status = 'closed', updated_at = now()
     WHERE status = 'active'
       AND closes_at IS NOT NULL
       AND closes_at <= $1`,
    [now],
  );
  const closedFromActive = closeActiveResult.rowCount ?? 0;

  // (3) published → closed (entire window already in the past)
  const closePublishedResult = await client.query(
    `UPDATE assessments
     SET status = 'closed', updated_at = now()
     WHERE status = 'published'
       AND opens_at IS NOT NULL
       AND closes_at IS NOT NULL
       AND opens_at <= $1
       AND closes_at <= $1`,
    [now],
  );
  const closedFromPublished = closePublishedResult.rowCount ?? 0;

  return {
    activated,
    closed: closedFromActive + closedFromPublished,
  };
}

// ---------------------------------------------------------------------------
// Assessment invitation queries
// ---------------------------------------------------------------------------

export async function findInvitationById(
  client: PoolClient,
  id: string,
): Promise<AssessmentInvitation | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM assessment_invitations WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

export async function findInvitationByTokenHash(
  client: PoolClient,
  tokenHash: string,
): Promise<AssessmentInvitation | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM assessment_invitations WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

export async function findInvitationByAssessmentAndUser(
  client: PoolClient,
  assessmentId: string,
  userId: string,
): Promise<AssessmentInvitation | null> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM assessment_invitations
     WHERE assessment_id = $1 AND user_id = $2
     LIMIT 1`,
    [assessmentId, userId],
  );
  const row = result.rows[0];
  return row !== undefined ? mapInvitationRow(row) : null;
}

export async function listInvitationRows(
  client: PoolClient,
  assessmentId: string,
  filters: ListInvitationsInput,
): Promise<{ items: AssessmentInvitation[]; total: number }> {
  const conditions: string[] = [`assessment_id = $1`];
  const values: unknown[] = [assessmentId];
  let i = 2;

  if (filters.status !== undefined) {
    conditions.push(`status = $${i}`);
    values.push(filters.status);
    i++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessment_invitations ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const dataResult = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM assessment_invitations ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...values, pageSize, offset],
  );

  return { items: dataResult.rows.map(mapInvitationRow), total };
}

export async function countInvitationsForAssessment(
  client: PoolClient,
  assessmentId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM assessment_invitations WHERE assessment_id = $1`,
    [assessmentId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function insertInvitation(
  client: PoolClient,
  input: {
    id: string;
    assessmentId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    invitedBy: string;
  },
): Promise<AssessmentInvitation> {
  // assessment_invitations has no tenant_id column — the WITH CHECK RLS policy
  // derives authorization through assessment_id → assessments.tenant_id.
  // status defaults to 'pending' per DB schema — not included in the column list.
  const result = await client.query<InvitationRow>(
    `INSERT INTO assessment_invitations
       (id, assessment_id, user_id, token_hash, expires_at, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${INVITATION_COLUMNS}`,
    [
      input.id,
      input.assessmentId,
      input.userId,
      input.tokenHash,
      input.expiresAt,
      input.invitedBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("insertInvitation: INSERT returned no row");
  }
  return mapInvitationRow(row);
}

export async function updateInvitationStatus(
  client: PoolClient,
  id: string,
  status: InvitationStatus,
): Promise<AssessmentInvitation> {
  const result = await client.query<InvitationRow>(
    `UPDATE assessment_invitations SET status = $1 WHERE id = $2
     RETURNING ${INVITATION_COLUMNS}`,
    [status, id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`updateInvitationStatus: no row found for id ${id}`);
  }
  return mapInvitationRow(row);
}

// ---------------------------------------------------------------------------
// User lookup helper (used by service-layer pre-flight checks)
// ---------------------------------------------------------------------------

/**
 * Returns the user's id, role, status, email, and name if the user exists in
 * the current tenant (RLS-scoped through app.current_tenant). Returns null if
 * not found.
 *
 * Used by inviteUsers to validate user IDs before issuance and to enforce
 * "user must not be disabled / soft-deleted" in one round-trip.
 */
export async function findUserForInvitation(
  client: PoolClient,
  userId: string,
): Promise<{ id: string; role: string; status: string; email: string; name: string } | null> {
  interface UserRow {
    id: string;
    role: string;
    status: string;
    email: string;
    name: string;
  }

  const result = await client.query<UserRow>(
    `SELECT id, role, status, email, name FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    email: row.email,
    name: row.name,
  };
}
