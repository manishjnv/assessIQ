import { streamLogger, ValidationError, ConflictError, config, DEFAULT_MAX_PAGE_SIZE } from "@assessiq/core";
import type { PoolClient } from "pg";
import { getInviteLimit } from "@assessiq/billing";
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
/** Z-52: a Postgres deadlock (40P01) on a share-lock becomes a retryable 409. Locks are in id order, so this is a backstop. */
async function lockOrRetry(client: PoolClient, sql: string, params: unknown[]): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (err) {
    if ((err as { code?: unknown }).code === "40P01") {
      throw new ConflictError("The questions changed at the same moment. Retry the request.", {
        details: { code: AL_ERROR_CODES.DEADLOCK_RETRY, retry: true },
      });
    }
    throw err;
  }
}

export async function listUnverifiedPoolQuestions(
  client: PoolClient,
  packId: string,
  levelId: string,
  cap = 50,
): Promise<{ count: number; ids: string[] }> {
  // Race guard: share-lock the pool rows (id order, same as the review writers) so a concurrent
  // Needs fix / verify cannot change a row between this check and the freeze that follows. A review
  // write waits for our commit; if it committed first, the check below reads its result.
  await lockOrRetry(
    client,
    `SELECT id FROM questions WHERE pack_id = $1 AND level_id = $2 AND status = 'active' ORDER BY id FOR SHARE`,
    [packId, levelId],
  );
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
 * EXP-18 review gate on the FROZEN pool of one assessment (the questions candidates will really get).
 * Share-locks the questions first (race guard, see listUnverifiedPoolQuestions), then lists the
 * unverified ones. NULL review_state does not block.
 */
export async function listUnverifiedFrozenQuestions(
  client: PoolClient,
  assessmentId: string,
  cap = 50,
): Promise<{ count: number; ids: string[] }> {
  await lockOrRetry(
    client,
    `SELECT q.id FROM assessment_frozen_pool f JOIN questions q ON q.id = f.question_id
      WHERE f.assessment_id = $1 ORDER BY q.id FOR SHARE OF q`,
    [assessmentId],
  );
  const r = await client.query<{ id: string; total: string }>(
    `SELECT q.id, count(*) OVER () AS total FROM assessment_frozen_pool f JOIN questions q ON q.id = f.question_id
      WHERE f.assessment_id = $1 AND q.review_state IS NOT NULL AND q.review_state <> 'verified'
      ORDER BY q.id LIMIT $2`,
    [assessmentId, cap],
  );
  return { count: parseInt(r.rows[0]?.total ?? "0", 10), ids: r.rows.map((x) => x.id) };
}

/** One error shape for every EXP-18 block (publish, invite, resend): code QUESTIONS_NOT_VERIFIED. */
export function questionsNotVerifiedError(
  action: string,
  unverified: { count: number; ids: string[] },
): ValidationError {
  return new ValidationError(
    `Cannot ${action}: ${unverified.count} question(s) in the pool are not verified`,
    {
      details: {
        code: AL_ERROR_CODES.QUESTIONS_NOT_VERIFIED,
        count: unverified.count,
        question_ids: unverified.ids,
      },
    },
  );
}

/**
 * Invite / resend gate. Checks the frozen pool when the assessment has one, else the live
 * (pack, level) pool (legacy assessments published before migration 0096).
 */
export async function assertPoolVerifiedForInvites(
  client: PoolClient,
  assessment: { id: string; pack_id: string; level_id: string },
  action = "send invitations",
): Promise<void> {
  const frozen = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM assessment_frozen_pool WHERE assessment_id = $1`,
    [assessment.id],
  );
  const hasFrozen = parseInt(frozen.rows[0]?.n ?? "0", 10) > 0;
  const unverified = hasFrozen
    ? await listUnverifiedFrozenQuestions(client, assessment.id)
    : await listUnverifiedPoolQuestions(client, assessment.pack_id, assessment.level_id);
  if (unverified.count > 0) throw questionsNotVerifiedError(action, unverified);
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


/**
 * EXP-23: distinct section pack ids that differ from the assessment pack (empty = every section uses the
 * assessment pack, the behaviour before EXP-23). Reads raw settings, so it never throws.
 */
export function sectionPackIds(settings: unknown, assessmentPackId: string): string[] {
  const raw = (settings as { sections?: unknown } | null | undefined)?.sections;
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  for (const s of raw as Array<{ pack_id?: unknown }>) {
    if (typeof s?.pack_id === "string" && s.pack_id !== assessmentPackId) ids.add(s.pack_id);
  }
  return [...ids];
}

/**
 * EXP-23: the level of `packId` that sits at the same position as `levelId` (a section pack has its own
 * levels; the assessment level fixes the position). Null = the pack has no level at that position.
 */
export async function levelAtSamePosition(client: PoolClient, packId: string, levelId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT l.id FROM levels l WHERE l.pack_id = $1 AND l.position = (SELECT position FROM levels WHERE id = $2)`,
    [packId, levelId],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * EXP-23 write guard: every section pack_id must be a published question set of THIS tenant (RLS plus the
 * explicit tenant filter). Another tenant's pack, or a missing one, gives the same error.
 */
export async function assertSectionPacksUsable(client: PoolClient, tenantId: string, assessmentPackId: string, settings: unknown): Promise<void> {
  const ids = sectionPackIds(settings, assessmentPackId);
  if (ids.length === 0) return;
  const r = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM question_packs WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
    [ids, tenantId],
  );
  const found = new Map(r.rows.map((x) => [x.id, x.status]));
  for (const id of ids) {
    const st = found.get(id);
    if (st === undefined || st !== "published") {
      throw new ValidationError("A section question set does not exist, is not published, or is not visible to this organisation", {
        details: { code: "INVALID_PARAM", param: "settings.sections.pack_id", pack_id: id },
      });
    }
  }
}

/**
 * EXP-37: refuse when `adding` NEW active invitations would take one assessment past the plan limit.
 * Active = status pending, viewed or started (submitted, expired and revoked do not count).
 * Call it on the invite transaction's client BEFORE anything is inserted or mailed. A per-assessment
 * advisory lock (held to commit) serialises concurrent invites for the same assessment, so two
 * parallel calls at the boundary cannot both pass. Limit null (unlimited) returns at once.
 */
export async function assertInviteCapacity(
  client: PoolClient,
  tenantId: string,
  assessmentId: string,
  adding: number,
): Promise<void> {
  if (adding <= 0) return;
  const limit = await getInviteLimit(client, tenantId);
  if (limit === null) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('invite_limit:' || $1::text, 0))", [assessmentId]);
  const res = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM assessment_invitations
      WHERE assessment_id = $1 AND status IN ('pending', 'viewed', 'started')`,
    [assessmentId],
  );
  const active = parseInt(res.rows[0]?.n ?? "0", 10);
  if (active + adding > limit) {
    throw new ConflictError(
      `This setup supports up to ${String(limit)} students for one assessment. Split the group into two assessments at different times, or contact support to raise the limit.`,
      { details: { code: AL_ERROR_CODES.INVITE_LIMIT_EXCEEDED, limit, active, adding, assessment_id: assessmentId } },
    );
  }
}
