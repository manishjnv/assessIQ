/**
 * Automatic invitation reminders — module 05 (2026-10-02). NO AI anywhere here.
 *
 * `sweepInvitationReminders()` is called by the worker job `invitation.reminders`
 * (apps/api jobs/invitation-reminders.ts, every 30 min). One tick:
 *
 *   1. ONE cross-tenant read under assessiq_system (same pattern as
 *      resolveInvitationToken): invitations of published/active assessments with
 *      settings.reminders.enabled = true that are pending/viewed, not reminded,
 *      whose effective deadline = LEAST(expires_at, closes_at) is in the future but
 *      within hours_before (default 24), whose candidate has no attempt, whose
 *      latest email (invite / resend) is older than 6 h, and who is active and not
 *      erased. Soonest deadline first; capped by REMINDER_BATCH per tick and by
 *      REMINDER_DAILY_CAP rows reminded in the trailing 24 h across the platform
 *      (Brevo free plan: 300/day shared — reminders are the lowest-value mail).
 *   2. Per row, in its OWN withTenant transaction (RLS): claim with
 *        UPDATE ... SET reminded_at = now(), token_hash = $new
 *         WHERE id = $1 AND reminded_at IS NULL AND <still eligible> RETURNING ...
 *      so a second tick / worker can never double-send.
 *   3. After commit, enqueue the email on the bulk lane (module 13).
 *      If that throws, reminded_at is cleared so the next tick retries.
 *
 * LINK: only sha256(token) is stored, so the plaintext of the original invite link
 * cannot be recovered. The claim therefore rotates token_hash (same mechanism as a
 * resend) but NEVER touches expires_at — a reminder does not extend anything. The
 * link in the reminder replaces the one in the earlier email (the email says so).
 *
 * Logs: one summary line per tick with counts only (no emails / names / tokens).
 */

import { streamLogger, NotFoundError, ValidationError, config } from "@assessiq/core";
import { withTenant, getPool } from "@assessiq/tenancy";
import { auditInTx } from "@assessiq/audit-log";
import * as tenancyRepo from "../../02-tenancy/src/repository.js";
import * as repo from "./repository.js";
import { generateInvitationToken } from "./tokens.js";
import { sendReminderEmail } from "./email.js";
import { AL_ERROR_CODES, AssessmentRemindersSettingsSchema } from "./types.js";
import type { Assessment, AssessmentRemindersSettings, AssessmentSettings } from "./types.js";

const log = streamLogger("app");

export const REMINDER_DEFAULT_HOURS = 24;
/** Max reminders started per tick. */
const REMINDER_BATCH = 25;
/** Max rows reminded in any trailing 24 h, platform-wide (Brevo 300/day budget). */
export const REMINDER_DAILY_CAP = 100;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Reject a malformed settings.reminders (create / update paths). Absent = fine (off). */
export function assertRemindersSettings(settings: AssessmentSettings | undefined): void {
  const raw = (settings as Record<string, unknown> | undefined)?.["reminders"];
  if (raw === undefined) return;
  const r = AssessmentRemindersSettingsSchema.safeParse(raw);
  if (!r.success) {
    throw new ValidationError(
      `settings.reminders is invalid: ${r.error.issues.map((i) => i.message).join("; ")}`,
      { details: { code: "INVALID_PARAM", param: "settings.reminders" } },
    );
  }
}

