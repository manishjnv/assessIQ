-- owned by modules/06-attempt-engine
-- 0287 — EXP-9 A1: the language the candidate reads an attempt in.
-- NULL = English (every existing row). 'hi' = the Hindi overlay in question content (content.i18n.hi).
-- Answers stay in original-index space, so scoring never depends on this column.
-- Additive and nullable; RLS on attempts (tenant_id) already covers the new column.
ALTER TABLE attempts
  ADD COLUMN IF NOT EXISTS language text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attempts_language_check') THEN
    ALTER TABLE attempts ADD CONSTRAINT attempts_language_check CHECK (language IN ('en','hi'));
  END IF;
END $$;
