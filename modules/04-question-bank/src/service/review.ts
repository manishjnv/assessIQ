/**
 * EXP-18 part 2: question review gate (Verify, Needs fix, Withdraw, bulk Verify all).
 *
 * Who may review what (checked here in the service; the route handler checks the role too):
 *   - role must be admin or super_admin;
 *   - the pack must belong to the caller's own tenant (RLS already hides other tenants; the explicit
 *     check below is the second line);
 *   - a PLATFORM question (pack in the tenant with slug 'platform') only by a super_admin;
 *   - an ORGANISATION question only by an admin of that organisation.
 * Every state change writes one audit row (actor, previous state, new state, note id; never the note
 * text) in the same tx. A note goes to the append-only table question_review_notes (Z-52 gap 6).
 * Rows are locked FOR UPDATE in id order; module 05 share-locks the same rows in id order at publish
 * and invite, so a review write and the publish gate cannot interleave.
 */

import { AuthzError, ConflictError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant, withSystemRoleDetached } from "@assessiq/tenancy";
import { licensedQuestionSql, mayReadMasterKey, redactMasterKey } from "@assessiq/question-types";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";
import { QB_ERROR_CODES } from "../types.js";
import type { ReviewState } from "../types.js";
import * as repo from "../repository.js";
import { withdrawInTx } from "./questions.js";
import { getPlatformTenantId } from "../clone/helpers.js";

export const REVIEW_ACTIONS = ["verify", "needs_fix", "dispute", "withdraw"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
// EXP-28: "reported" = at least one candidate report on the question (table question_reports, migration 0268).
export const REVIEW_FILTERS = ["open", "all", "in_review", "verified", "disputed", "needs_fix", "none", "reported"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export interface ReviewActor {
  tenantId: string;
  userId: string;
  role: string;
}

/**
 * Z-52 gap 3: a Postgres deadlock (40P01) becomes a retryable 409. Rows are locked in id order in every
 * review and publish path, so this should not happen; if it still does, the tx is already rolled back
 * and the caller can safely repeat the request.
 */
export function asRetryableDeadlock(err: unknown): unknown {
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "40P01") {
    return new ConflictError("The review changed at the same moment as another change. Retry the request.", {
      details: { code: QB_ERROR_CODES.DEADLOCK_RETRY, retry: true },
    });
  }
  return err;
}

export const NOTE_MAX = 1000;
export const REVIEW_PAGE_MAX = 100;

/** Role gate shared by the handler and the service. Throws 403 for any role but admin and super_admin. */
export function assertReviewRole(role: string | undefined): asserts role is "admin" | "super_admin" {
  if (role !== "admin" && role !== "super_admin") throw new AuthzError("admin or super_admin required");
}

/** Role against the caller's own tenant: platform only for a super_admin, an organisation only for an admin. Returns isPlatform. */
export async function assertRoleFitsTenant(client: PoolClient, actor: ReviewActor): Promise<boolean> {
  assertReviewRole(actor.role);
  const t = await client.query<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [actor.tenantId]);
  const isPlatform = t.rows[0]?.slug === "platform";
  if (isPlatform && actor.role !== "super_admin") {
    throw new AuthzError("Only a super admin may review platform questions");
  }
  if (!isPlatform && actor.role !== "admin") {
    throw new AuthzError("Only an organisation admin may review organisation questions");
  }
  return isPlatform;
}

/** Pack-level authorisation: own tenant, and platform packs only for a super_admin. */
async function assertMayReviewPack(client: PoolClient, actor: ReviewActor, packTenantId: string): Promise<void> {
  assertReviewRole(actor.role);
  if (packTenantId !== actor.tenantId) {
    throw new NotFoundError("Question set not found", { details: { code: QB_ERROR_CODES.PACK_NOT_FOUND } });
  }
  await assertRoleFitsTenant(client, actor);
}

interface LockedQuestion {
  id: string;
  pack_id: string;
  status: string;
  review_state: ReviewState | null;
  version: number;
  pack_tenant_id: string;
  withdrawn: boolean;
}

