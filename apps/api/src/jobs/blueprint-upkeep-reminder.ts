/**
 * Exam-pattern upkeep reminder — worker job `blueprint.upkeep_reminder` (CT-0, 2026-10-26).
 *
 * Exam patterns (exam_blueprints) must be checked against the official notice every month. This job
 * only REMINDS: once a day it claims every non-archived pattern whose next_check_due has passed and
 * that was not named in a reminder during the last 30 days, then emails SUPER_ADMIN_EMAILS one mail
 * with the count and a link. The check itself is a person (Mark checked, or save a new edition).
 *
 * The claim is the dedupe: `upkeep_reminded_at` is set in the same statement that selects the rows.
 * If no email could be sent, the claim is released so the next daily tick tries again.
 *
 * No AI call anywhere on this path (hard rule 1): it counts rows and sends mail. Imports only
 * @assessiq/tenancy and @assessiq/notifications.
 */

import { streamLogger } from '@assessiq/core';
import { withSystemRole } from '@assessiq/tenancy';
import { sendPatternReviewDueEmail } from '@assessiq/notifications';
import { superAdminRecipients } from './evaluation-queue-alert.js';

const log = streamLogger('worker');

export const BLUEPRINT_UPKEEP_JOB_NAME = 'blueprint.upkeep_reminder';
export const BLUEPRINT_UPKEEP_INTERVAL_MS = 24 * 60 * 60_000;

// type (not interface): the worker's JobResult is Record<string, unknown>
export type BlueprintUpkeepResult = { due: number; sent: number };

export interface BlueprintUpkeepDeps {
  recipients?: string[];
  send?: typeof sendPatternReviewDueEmail;
}

/** Claim the due patterns (sets upkeep_reminded_at) and return their ids. One system-role statement. */
export async function claimDuePatterns(): Promise<string[]> {
  return withSystemRole('blueprint upkeep reminder: claim due patterns', async (client) => {
    const r = await client.query<{ id: string }>(
      `UPDATE exam_blueprints SET upkeep_reminded_at = now()
        WHERE archived_at IS NULL AND next_check_due <= CURRENT_DATE
          AND (upkeep_reminded_at IS NULL OR upkeep_reminded_at < now() - interval '30 days')
        RETURNING id`,
    );
    return r.rows.map((x) => x.id);
  });
}

async function releaseClaim(ids: string[]): Promise<void> {
  await withSystemRole('blueprint upkeep reminder: release claim', async (client) => {
    await client.query(`UPDATE exam_blueprints SET upkeep_reminded_at = NULL WHERE id = ANY($1::uuid[])`, [ids]);
  });
}

export async function processBlueprintUpkeepTick(deps: BlueprintUpkeepDeps = {}): Promise<BlueprintUpkeepResult> {
  const send = deps.send ?? sendPatternReviewDueEmail;
  const recipients = deps.recipients ?? superAdminRecipients();
  if (recipients.length === 0) {
    log.warn({ job: BLUEPRINT_UPKEEP_JOB_NAME }, 'blueprint-upkeep-reminder: SUPER_ADMIN_EMAILS is empty');
    return { due: 0, sent: 0 };
  }
  const ids = await claimDuePatterns();
  if (ids.length === 0) return { due: 0, sent: 0 };
  const { sent } = await send({ to: recipients, count: ids.length });
  if (sent === 0) {
    await releaseClaim(ids);
    log.error({ job: BLUEPRINT_UPKEEP_JOB_NAME, due: ids.length }, 'blueprint-upkeep-reminder: no email could be sent');
  } else {
    log.info({ job: BLUEPRINT_UPKEEP_JOB_NAME, due: ids.length, sent }, 'blueprint-upkeep-reminder: sent');
  }
  return { due: ids.length, sent };
}
