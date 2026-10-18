/**
 * EXP-18 part 2: question review gate (Verify, Needs fix, Withdraw, bulk Verify all).
 *
 * Who may review what (checked here in the service; the route handler checks the role too):
 *   - role must be admin or super_admin;
 *   - the pack must belong to the caller's own tenant (RLS already hides other tenants; the explicit
 *     check below is the second line);
 *   - a PLATFORM question (pack in the tenant with slug 'platform') only by a super_admin;
 *   - an ORGANISATION question only by an admin of that organisation.
 * Every state change writes one audit row (actor, previous state, new state, note) in the same tx.
 * Rows are locked FOR UPDATE in id order; module 05 share-locks the same rows in id order at publish
 * and invite, so a review write and the publish gate cannot interleave.
 */

import { AuthzError, ConflictError, NotFoundError, ValidationError } from "@assessiq/core";
import { withTenant } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import type { PoolClient } from "pg";
import { QB_ERROR_CODES } from "../types.js";
import type { ReviewState } from "../types.js";
import * as repo from "../repository.js";
import { withdrawInTx } from "./questions.js";

export const REVIEW_ACTIONS = ["verify", "needs_fix", "withdraw"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export const REVIEW_FILTERS = ["open", "all", "in_review", "verified", "disputed", "needs_fix", "none"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

export interface ReviewActor {
  tenantId: string;
  userId: string;
  role: string;
}

export const NOTE_MAX = 1000;
export const REVIEW_PAGE_MAX = 100;

/** Role gate shared by the handler and the service. Throws 403 for any role but admin and super_admin. */
export function assertReviewRole(role: string | undefined): asserts role is "admin" | "super_admin" {
  if (role !== "admin" && role !== "super_admin") throw new AuthzError("admin or super_admin required");
}

/** Pack-level authorisation: own tenant, and platform packs only for a super_admin. */
async function assertMayReviewPack(client: PoolClient, actor: ReviewActor, packTenantId: string): Promise<void> {
  assertReviewRole(actor.role);
  if (packTenantId !== actor.tenantId) {
    throw new NotFoundError("Question set not found", { details: { code: QB_ERROR_CODES.PACK_NOT_FOUND } });
  }
  const t = await client.query<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [actor.tenantId]);
  const isPlatform = t.rows[0]?.slug === "platform";
  if (isPlatform && actor.role !== "super_admin") {
    throw new AuthzError("Only a super admin may review platform questions");
  }
  if (!isPlatform && actor.role !== "admin") {
    throw new AuthzError("Only an organisation admin may review organisation questions");
  }
}

interface LockedQuestion {
  id: string;
  pack_id: string;
  status: string;
  review_state: ReviewState | null;
  pack_tenant_id: string;
  withdrawn: boolean;
}

async function lockQuestion(client: PoolClient, id: string): Promise<LockedQuestion | null> {
  const r = await client.query<LockedQuestion>(
    `SELECT q.id, q.pack_id, q.status, q.review_state, p.tenant_id AS pack_tenant_id,
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

/** Verify, Needs fix (note required) or Withdraw one question. */
export async function reviewQuestion(
  actor: ReviewActor,
  id: string,
  action: ReviewAction,
  note?: string,
): Promise<ReviewResult> {
  assertReviewRole(actor.role);
  const trimmed = (note ?? "").trim();
  if (action === "needs_fix" && trimmed.length === 0) {
    throw new ValidationError("A note is required for Needs fix", { details: { code: QB_ERROR_CODES.REVIEW_NOTE_REQUIRED } });
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
    const next: ReviewState = action === "verify" ? "verified" : "needs_fix";
    if (q.review_state === next && action === "verify") {
      return { id, review_state: next, status: q.status, changed: false };
    }
    await client.query(`UPDATE questions SET review_state = $2 WHERE id = $1`, [id, next]);
    await auditInTx(client, {
      tenantId: actor.tenantId,
      actorKind: "user",
      actorUserId: actor.userId,
      action: "question.review_changed",
      entityType: "question",
      entityId: id,
      before: { review_state: q.review_state },
      after: { review_state: next, action, ...(trimmed.length > 0 ? { note: trimmed } : {}), bulk: false },
    });
    return { id, review_state: next, status: q.status, changed: true };
  });
}

/**
 * Verify every in_review question of one pack. `expectedCount` is the number the admin saw in the
 * confirm step; a different current count means the pack changed meanwhile, so nothing is written.
 * Needs-fix and disputed questions are NOT touched (each needs its own look). One audit row per question.
 */
export async function bulkVerifyPack(
  actor: ReviewActor,
  packId: string,
  expectedCount: number,
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
    if (rows.length !== expectedCount) {
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
  });
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
              q.answer_guidance, s.origin, s.rights_status, s.source_ref, s.source_url
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
      items: items.rows,
    };
  });
}
