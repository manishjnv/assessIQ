-- owned by modules/06-attempt-engine
-- 0254 — EXP-12 wave 1: manual review marks for attempts that used an older question version.
-- A mark here is only a note. It never changes a mark, status, certificate or report.
-- No FK to questions/users on purpose (module-local test harnesses). Forward-only, idempotent.
CREATE TABLE IF NOT EXISTS affected_attempt_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_id           UUID NOT NULL,
  attempt_id            UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_version_used INT  NOT NULL,
  current_version       INT  NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('no_change_needed','needs_follow_up')),
  note                  TEXT NULL CHECK (note IS NULL OR char_length(note) <= 1000),
  reviewed_by           UUID NOT NULL,
  reviewed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, question_id, attempt_id)
);

ALTER TABLE affected_attempt_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON affected_attempt_reviews;
CREATE POLICY tenant_isolation_select ON affected_attempt_reviews
  FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON affected_attempt_reviews;
CREATE POLICY tenant_isolation_insert ON affected_attempt_reviews
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_update ON affected_attempt_reviews;
CREATE POLICY tenant_isolation_update ON affected_attempt_reviews
  FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