async function lockQuestion(client: PoolClient, id: string): Promise<LockedQuestion | null> {
  const r = await client.query<LockedQuestion>(
    `SELECT q.id, q.pack_id, q.status, q.review_state, q.version, p.tenant_id AS pack_tenant_id,
            COALESCE(s.rights_status = 'withdrawn', false) AS withdrawn
       FROM questions q
       JOIN question_packs p ON p.id = q.pack_id
       LEFT JOIN question_source s ON s.question_id = q.id
      WHERE q.id = $1
        FOR UPDATE OF q`,
    [id],
  );
  return r.rows[0] ?? null;
}

export interface ReviewResult {
  id: string;
  review_state: ReviewState | null;
  status: string;
  changed: boolean;
}

/** Verify, Needs fix or Dispute (note required for both), or Withdraw one question. */
export async function reviewQuestion(
  actor: ReviewActor,
  id: string,
  action: ReviewAction,
  note?: string,
): Promise<ReviewResult> {
  assertReviewRole(actor.role);
  const trimmed = (note ?? "").trim();
  if ((action === "needs_fix" || action === "dispute") && trimmed.length === 0) {
    throw new ValidationError(`A note is required for ${action === "dispute" ? "Dispute" : "Needs fix"}`, { details: { code: QB_ERROR_CODES.REVIEW_NOTE_REQUIRED } });
  }
  if (trimmed.length > NOTE_MAX) {
    throw new ValidationError(`The note must not exceed ${NOTE_MAX} characters`, { details: { code: QB_ERROR_CODES.REVIEW_NOTE_REQUIRED } });
  }

  return withTenant(actor.tenantId, async (client) => {
    const q = await lockQuestion(client, id);
    if (q === null) {
      throw new NotFoundError(`Question not found: ${id}`, { details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND } });
    }
    await assertMayReviewPack(client, actor, q.pack_tenant_id);

    if (action === "withdraw") {
      const current = await repo.findQuestionById(client, id);
      if (current === null) {
        throw new NotFoundError(`Question not found: ${id}`, { details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND } });
      }
      await withdrawInTx(client, actor.tenantId, actor.userId, current, trimmed.length > 0 ? trimmed : undefined);
      return { id, review_state: q.review_state, status: "archived", changed: !q.withdrawn };
    }

    if (q.withdrawn) {
      throw new ConflictError("This question was withdrawn and cannot be reviewed", {
        details: { code: QB_ERROR_CODES.QUESTION_WITHDRAWN },
      });
    }
    if (q.status === "archived") {
      throw new ConflictError("This question is archived and cannot be reviewed", {
        details: { code: QB_ERROR_CODES.QUESTION_ARCHIVED },
      });
    }
    const next: ReviewState = action === "verify" ? "verified" : action === "dispute" ? "disputed" : "needs_fix";
    if (q.review_state === next && action === "verify") {
      return { id, review_state: next, status: q.status, changed: false };
    }
    await client.query(`UPDATE questions SET review_state = $2 WHERE id = $1`, [id, next]);
    const noteId = trimmed.length > 0
      ? await repo.insertReviewNote(client, { tenantId: actor.tenantId, questionId: id, version: q.version, state: next, note: trimmed, authorUserId: actor.userId })
      : undefined;
    await auditInTx(client, {
      tenantId: actor.tenantId,
      actorKind: "user",
      actorUserId: actor.userId,
      action: "question.review_changed",
      entityType: "question",
      entityId: id,
      before: { review_state: q.review_state },
      after: { review_state: next, action, ...(noteId !== undefined ? { note_id: noteId } : {}), bulk: false },
    });
    // Z-52 gap 1 and 7: Needs fix or Disputed on a platform master blocks its tenant clones too.
    if (next === "needs_fix" || next === "disputed") await propagateBlock(id, next);
    return { id, review_state: next, status: q.status, changed: true };
  }).catch((err: unknown) => { throw asRetryableDeadlock(err); });
}

/**
 * Z-52 gap 1 (option: propagate on mark, no schema change). A tenant cannot read the platform master
 * (RLS), so the invite and publish gate cannot look it up at read time. Instead, when a PLATFORM master
 * goes to needs_fix or disputed (Z-52 gap 7), every live tenant clone (questions.source_question_id = master) is set to that state
 * in the same tx, so the existing gate blocks it. One system audit row per affected tenant.
 * Not undone when the master is verified again: the clone content may be out of date, so the tenant
 * admin reviews the clone (or re-syncs) to clear it. Same role-switch pattern as propagateTakedown.
 */
