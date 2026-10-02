-- owned by modules/05-assessment-lifecycle
-- 0134 — assessment_invitations.reminded_at
--
-- WHY: the worker job `invitation.reminders` sends ONE "closes soon" email per
-- invitation. The sweep claims a row with
--   UPDATE ... SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING ...
-- so two overlapping ticks (or two worker processes) can never both send. The
-- column also feeds the "Reminder sent <time>" label on the admin invitation
-- list and the platform-wide 24 h send cap (count of rows reminded in the last
-- 24 h). A re-issue (resend / re-invite) resets it to NULL: the link has a fresh
-- 7-day life, so it may earn one new reminder.
--
-- Additive + nullable + no default → metadata-only change on Postgres 16.
-- RLS unchanged (both policies are table-wide JOIN-based, see 0022).

ALTER TABLE assessment_invitations
  ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
