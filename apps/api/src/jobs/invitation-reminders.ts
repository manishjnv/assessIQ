/**
 * Invitation reminders — worker job `invitation.reminders` (2026-10-02).
 *
 * Every 30 min emails ONE "closes soon" reminder to candidates who have not started an
 * assessment whose admin switched reminders on. All logic (cross-tenant read under
 * assessiq_system, per-row withTenant claim, 100/24 h cap, bulk email lane) lives in
 * module 05 reminders.ts; this file is only the schedule. No AI on this path.
 */

import { sweepInvitationReminders, type ReminderSweepResult } from '@assessiq/assessment-lifecycle';

export const INVITATION_REMINDERS_JOB_NAME = 'invitation.reminders';
export const INVITATION_REMINDERS_INTERVAL_MS = 30 * 60_000;

export function processInvitationRemindersTick(): Promise<ReminderSweepResult> {
  return sweepInvitationReminders(); // never throws
}
