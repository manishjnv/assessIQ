-- owned by modules/04-question-bank
-- N21: freeze the question TYPE per version. Attempt (06) and scoring (09) code used to read
-- questions.type live, so a clone refresh that changed a type mid-attempt mixed rules (e.g. an MCQ
-- attempt scored / served under another type's rules). The type now lives on question_versions,
-- next to the content it describes, and readers resolve it through attempt_questions.question_version.
--
-- Steps (idempotent): add nullable column, backfill from questions.type, set NOT NULL, add CHECK
-- (same domain as questions_type_check, migration 0152 -- a future type migration must update BOTH
-- constraints), and a BEFORE INSERT trigger that fills a missing type from the question row so a
-- writer that omits the column still snapshots the current type (writers in 04 set it explicitly).
-- RLS: no change. Policies are row-level (EXISTS on questions -> question_packs); a new column needs
-- no policy edit. The trigger runs as the inserting role and reads questions, which that role
-- already must see for the WITH CHECK policy to pass.
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS type TEXT;

UPDATE question_versions qv
   SET type = q.type
  FROM questions q
 WHERE q.id = qv.question_id
   AND qv.type IS NULL;

ALTER TABLE question_versions ALTER COLUMN type SET NOT NULL;

ALTER TABLE question_versions DROP CONSTRAINT IF EXISTS question_versions_type_check;
ALTER TABLE question_versions ADD CONSTRAINT question_versions_type_check
  CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering','structured_case'));

CREATE OR REPLACE FUNCTION question_versions_default_type() RETURNS trigger AS $$
BEGIN
  IF NEW.type IS NULL THEN
    SELECT q.type INTO NEW.type FROM questions q WHERE q.id = NEW.question_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_versions_default_type ON question_versions;
CREATE TRIGGER question_versions_default_type
  BEFORE INSERT ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_versions_default_type();
