-- owned by modules/02-tenancy
-- RW-80: per-question feedback level on the candidate results page.
--
-- none (default) | right_wrong | with_expected_answer | with_ai_justification.
-- OWNER GATE: the production default is chosen later by the owner; it stays 'none'
-- until a tenant admin changes it. Additive and idempotent.
--
-- Rollback: UPDATE tenant_settings SET result_feedback_level = 'none'. The column
-- stays in place.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS result_feedback_level TEXT NOT NULL DEFAULT 'none'
    CHECK (result_feedback_level IN ('none', 'right_wrong', 'with_expected_answer', 'with_ai_justification'));

COMMENT ON COLUMN tenant_settings.result_feedback_level IS
  'How much per-question detail a candidate sees on a released result. Changed only by updateResultFeedbackLevel (audited).';
