-- FUT-1: question_versions is an append-only history. Reject any change of
-- content, rubric, version or owner question (same pattern as 0211 passages).
-- `type` is left open: migration 0156 backfills it and a test edits it.
-- Also index the clone link so takedown and review lookups do not scan.
-- Rollback: DROP TRIGGER question_versions_immutable ON question_versions;
--           DROP FUNCTION question_versions_immutable();
--           DROP INDEX questions_source_question_idx;

CREATE OR REPLACE FUNCTION question_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.content     IS DISTINCT FROM OLD.content
     OR NEW.rubric   IS DISTINCT FROM OLD.rubric
     OR NEW.version  IS DISTINCT FROM OLD.version
     OR NEW.question_id IS DISTINCT FROM OLD.question_id THEN
    RAISE EXCEPTION 'question_versions are immutable: insert a new version row';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_versions_immutable ON question_versions;
CREATE TRIGGER question_versions_immutable BEFORE UPDATE ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_versions_immutable();

CREATE INDEX IF NOT EXISTS questions_source_question_idx
  ON questions (source_question_id) WHERE source_question_id IS NOT NULL;
