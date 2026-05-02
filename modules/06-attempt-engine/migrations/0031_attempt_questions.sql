-- owned by modules/06-attempt-engine
-- Phase 1 G1.C Session 4 — attempt_questions table.
--
-- One row per question included in an attempt's frozen question set. Captured
-- at startAttempt time (Fisher-Yates shuffled; decision #20). The (question_id,
-- question_version) tuple is the frozen content contract — admin edits to the
-- live question after attempt start do NOT affect this attempt's content; the
-- candidate sees content from question_versions WHERE (question_id, version)
-- matches this row.
--
-- WHY JOIN-based RLS (no tenant_id column):
--   attempt_questions is a child of attempts; tenancy derives through
--   attempt_id → attempts.tenant_id. The lint linter has this table in its
--   JOIN_RLS_TABLES set — both policies must use EXISTS sub-selects against
--   attempts.tenant_id with current_setting('app.current_tenant', true).
--
-- WHY question_version is INT NOT NULL:
--   At startAttempt, the service snapshots questions.version into this row.
--   Reading the frozen content joins question_versions ON (question_id, version)
--   = (attempt_questions.question_id, attempt_questions.question_version).

CREATE TABLE attempt_questions (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  position        INT NOT NULL,
  question_version INT NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

-- Reading the question set for an attempt scans by attempt_id; the PK leads
-- with attempt_id so a separate index is unnecessary. position is queried
-- with ORDER BY at read time.

ALTER TABLE attempt_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON attempt_questions
  USING (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_questions.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON attempt_questions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_questions.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