async function propagateBlock(masterId: string, target: "needs_fix" | "disputed"): Promise<void> {
  // FUT-10: own system-login tx (the app login cannot SET ROLE assessiq_system); fail-safe if the caller rolls back.
  await withSystemRoleDetached("question.review_block_propagate", (client) => propagateBlockTx(client, masterId, target));
}

async function propagateBlockTx(client: PoolClient, masterId: string, target: "needs_fix" | "disputed"): Promise<void> {
  {
    const platformTenantId = await getPlatformTenantId(client);
    const master = await client.query(
      `SELECT 1 FROM questions m JOIN question_packs mp ON mp.id = m.pack_id WHERE m.id = $1 AND mp.tenant_id = $2`,
      [masterId, platformTenantId],
    );
    if (master.rowCount === 0) return;
    const clones = await client.query<{ id: string; tenant_id: string }>(
      `SELECT cq.id, cp.tenant_id
         FROM questions cq JOIN question_packs cp ON cp.id = cq.pack_id
        WHERE cq.source_question_id = $1 AND cp.tenant_id <> $2 AND cq.status <> 'archived'
          AND cq.review_state IS DISTINCT FROM $3
        ORDER BY cq.id
          FOR UPDATE OF cq`,
      [masterId, platformTenantId, target],
    );
    const byTenant = new Map<string, string[]>();
    for (const r of clones.rows) {
      const list = byTenant.get(r.tenant_id) ?? [];
      list.push(r.id);
      byTenant.set(r.tenant_id, list);
    }
    for (const [tenantId, ids] of byTenant) {
      await client.query(
        `UPDATE questions q SET review_state = $3 FROM question_packs p
          WHERE q.id = ANY($1::uuid[]) AND p.id = q.pack_id AND p.tenant_id = $2`,
        [ids, tenantId, target],
      );
      await client.query("SET LOCAL ROLE assessiq_app");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      await auditInTx(client, {
        tenantId,
        actorKind: "system",
        ip: null,
        userAgent: null,
        action: "question.review_changed",
        entityType: "question",
        entityId: masterId,
        after: { review_state: target, action: `${target}_propagated`, source_question_id: masterId, clone_question_ids: ids },
      });
      await client.query("RESET ROLE"); // back to the system login (FUT-10)
    }
  }
}

/**
 * Verify every in_review question of one pack. `expectedCount` is the number the admin saw in the
 * confirm step; a different current count means the pack changed meanwhile, so nothing is written.
 * Z-52 gap 4: when `expectedIds` is given, the live set must equal it exactly (swapping one question
 * for another keeps the count, so a count alone cannot see it); otherwise 409 and nothing is written.
 * Needs-fix and disputed questions are NOT touched (each needs its own look). One audit row per question.
 */
