/**
 * Auto-release sweep — worker job `result.auto_release` (SP2, 2026-10-01).
 *
 * A tenant in result_release_mode = 'auto' wants finished results published to the
 * student as soon as they are complete, with no admin click. Every ~15 s this sweep:
 *
 *   1. finds (one cross-tenant read under the assessiq_system role, same pattern as
 *      admin-super.ts) up to AUTO_RELEASE_BATCH attempts that are
 *        status 'graded' AND evaluation_released_at IS NOT NULL      (complete + the tenant may publish)
 *        AND evaluation_released_at >= tenant_settings.result_release_auto_since
 *            — only results that became ready AFTER the tenant switched to auto; results already
 *              waiting in the manual queue are never released retroactively (admin uses bulk release)
 *        AND the tenant is active, the candidate is not erased, and it is not an embed attempt
 *   2. releases each in its OWN withTenant transaction through module 09
 *      releaseAttemptInTx (same core as the manual click: erasure gate, audit row,
 *      SAVEPOINT-guarded certificate) with trigger 'auto'. The audit actor is the user who
 *      released the evaluation when there is one, else the system;
 *   3. emails the candidate AFTER each commit (best-effort, module 13).
 *
 * No AI call anywhere on this path: auto release only publishes an already-finished
 * result. Never throws out of the job — a failing attempt is logged and skipped.
 * Imports: @assessiq/scoring, @assessiq/notifications, @assessiq/tenancy only (the worker
 * must never import @assessiq/ai-grading; lint:ambient-ai enforces it).
 */

import { AppError, streamLogger } from '@assessiq/core';
import { getPool, withTenant } from '@assessiq/tenancy';
import { releaseAttemptInTx, type ReleaseActor } from '@assessiq/scoring';
import { sendResultReleasedEmail } from '@assessiq/notifications';

const log = streamLogger('worker');

export const AUTO_RELEASE_JOB_NAME = 'result.auto_release';
export const AUTO_RELEASE_INTERVAL_MS = 15_000;
export const AUTO_RELEASE_BATCH = 50;

// ponytail: in-memory poison guard. An attempt whose release keeps failing with a
// non-business error would otherwise be re-selected first on every tick (oldest first),
// and 50 of them would starve every other tenant's auto-release. Failed ids are skipped
// for FAIL_COOLDOWN_MS; per-process, a restart simply retries them. Upgrade to a DB-side
// attempt counter only if poison attempts are ever seen in production.
const FAIL_COOLDOWN_MS = 10 * 60_000;
const failedAt = new Map<string, number>();

// type (not interface): the worker's JobResult is Record<string, unknown>
export type AutoReleaseResult = {
  candidates: number;
  released: number;
  /** business-rule refusals (race with another release, erased in between, ...) — not errors */
  skipped: number;
  /** unexpected errors; the id is cooled down for FAIL_COOLDOWN_MS */
  failed: number;
};

interface Candidate {
  attempt_id: string;
  tenant_id: string;
  evaluation_released_by: string | null;
}

async function findCandidates(excluded: string[]): Promise<Candidate[]> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE assessiq_system');
    const res = await client.query<Candidate>(
      `SELECT a.id AS attempt_id, a.tenant_id, a.evaluation_released_by
         FROM attempts a
         JOIN tenants t          ON t.id = a.tenant_id AND t.status = 'active'
         JOIN tenant_settings ts ON ts.tenant_id = a.tenant_id
                                AND ts.result_release_mode = 'auto'
                                AND ts.result_release_auto_since IS NOT NULL
         JOIN users u            ON u.id = a.user_id AND u.erased_at IS NULL
        WHERE a.status = 'graded'
          AND a.evaluation_released_at IS NOT NULL
          AND a.evaluation_released_at >= ts.result_release_auto_since
          AND a.embed_origin = FALSE
          AND a.id <> ALL($2::uuid[])
        ORDER BY a.evaluation_released_at ASC, a.id ASC
        LIMIT $1`,
      [AUTO_RELEASE_BATCH, excluded],
    );
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // connection likely dead — surface the original error
    });
    throw err;
  } finally {
    client.release();
  }
}

/** One sweep tick. `now` is injectable for the cooldown test. Never throws. */
export async function processAutoReleaseTick(now: number = Date.now()): Promise<AutoReleaseResult> {
  const result: AutoReleaseResult = { candidates: 0, released: 0, skipped: 0, failed: 0 };

  // drop expired cooldowns, then exclude the live ones
  for (const [id, at] of failedAt) {
    if (now - at >= FAIL_COOLDOWN_MS) failedAt.delete(id);
  }

  let candidates: Candidate[];
  try {
    candidates = await findCandidates([...failedAt.keys()]);
  } catch (err) {
    log.error({ err, job: AUTO_RELEASE_JOB_NAME }, 'auto-release: candidate query failed');
    return result;
  }
  result.candidates = candidates.length;

  for (const c of candidates) {
    const actor: ReleaseActor =
      c.evaluation_released_by !== null
        ? { kind: 'user', userId: c.evaluation_released_by }
        : { kind: 'system' };
    try {
      await withTenant(c.tenant_id, (client) =>
        releaseAttemptInTx(client, {
          tenantId: c.tenant_id,
          attemptId: c.attempt_id,
          actor,
          trigger: 'auto',
        }),
      );
    } catch (err) {
      if (err instanceof AppError) {
        // RESULT_NOT_READY (someone released it first), erased between the read and
        // the release, ... — expected races, not poison.
        result.skipped += 1;
        log.info(
          { attemptId: c.attempt_id, tenantId: c.tenant_id, code: err.code },
          'auto-release: skipped',
        );
      } else {
        result.failed += 1;
        failedAt.set(c.attempt_id, now);
        log.error(
          { err, attemptId: c.attempt_id, tenantId: c.tenant_id },
          'auto-release: release failed',
        );
      }
      continue;
    }
    result.released += 1;
    try {
      await sendResultReleasedEmail({ tenantId: c.tenant_id, attemptId: c.attempt_id });
    } catch (err) {
      // sendResultReleasedEmail never throws; belt and braces — the result is published.
      log.warn({ err, attemptId: c.attempt_id }, 'auto-release: result email failed');
    }
  }

  if (result.candidates > 0) {
    log.info({ ...result, job: AUTO_RELEASE_JOB_NAME }, 'auto-release tick');
  }
  return result;
}

/** Test hook: forget cooled-down ids. */
export function resetAutoReleaseCooldownForTesting(): void {
  failedAt.clear();
}
