import { streamLogger, ValidationError, ConflictError, config, DEFAULT_MAX_PAGE_SIZE } from "@assessiq/core";
import type { PoolClient } from "pg";
import { AL_ERROR_CODES } from "../types.js";

export const log = streamLogger("app");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = DEFAULT_MAX_PAGE_SIZE;

/** Per-call cap of the bulk resend (mirrors the CSV import's 200-invite cap). */
export const BULK_RESEND_MAX = 200;

/**
 * The bulk resend leaves alone any link that was (re)issued by a resend within
 * this window — it is what lets repeated clicks walk through a cohort larger
 * than BULK_RESEND_MAX instead of looping on the first batch (migration 0117).
 */
// S7/N5: one bulk resend per candidate per 24 h; the single-invitation Resend button is not affected.
export const BULK_RESEND_RECENT_MINUTES = 24 * 60;


/**
 * Read once at module load — never shell out per inviteUsers call.
 * Callers that need a different base URL set ASSESSIQ_BASE_URL before
 * the process starts (see modules/00-core/src/config.ts).
 */
export const PUBLIC_URL = config.ASSESSIQ_BASE_URL;

// ---------------------------------------------------------------------------
// Local helpers (mirror 04-question-bank pattern — re-implemented locally)
// ---------------------------------------------------------------------------

export function assertPageSize(pageSize: number): void {
  if (pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `pageSize must not exceed ${MAX_PAGE_SIZE}`,
      { details: { code: AL_ERROR_CODES.INVALID_PAGE_SIZE, pageSize, max: MAX_PAGE_SIZE } },
    );
  }
}

/**
 * Translate a Postgres unique-violation (23505) to a ConflictError with the
 * given domain error code. Re-throws all other errors unchanged.
 */
function _rethrowUnique(err: unknown, code: string, message: string): never {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  ) {
    throw new ConflictError(message, { details: { code } });
  }
  throw err;
}

/**
 * Count active questions for a (pack_id, level_id) pair.
 *
 * Uses a direct client.query rather than qbRepo.listQuestionRows because the
 * list helper is paginated and would require a two-pass COUNT workaround.
 * RLS still applies — the client is already scoped to the current tenant via
 * withTenant. Flagged: a `countActiveQuestionsForLevel(client, packId, levelId)`
 * helper should be added to 04-question-bank's repository to remove this
 * inline SQL from module 05.
 */
export async function countActiveQuestionsForLevel(
  client: PoolClient,
  packId: string,
  levelId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND status = 'active'`,
    [packId, levelId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

/**
 * EXP-18 review gate. Active questions of the (pack, level) pool whose review_state is set and is not
 * 'verified' (in_review, disputed, needs_fix). NULL means "no verification concept" (legacy and
 * ungated content) and does not block. Returns the total count and up to `cap` ids (ids only).
 * The whole (pack, level) active set is what freezeAssessmentPool snapshots, so one check covers the
 * whole-pool, section and blueprint (category and Z-43 node) draw paths. RLS scopes it to the tenant.
 */
export async function listUnverifiedPoolQuestions(
  client: PoolClient,
  packId: string,
  levelId: string,
  cap = 50,
): Promise<{ count: number; ids: string[] }> {
  const r = await client.query<{ id: string; total: string }>(
    `SELECT id, count(*) OVER () AS total FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND status = 'active'
       AND review_state IS NOT NULL AND review_state <> 'verified'
     ORDER BY id LIMIT $3`,
    [packId, levelId, cap],
  );
  return { count: parseInt(r.rows[0]?.total ?? "0", 10), ids: r.rows.map((x) => x.id) };
}

/**
 * Pull up to `limit` active questions for a (pack_id, level_id) pair.
 * Used by previewAssessment — no write to attempts, no snapshot.
 *
 * Same rationale as countActiveQuestionsForLevel: direct SQL inside the
 * tenant-scoped client. A `listActiveQuestionsForLevel(client, packId,
 * levelId, limit)` helper in 04's repository would be the clean follow-up.
 */
export async function listActiveQuestionsForPreview(
  client: PoolClient,
  packId: string,
  levelId: string,
  limit: number,
): Promise<unknown[]> {
  const QUESTION_COLUMNS =
    `id, pack_id, level_id, type, topic, points, status, version,
     content, rubric, created_by, created_at, updated_at,
     difficulty_est, review_state, language_primary, content_i18n`;
  const result = await client.query(
    `SELECT ${QUESTION_COLUMNS} FROM questions
     WHERE pack_id = $1 AND level_id = $2 AND status = 'active'
     ORDER BY created_at ASC, id ASC
     LIMIT $3`,
    [packId, levelId, limit],
  );
  return result.rows;
}