export async function bulkVerifyPack(
  actor: ReviewActor,
  packId: string,
  expectedCount: number | undefined,
  expectedIds?: string[],
): Promise<{ verified: number }> {
  assertReviewRole(actor.role);
  return withTenant(actor.tenantId, async (client) => {
    const pack = await repo.findPackById(client, packId);
    if (pack === null) {
      throw new NotFoundError(`Question set not found: ${packId}`, { details: { code: QB_ERROR_CODES.PACK_NOT_FOUND } });
    }
    await assertMayReviewPack(client, actor, pack.tenant_id);

    const rows = (await client.query<{ id: string }>(
      `SELECT q.id FROM questions q
        WHERE q.pack_id = $1 AND q.review_state = 'in_review' AND q.status <> 'archived'
          AND NOT EXISTS (SELECT 1 FROM question_source w WHERE w.question_id = q.id AND w.rights_status = 'withdrawn')
        ORDER BY q.id
          FOR UPDATE OF q`,
      [packId],
    )).rows;
    if (expectedIds !== undefined) {
      const want = new Set(expectedIds);
      const have = new Set(rows.map((r) => r.id));
      const gone = [...want].filter((x) => !have.has(x)).length;
      const added = [...have].filter((x) => !want.has(x)).length;
      if (gone > 0 || added > 0) {
        throw new ConflictError(
          `The set of questions to verify changed (${added} new, ${gone} gone). Review the list and confirm again.`,
          { details: { code: QB_ERROR_CODES.REVIEW_COUNT_CHANGED, expected: want.size, actual: have.size, new_count: added, gone_count: gone } },
        );
      }
    }
    if (expectedCount !== undefined && rows.length !== expectedCount) {
      throw new ConflictError(
        `The number of questions to verify changed from ${expectedCount} to ${rows.length}. Review the list and confirm again.`,
        { details: { code: QB_ERROR_CODES.REVIEW_COUNT_CHANGED, expected: expectedCount, actual: rows.length } },
      );
    }
    if (rows.length === 0) return { verified: 0 };

    const ids = rows.map((r) => r.id);
    await client.query(`UPDATE questions SET review_state = 'verified' WHERE id = ANY($1::uuid[])`, [ids]);
    for (const qid of ids) {
      await auditInTx(client, {
        tenantId: actor.tenantId,
        actorKind: "user",
        actorUserId: actor.userId,
        action: "question.review_changed",
        entityType: "question",
        entityId: qid,
        before: { review_state: "in_review" },
        after: { review_state: "verified", action: "verify", bulk: true, pack_id: packId },
      });
    }
    return { verified: ids.length };
  }).catch((err: unknown) => { throw asRetryableDeadlock(err); });
}

export interface ReviewItem {
  id: string;
  level_id: string;
  type: string;
  topic: string;
  points: number;
  status: string;
  review_state: ReviewState | null;
  content: unknown;
  rubric: unknown;
  answer_guidance: string | null;
  origin: string | null;
  rights_status: string | null;
  source_ref: string | null;
  source_url: string | null;
  /** FUT-2: true for licensed content; the key fields above are then redacted for an organisation admin. */
  licensed?: boolean;
}

export interface PackReview {
  pack: { id: string; name: string; status: string; is_platform: boolean };
  counts: Record<"in_review" | "verified" | "disputed" | "needs_fix" | "none", number>;
  total: number;
  items: ReviewItem[];
}

const FILTER_SQL: Record<ReviewFilter, string> = {
  open: `q.review_state IN ('in_review', 'disputed', 'needs_fix')`,
  all: `TRUE`,
  in_review: `q.review_state = 'in_review'`,
  verified: `q.review_state = 'verified'`,
  disputed: `q.review_state = 'disputed'`,
  needs_fix: `q.review_state = 'needs_fix'`,
  none: `q.review_state IS NULL`,
  reported: `EXISTS (SELECT 1 FROM question_reports r WHERE r.question_id = q.id)`,
};

