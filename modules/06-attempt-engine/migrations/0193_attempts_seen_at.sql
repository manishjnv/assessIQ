-- owned by modules/06-attempt-engine
-- 0193 — Z-12: per-result "New" marker on the candidate Results page.
-- attempts.seen_at = when the candidate first opened this released result.
-- NULL = not opened yet (shows the "New" chip). RLS on attempts is unchanged.
-- Backfill: results already released before this migration count as seen, so
-- old results do not all show "New". Forward-only.
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS seen_at timestamptz NULL;

UPDATE attempts
   SET seen_at = COALESCE(evaluation_released_at, now())
 WHERE status = 'released' AND seen_at IS NULL;
