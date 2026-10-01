-- owned by modules/05-assessment-lifecycle
-- 0117 — assessment_invitations.last_resent_at
--
-- WHY this column exists:
--   "Resend to everyone who hasn't started" (POST /api/admin/assessments/:id/
--   invitations/resend) is capped at 200 invitations per call and reports how
--   many are `remaining`. A re-issued invitation is still `pending` and still
--   "not started", so without a marker the next call would select the SAME
--   first 200 rows again — duplicate emails, and links the students had just
--   received would be killed. `last_resent_at` is stamped by every re-issue
--   (single resend, bulk resend, re-invite after revoke); the bulk selector
--   skips rows stamped in the last 10 minutes, so repeated clicks walk through
--   a large cohort instead of looping on the first batch.
--
--   Original invitations keep NULL, so a bulk resend straight after the first
--   invite still reaches everyone.
--
-- Additive + nullable + no default → metadata-only change on Postgres 16 (no
-- table rewrite). RLS is unchanged: both policies are table-wide JOIN-based
-- (see 0022) and do not reference individual columns.

ALTER TABLE assessment_invitations
  ADD COLUMN IF NOT EXISTS last_resent_at TIMESTAMPTZ;
