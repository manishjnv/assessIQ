/**
 * modules/13-notifications/src/invite-limit-notice.ts
 *
 * EXP-37: a tenant admin tried to invite more students than the plan limit for one assessment.
 * Tells the platform super admins: one in-app notice for every active super_admin user of the
 * platform tenant, plus one email to SUPER_ADMIN_EMAILS. At most once per (tenant, assessment)
 * per UTC day (Redis SET NX EX).
 *
 * BEST-EFFORT: never throws. The caller's 409 must not change when anything here fails.
 * Must run OUTSIDE any withTenant scope (it writes the platform tenant's rows with withSystemRole).
 * No AI call. Names and the admin email are allowed here: this is internal mail to the platform owner.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config, getRedis, streamLogger, uuidv7 } from '@assessiq/core';
import { withSystemRole } from '@assessiq/tenancy';
import * as repo from './repository.js';
import { sendEmail } from './email/index.js';

const log = streamLogger('app');

const DAY_SECONDS = 24 * 60 * 60;

export interface InviteLimitBlockedInput {
  tenantId: string;
  orgName: string;
  adminName: string;
  adminEmail: string;
  assessmentId: string;
  assessmentName: string;
  /** Active invitations plus the ones the admin tried to add. */
  tried: number;
  limit: number;
}

/** Returns true when this call sent the notices, false when throttled or on any failure. */
export async function notifyInviteLimitBlocked(input: InviteLimitBlockedInput): Promise<boolean> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `aiq:invite_limit_notice:${input.tenantId}:${input.assessmentId}:${day}`;
    const first = await getRedis().set(key, '1', 'EX', DAY_SECONDS, 'NX');
    if (first !== 'OK') return false;

    const message =
      `${input.orgName}: ${input.adminName} tried to invite ${String(input.tried)} students to ` +
      `"${input.assessmentName}". The limit is ${String(input.limit)}. No invitation was sent.`;
    const link = '/admin/platform';

    try {
      await withSystemRole('invite limit blocked: notify platform super admins', async (client) => {
        const admins = await client.query<{ id: string }>(
          `SELECT id FROM users
            WHERE tenant_id = $1 AND role = 'super_admin' AND status = 'active'`,
          [config.PLATFORM_TENANT_ID],
        );
        for (const a of admins.rows) {
          await repo.insertInAppNotification(client, {
            id: uuidv7(),
            tenantId: config.PLATFORM_TENANT_ID,
            audience: 'user',
            userId: a.id,
            role: null,
            kind: 'invite_limit_blocked',
            message,
            link,
          });
        }
      });
    } catch (err) {
      log.warn({ err }, 'invite_limit_blocked.in_app_failed');
    }

    const recipients = [
      ...new Set(
        config.SUPER_ADMIN_EMAILS.split(',')
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.length > 0),
      ),
    ];
    const orgLink = new URL(link, config.ASSESSIQ_BASE_URL).toString();
    for (const to of recipients) {
      try {
        await sendEmail({
          to,
          template: 'invite_limit_blocked',
          vars: {
            orgName: input.orgName,
            adminName: input.adminName,
            adminEmail: input.adminEmail,
            assessmentName: input.assessmentName,
            tried: input.tried,
            limit: input.limit,
            orgLink,
          },
          tenantId: config.PLATFORM_TENANT_ID,
        });
      } catch (err) {
        log.warn({ err }, 'invite_limit_blocked.email_failed');
      }
    }
    return true;
  } catch (err) {
    log.warn({ err }, 'invite_limit_blocked.notice_failed');
    return false;
  }
}
