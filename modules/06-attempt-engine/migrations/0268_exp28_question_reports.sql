-- owned by modules/06-attempt-engine
-- 0268 - EXP-28: a candidate can report a problem with a question ("Report a problem" on the question view).
--
-- WHAT   question_reports: one row per attempt and question (the candidate may change the reason: upsert).
-- WHY    Extends the EXP-12 review queue (Z-52 gap 7 option C): the queue shows a report count and a
--        "Reported" filter. A report NEVER changes a review state, mark or score by itself: a person
--        reads the reports and uses the existing Mark disputed / Needs fix actions. Reason: one candidate
--        must not be able to block a question for every organisation.
-- RLS    Tenant isolation on tenant_id (SELECT, INSERT, UPDATE). No DELETE policy: reports are kept; they
--        go away with the attempt (ON DELETE CASCADE) or the tenant.
-- Abuse  UNIQUE (attempt_id, question_id) and a per-attempt cap enforced in module 06.
-- No FK to questions or users on purpose (module-local test harnesses, as in 0254). Forward-only, idempotent.
-- Not included: cross-tenant counts for platform masters, auto-dispute at a report threshold, any scoring change.
CREATE TABLE IF NOT EXISTS question_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_id  UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id UUID NOT NULL,
  user_id     UUID NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('wrong_answer','unclear','other')),
  note        TEXT NULL CHECK (note IS NULL OR char_length(note) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS question_reports_question_idx ON question_reports (tenant_id, question_id);

ALTER TABLE question_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON question_reports;
CREATE POLICY tenant_isolation_select ON question_reports
  FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON question_reports;
CREATE POLICY tenant_isolation_insert ON question_reports
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_update ON question_reports;
CREATE POLICY tenant_isolation_update ON question_reports
  FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
