-- owned by modules/06-attempt-engine
-- Phase 1 G1.C Session 4 — attempt_answers table.
--
-- One row per (attempt, question) pair. Inserted as empty rows at startAttempt
-- time (so client_revision starts at 0 deterministically); subsequent saveAnswer
-- calls UPDATE the row in place (last-write-wins per decision #7). The shape of
-- `answer` depends on the question type (mcq → number, subjective → string,
-- kql → { query, scratch }, scenario → { steps[] }, etc.) — see types.ts for the
-- AnswerPayload union.
--
-- WHY client_revision INT NOT NULL DEFAULT 0 (decision #7):
--   Multi-tab autosave is allowed. The candidate may have two tabs open and
--   each is incrementing its own revision counter. saveAnswer takes MAX(stored,
--   incoming) + 1 — the incoming revision is informational only, not a blocking
--   optimistic-lock (per decision #7's "do NOT use as a blocking lock"). When
--   incoming < stored, the service writes the answer ANYWAY (last-write-wins)
--   AND records a `multi_tab_conflict` event.
--
-- WHY JOIN-based RLS: same as attempt_questions; tenancy via attempt_id.

CREATE TABLE attempt_answers (
  attempt_id      UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES questions(id),
  answer          JSONB,
  flagged         BOOLEAN NOT NULL DEFAULT false,
  time_spent_seconds INT NOT NULL DEFAULT 0,
  edits_count     INT NOT NULL DEFAULT 0,
  client_revision INT NOT NULL DEFAULT 0,
  saved_at        TIMESTAMPTZ,
  PRIMARY KEY (attempt_id, question_id)
);

ALTER TABLE attempt_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON attempt_answers
  USING (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_answers.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON attempt_answers
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM attempts a
      WHERE a.id = attempt_answers.attempt_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