/** Change only settings.reminders (merged server-side). Any status; audited. */
export async function updateAssessmentReminders(
  tenantId: string,
  id: string,
  reminders: AssessmentRemindersSettings,
  updatedByUserId: string,
): Promise<Assessment> {
  assertRemindersSettings({ reminders } as AssessmentSettings);
  return withTenant(tenantId, async (client) => {
    const current = await repo.findAssessmentById(client, id);
    if (current === null) {
      throw new NotFoundError(`Assessment not found: ${id}`, {
        details: { code: AL_ERROR_CODES.ASSESSMENT_NOT_FOUND },
      });
    }
    const updated = await repo.setSettingsKeyRow(client, id, "reminders", reminders);
    const prev = (current.settings as Record<string, unknown> | undefined)?.["reminders"] ?? null;
    await auditInTx(client, {
      tenantId,
      actorKind: "user",
      actorUserId: updatedByUserId,
      action: "assessment.updated",
      entityType: "assessment",
      entityId: id,
      before: { reminders: prev },
      after: { reminders },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

// type (not interface): the worker's JobResult is Record<string, unknown>
export type ReminderSweepResult = { candidates: number; sent: number; skipped: number; failed: number };

interface Candidate {
  id: string;
  tenant_id: string;
}

/** Effective deadline: the sooner of the link expiry and the assessment close. */
const DEADLINE_SQL = `LEAST(ai.expires_at, COALESCE(a.closes_at, ai.expires_at))`;
/** hours_before from settings; anything but 1-3 digits falls back to the default (never poisons the query). */
const HOURS_SQL = `(CASE WHEN a.settings->'reminders'->>'hours_before' ~ '^[0-9]{1,3}$'
                          THEN (a.settings->'reminders'->>'hours_before')::int
                          ELSE ${REMINDER_DEFAULT_HOURS} END)`;
const NO_ATTEMPT_SQL = `NOT EXISTS (
  SELECT 1 FROM attempts t
   WHERE t.assessment_id = ai.assessment_id AND t.user_id = ai.user_id AND t.status <> 'draft')`;

async function findCandidates(): Promise<Candidate[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE assessiq_system");
    const used = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM assessment_invitations WHERE reminded_at > now() - interval '24 hours'`,
    );
    const room = Math.min(REMINDER_BATCH, REMINDER_DAILY_CAP - (used.rows[0]?.n ?? 0));
    if (room <= 0) {
      await client.query("COMMIT");
      return [];
    }
    const res = await client.query<Candidate>(
      `SELECT ai.id, a.tenant_id
         FROM assessment_invitations ai
         JOIN assessments a ON a.id = ai.assessment_id
         JOIN tenants tn    ON tn.id = a.tenant_id AND tn.status = 'active'
         JOIN users u       ON u.id = ai.user_id
                           AND u.role = 'candidate' AND u.status = 'active'
                           AND u.deleted_at IS NULL AND u.erased_at IS NULL
        WHERE a.status IN ('published', 'active')
          AND a.settings->'reminders'->>'enabled' = 'true'
          AND ai.status IN ('pending', 'viewed')
          AND ai.reminded_at IS NULL
          AND ${DEADLINE_SQL} > now()
          AND ${DEADLINE_SQL} <= now() + make_interval(hours => ${HOURS_SQL})
          AND GREATEST(ai.created_at, COALESCE(ai.last_resent_at, ai.created_at)) < now() - interval '6 hours'
          AND ${NO_ATTEMPT_SQL}
        ORDER BY ${DEADLINE_SQL} ASC, ai.id ASC
        LIMIT $1`,
      [room],
    );
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // connection likely dead — surface the original error
    });
    throw err;
  } finally {
    client.release();
  }
}

interface Claimed {
  to: string;
  candidateName: string;
  assessmentName: string;
  tenantName: string;
  deadline: Date;
  link: string;
}

/** Claim ONE invitation in its tenant's transaction; null when it is no longer eligible. */
async function claim(c: Candidate): Promise<Claimed | null> {
  return withTenant(c.tenant_id, async (client) => {
    const { plaintext, hash } = generateInvitationToken();
    // Re-checks eligibility under the row lock-by-UPDATE; expires_at is deliberately NOT set.
    const res = await client.query<{ expires_at: Date; closes_at: Date | null; assessment_id: string; user_id: string }>(
      `UPDATE assessment_invitations ai
          SET token_hash = $2, reminded_at = now()
         FROM assessments a
        WHERE ai.id = $1 AND a.id = ai.assessment_id
          AND ai.reminded_at IS NULL
          AND ai.status IN ('pending', 'viewed')
          AND a.status IN ('published', 'active')
          AND a.settings->'reminders'->>'enabled' = 'true'
          AND ${DEADLINE_SQL} > now()
          AND ${NO_ATTEMPT_SQL}
      RETURNING ai.expires_at, a.closes_at, ai.assessment_id, ai.user_id`,
      [c.id, hash],
    );
    const row = res.rows[0];
    if (row === undefined) return null;

    const info = await client.query<{ email: string; name: string | null; assessment_name: string }>(
      `SELECT u.email, u.name, a.name AS assessment_name
         FROM users u, assessments a WHERE u.id = $1 AND a.id = $2`,
      [row.user_id, row.assessment_id],
    );
    const i = info.rows[0];
    const tenant = await tenancyRepo.findTenantById(client, c.tenant_id);
    const tenantName = tenant?.name?.trim() ?? "";
    if (i === undefined || tenantName.length === 0) throw new Error("reminder: missing user or tenant name");

    const deadline =
      row.closes_at !== null && row.closes_at < row.expires_at ? row.closes_at : row.expires_at;
    return {
      to: i.email,
      candidateName: i.name?.trim() || "there",
      assessmentName: i.assessment_name,
      tenantName,
      deadline,
      link: `${config.ASSESSIQ_BASE_URL}/take/${plaintext}`,
    };
  });
}

/** One sweep tick. Never throws. */
export async function sweepInvitationReminders(): Promise<ReminderSweepResult> {
  const result: ReminderSweepResult = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
  let candidates: Candidate[];
  try {
    candidates = await findCandidates();
  } catch (err) {
    log.error({ err }, "invitation reminders: candidate query failed");
    return result;
  }
  result.candidates = candidates.length;

  for (const c of candidates) {
    let claimed: Claimed | null;
    try {
      claimed = await claim(c);
    } catch (err) {
      result.failed += 1;
      log.error({ err, invitationId: c.id }, "invitation reminders: claim failed");
      continue;
    }
    if (claimed === null) {
      result.skipped += 1;
      continue;
    }
    try {
      await sendReminderEmail({
        to: claimed.to,
        candidateName: claimed.candidateName,
        assessmentName: claimed.assessmentName,
        invitationLink: claimed.link,
        deadline: claimed.deadline,
        tenantName: claimed.tenantName,
        tenantId: c.tenant_id,
      });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      log.error({ err, invitationId: c.id }, "invitation reminders: email failed; releasing claim");
      // Release so the next tick retries (the rotated token is simply replaced again).
      await withTenant(c.tenant_id, (client) =>
        client.query(`UPDATE assessment_invitations SET reminded_at = NULL WHERE id = $1`, [c.id]),
      ).catch((e) => log.error({ err: e, invitationId: c.id }, "invitation reminders: release failed"));
    }
  }

  if (result.candidates > 0) log.info({ ...result }, "invitation reminders tick");
  return result;
}
