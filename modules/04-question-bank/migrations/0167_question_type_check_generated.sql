-- GENERATED from packages/question-types. Do not edit by hand. Regenerate with pnpm gen:question-type-check.
--
-- Recreates the question-type CHECK constraints so they equal QUESTION_TYPES
-- (9 types). Safe for the current registry: the nine values equal those in migrations 0152 and 0156.
-- If a type is removed, rows that use it must be migrated first.

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_type_check;
ALTER TABLE questions ADD CONSTRAINT questions_type_check
  CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering','structured_case'));

ALTER TABLE question_versions DROP CONSTRAINT IF EXISTS question_versions_type_check;
ALTER TABLE question_versions ADD CONSTRAINT question_versions_type_check
  CHECK (type IN ('mcq','subjective','kql','scenario','log_analysis','numeric','multi_select','ordering','structured_case'));
