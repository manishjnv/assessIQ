/**
 * modules/13-notifications/src/email/result-released.ts
 *
 * sendResultReleasedEmail — the candidate's "your result is ready" email (SP4,
 * 2026-10-01). Called AFTER the release transaction has committed (manual
 * Release, bulk release-all, and the worker auto-release sweep). It was previously
 * referenced by the release handler through a dynamic import but never existed,
 * so release emails were silently skipped.
 *
 * Contract:
 *   - Loads everything it needs itself (withTenant, RLS), from the DB state at
 *     send time: only an attempt that is actually 'released' gets an email.
 *   - Skips (no email) erased candidates (DPDP: the address is a tombstone) and
 *     embed attempts (the host app owns candidate communication).
 *   - BEST-EFFORT: logs and returns on any failure — it never throws into the
 *     release flow (the result is already published; a failed email must not
 *     undo or fail that). Retries for transport failures are handled by the
 *     BullMQ `email.send` job that sendEmail() enqueues (email_log tracks them).
 *   - Content = the complete, final result only (owner rule P1): score text,
 *     pass/fail, portal sign-in link, certificate link when one was issued.
 *     Never answers, bands, justifications or anything per-question.
 *
 * NEVER import claude / @anthropic-ai from this file (Rule #1).
 */

import { config, streamLogger } from '@assessiq/core';
import { withTenant } from '@assessiq/tenancy';
import { sendEmail } from './index.js';

const log = streamLogger('webhook'); // email sends go to webhook.log per § 8 stream table

interface ReleasedAttemptRow {
  status: string;
  embed_origin: boolean;
  erased_at: Date | null;
  email: string;
  name: string | null;
  assessment_name: string;
  tenant_name: string;
  tenant_slug: string;
  total_earned: string | null;
  total_max: string | null;
  passing_score_pct: number | null;
  credential_id: string | null;
}

/** 42 -> "42", 42.5 -> "42.5", 42.456 -> "42.46" (NUMERIC(…,2) values). */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export async function sendResultReleasedEmail(input: {
  tenantId: string;
  attemptId: string;
}): Promise<void> {
  const { tenantId, attemptId } = input;
  try {
    const row = await withTenant(tenantId, async (client) => {
      const res = await client.query<ReleasedAttemptRow>(
        `SELECT a.status,
                a.embed_origin,
                u.erased_at,
                u.email,
                u.name,
                asm.name AS assessment_name,
                t.name   AS tenant_name,
                t.slug   AS tenant_slug,
                s.total_earned::text AS total_earned,
                s.total_max::text    AS total_max,
                l.passing_score_pct,
                c.credential_id
           FROM attempts a
           JOIN users u        ON u.id   = a.user_id
           JOIN assessments asm ON asm.id = a.assessment_id
           JOIN levels l       ON l.id   = asm.level_id
           JOIN tenants t      ON t.id   = a.tenant_id
           LEFT JOIN attempt_scores s ON s.attempt_id = a.id
           LEFT JOIN certificates c
                  ON c.attempt_id = a.id AND c.revoked_at IS NULL
          WHERE a.id = $1`,
        [attemptId],
      );
      return res.rows[0];
    });

    if (row === undefined) {
      log.warn({ tenantId, attemptId }, 'result_released.email_skipped: attempt not found');
      return;
    }
    if (row.status !== 'released') {
      log.warn({ tenantId, attemptId, status: row.status }, 'result_released.email_skipped: attempt not released');
      return;
    }
    if (row.erased_at !== null) {
      log.info({ tenantId, attemptId }, 'result_released.email_skipped: candidate erased');
      return;
    }
    if (row.embed_origin) {
      log.info({ tenantId, attemptId }, 'result_released.email_skipped: embed attempt');
      return;
    }
    if (row.total_earned === null || row.total_max === null) {
      log.warn({ tenantId, attemptId }, 'result_released.email_skipped: no score row');
      return;
    }

    const earned = parseFloat(row.total_earned);
    const max = parseFloat(row.total_max);
    const percent = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
    const passed = percent >= (row.passing_score_pct ?? 60);

    const portal = new URL('/candidate/login', config.ASSESSIQ_BASE_URL);
    portal.searchParams.set('tenant', row.tenant_slug);

    await sendEmail({
      to: row.email,
      template: 'result_released',
      vars: {
        candidateName: row.name?.trim() || 'there',
        assessmentName: row.assessment_name,
        tenantName: row.tenant_name,
        scoreText: `${fmt(earned)} / ${fmt(max)} (${percent}%)`,
        resultText: passed ? 'Passed' : 'Not passed',
        portalLink: portal.toString(),
        ...(row.credential_id !== null
          ? { certificateLink: new URL(`/verify/${encodeURIComponent(row.credential_id)}`, config.ASSESSIQ_BASE_URL).toString() }
          : {}),
      },
      tenantId,
    });
  } catch (err) {
    log.warn({ err, tenantId, attemptId }, 'result_released.email_failed');
  }
}
