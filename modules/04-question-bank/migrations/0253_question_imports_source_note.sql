-- owned by modules/04-question-bank
-- EXP-17 (owner 2026-10-22): optional free-text source note on an organisation upload (max 500 chars).
-- Separate from source_ref (the per-row source reference). The generated licence id lives on question_source.licence_id.
-- Forward-only, idempotent. Rollback (NOT automatic): ALTER TABLE question_imports DROP COLUMN source_note.
ALTER TABLE question_imports
  ADD COLUMN IF NOT EXISTS source_note TEXT NULL CHECK (source_note IS NULL OR char_length(source_note) <= 500);
