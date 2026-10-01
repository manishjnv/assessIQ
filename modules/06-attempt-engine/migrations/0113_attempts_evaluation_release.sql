-- owned by modules/06-attempt-engine
-- 0113 — result-release state lives in COLUMNS, not in a new attempts.status value
-- (the status enum is read by 06, 07, 09, 15 and the frontends; it stays unchanged).
--
-- evaluation_released_at — "the tenant may see and publish this result". Set when
--   an attempt is complete (every question has a final, non-flagged grade):
--     * auto-scorable attempts (MCQ-only) at the moment they are finalised;
--     * tenant-evaluated attempts (Phase I) when the tenant admin's accept /
--       override / manual score completes them;
--     * (Phase II) when the platform evaluator releases the evaluation to the tenant.
--   Publishing to the student (status 'graded' -> 'released') requires it.
-- evaluation_released_by — the user who released the evaluation (NULL = system).
--   The auto-release sweep uses it as the audit actor when present.
-- evaluation_note        — tenant "send back for re-evaluation" note (Phase II).
--   Free text: never copied to audit_log.
-- evaluation_sent_back_at — when the tenant last sent the attempt back (Phase II).
--
-- Backfill: results that are already graded / released stay publishable.
-- Migrations run as the DB owner (tools/migrate.ts), so this UPDATE is not RLS-filtered.

ALTER TABLE attempts
  ADD COLUMN evaluation_released_at timestamptz NULL,
  ADD COLUMN evaluation_released_by uuid NULL REFERENCES users(id),
  ADD COLUMN evaluation_note text NULL,
  ADD COLUMN evaluation_sent_back_at timestamptz NULL;

UPDATE attempts
   SET evaluation_released_at = now()
 WHERE status IN ('graded', 'released')
   AND evaluation_released_at IS NULL;

-- The auto-release sweep (worker, every 15 s, cross-tenant) looks for exactly
-- these rows; the partial index keeps that scan tiny.
CREATE INDEX attempts_ready_to_release_idx
  ON attempts (evaluation_released_at)
  WHERE status = 'graded' AND evaluation_released_at IS NOT NULL;