/** Questions of one pack for the review screen (answer key included, so the same authorisation as the actions). */
export async function getPackReview(
  actor: ReviewActor,
  packId: string,
  filter: ReviewFilter,
  page: number,
  pageSize: number,
): Promise<PackReview> {
  assertReviewRole(actor.role);
  const size = Math.min(Math.max(pageSize, 1), REVIEW_PAGE_MAX);
  const offset = Math.max(page - 1, 0) * size;
  return withTenant(actor.tenantId, async (client) => {
    const pack = await repo.findPackById(client, packId);
    if (pack === null) {
      throw new NotFoundError(`Question set not found: ${packId}`, { details: { code: QB_ERROR_CODES.PACK_NOT_FOUND } });
    }
    await assertMayReviewPack(client, actor, pack.tenant_id);

    const live = `q.pack_id = $1 AND q.status <> 'archived'
                  AND NOT EXISTS (SELECT 1 FROM question_source w WHERE w.question_id = q.id AND w.rights_status = 'withdrawn')`;
    const counted = await client.query<{ s: string; n: string }>(
      `SELECT COALESCE(q.review_state, 'none') AS s, count(*) AS n FROM questions q WHERE ${live} GROUP BY 1`,
      [packId],
    );
    const counts = { in_review: 0, verified: 0, disputed: 0, needs_fix: 0, none: 0 };
    for (const r of counted.rows) {
      if (r.s in counts) counts[r.s as keyof typeof counts] = parseInt(r.n, 10);
    }
    const total = (await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM questions q WHERE ${live} AND ${FILTER_SQL[filter]}`,
      [packId],
    )).rows[0]?.n ?? "0";
    const items = await client.query<ReviewItem>(
      `SELECT q.id, q.level_id, q.type, q.topic, q.points, q.status, q.review_state, q.content, q.rubric,
              q.answer_guidance, s.origin, s.rights_status, s.source_ref, s.source_url,
              ${licensedQuestionSql("q")} AS licensed
         FROM questions q LEFT JOIN question_source s ON s.question_id = q.id
        WHERE ${live} AND ${FILTER_SQL[filter]}
        ORDER BY q.created_at, q.id LIMIT $2 OFFSET $3`,
      [packId, size, offset],
    );
    const slug = (await client.query<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [actor.tenantId])).rows[0]?.slug;
    return {
      pack: { id: pack.id, name: pack.name, status: pack.status, is_platform: slug === "platform" },
      counts,
      total: parseInt(total, 10),
      // FUT-2: an organisation admin reviews licensed copies without the master key or source reference.
      items: items.rows.map((r) => (r.licensed === true && !mayReadMasterKey(actor.role) ? redactMasterKey(r) : r)),
    };
  });
}

export interface ReviewQueueItem {
  id: string;
  pack_id: string;
  pack_name: string;
  type: string;
  topic: string;
  status: string;
  version: number;
  review_state: ReviewState | null;
  origin: string | null;
  rights_status: string | null;
  updated_at: Date;
  /** EXP-28: candidate reports on this question (this organisation only). */
  report_count: number;
  /** Z-166: reports on this master question summed over every organisation copy plus the master itself. Platform queue only (null elsewhere). Count only. */
  all_orgs_report_count: number | null;
  latest_note: { note: string; state: string; created_at: Date } | null;
}

export interface ReviewQueue {
  counts: Record<"in_review" | "verified" | "disputed" | "needs_fix" | "none", number>;
  /** EXP-28: questions of this tenant with at least one candidate report. */
  reported: number;
  total: number;
  items: ReviewQueueItem[];
}

/**
 * EXP-12: cross-pack review queue of the CALLER'S OWN tenant (platform tenant for a super_admin, the
 * organisation for an admin). No content and no answer key in the list. Archived and withdrawn rows are
 * left out, like getPackReview. Newest change first.
 */
export async function listReviewQueue(
  actor: ReviewActor,
  filter: ReviewFilter,
  page: number,
  pageSize: number,
): Promise<ReviewQueue> {
  assertReviewRole(actor.role);
  const size = Math.min(Math.max(pageSize, 1), REVIEW_PAGE_MAX);
  const offset = Math.max(page - 1, 0) * size;
  let isPlatform = false;
  const queue = await withTenant(actor.tenantId, async (client) => {
    isPlatform = await assertRoleFitsTenant(client, actor);
    const live = `p.tenant_id = $1 AND q.status <> 'archived'
                  AND NOT EXISTS (SELECT 1 FROM question_source w WHERE w.question_id = q.id AND w.rights_status = 'withdrawn')`;
    const counted = await client.query<{ s: string; n: string }>(
      `SELECT COALESCE(q.review_state, 'none') AS s, count(*) AS n
         FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE ${live} GROUP BY 1`,
      [actor.tenantId],
    );
    const counts = { in_review: 0, verified: 0, disputed: 0, needs_fix: 0, none: 0 };
    for (const r of counted.rows) {
      if (r.s in counts) counts[r.s as keyof typeof counts] = parseInt(r.n, 10);
    }
    const total = (await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE ${live} AND ${FILTER_SQL[filter]}`,
      [actor.tenantId],
    )).rows[0]?.n ?? "0";
    const reported = (await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE ${live} AND ${FILTER_SQL.reported}`,
      [actor.tenantId],
    )).rows[0]?.n ?? "0";
    const rows = await client.query<{
      id: string; pack_id: string; pack_name: string; type: string; topic: string; status: string; version: number;
      review_state: ReviewState | null; origin: string | null; rights_status: string | null; updated_at: Date;
      report_count: string;
      n_note: string | null; n_state: string | null; n_created_at: Date | null;
    }>(
      `SELECT q.id, q.pack_id, p.name AS pack_name, q.type, q.topic, q.status, q.version, q.review_state,
              s.origin, s.rights_status, q.updated_at,
              (SELECT count(*) FROM question_reports r WHERE r.question_id = q.id)::text AS report_count,
              ln.note AS n_note, ln.state AS n_state, ln.created_at AS n_created_at
         FROM questions q
         JOIN question_packs p ON p.id = q.pack_id
         LEFT JOIN question_source s ON s.question_id = q.id
         LEFT JOIN LATERAL (
           SELECT n.note, n.state, n.created_at FROM question_review_notes n
            WHERE n.question_id = q.id ORDER BY n.created_at DESC, n.id DESC LIMIT 1
         ) ln ON TRUE
        WHERE ${live} AND ${FILTER_SQL[filter]}
        ORDER BY q.updated_at DESC, q.id LIMIT $2 OFFSET $3`,
      [actor.tenantId, size, offset],
    );
    return {
      counts,
      reported: parseInt(reported, 10),
      total: parseInt(total, 10),
      items: rows.rows.map(({ n_note, n_state, n_created_at, report_count, ...rest }) => ({
        ...rest,
        report_count: parseInt(report_count, 10),
        all_orgs_report_count: null as number | null,
        latest_note: n_note === null ? null : { note: n_note, state: n_state as string, created_at: n_created_at as Date },
      })),
    };
  });
  if (isPlatform && queue.items.length > 0) {
    const totals = await crossOrgReportCounts(queue.items.map((i) => i.id));
    for (const item of queue.items) item.all_orgs_report_count = totals.get(item.id) ?? 0;
  }
  return queue;
}

/**
 * Z-166: candidate reports per master question, summed across organisations. Read-only, counts only: no
 * candidate, organisation, note or reason leaves this query. Clones point at the master through
 * questions.source_question_id (0084). Super-admin callers only (listReviewQueue checks the platform tenant).
 */
export async function crossOrgReportCounts(masterIds: string[]): Promise<Map<string, number>> {
  return withSystemRoleDetached("question.report_count_all_orgs", async (client) => {
    const r = await client.query<{ id: string; n: string }>(
      `SELECT m.id, count(r.id)::text AS n
         FROM unnest($1::uuid[]) AS m(id)
         LEFT JOIN questions c ON c.id = m.id OR c.source_question_id = m.id
         LEFT JOIN question_reports r ON r.question_id = c.id
        GROUP BY m.id`,
      [masterIds],
    );
    return new Map(r.rows.map((x) => [x.id, parseInt(x.n, 10)]));
  });
}

export interface ReviewNote {
  id: string;
  version: number;
  state: string;
  note: string;
  author_user_id: string;
  created_at: Date;
}

/** Notes of one question, newest first (max 100). Same authorisation as the review actions. */
export async function getReviewNotes(
  actor: ReviewActor,
  questionId: string,
): Promise<{ latest: ReviewNote | null; items: ReviewNote[] }> {
  assertReviewRole(actor.role);
  return withTenant(actor.tenantId, async (client) => {
    const q = await client.query<{ tenant_id: string }>(
      `SELECT p.tenant_id FROM questions q JOIN question_packs p ON p.id = q.pack_id WHERE q.id = $1`,
      [questionId],
    );
    if (q.rows[0] === undefined) {
      throw new NotFoundError(`Question not found: ${questionId}`, { details: { code: QB_ERROR_CODES.QUESTION_NOT_FOUND } });
    }
    await assertMayReviewPack(client, actor, q.rows[0].tenant_id);
    const r = await client.query<ReviewNote>(
      `SELECT id, version, state, note, author_user_id, created_at FROM question_review_notes
        WHERE question_id = $1 AND tenant_id = $2 ORDER BY created_at DESC, id DESC LIMIT ${REVIEW_PAGE_MAX}`,
      [questionId, actor.tenantId],
    );
    return { latest: r.rows[0] ?? null, items: r.rows };
  });
}

