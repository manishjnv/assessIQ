-- owned by modules/06-attempt-engine
-- 0132 — test sections (per-section timers).
--
-- attempt_questions.section_index — which assessments.settings.sections[] entry the
--   question belongs to, frozen at attempt start (same INSERT that freezes the
--   question version). NULL = the assessment has no sections (every existing row).
-- attempts.section_progress — {"current": <int>, "started_at": <iso>} : the section the
--   candidate is in and when it opened. NULL = still in section 0 since attempts.started_at.
--   The server derives each deadline from this + the section's minutes; it is advanced
--   lazily (a read/write after a deadline) or by "Finish section".
-- RLS is unchanged (column adds; row policies + GRANTs already cover both tables).
-- Apply BEFORE deploying the code that reads/writes them.

ALTER TABLE attempt_questions ADD COLUMN IF NOT EXISTS section_index SMALLINT;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS section_progress JSONB;

COMMENT ON COLUMN attempt_questions.section_index IS
  'Index into assessments.settings.sections, frozen at attempt start; NULL = no sections.';
COMMENT ON COLUMN attempts.section_progress IS
  'Sectioned attempts: {current, started_at}; NULL = section 0 since started_at.';
