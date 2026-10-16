-- owned by modules/02-tenancy
-- P4 (least-AI grading): per-tenant cap on AI usage in grading.
--
-- 'written' (default) keeps today's behaviour. 'none' stops every AI grading call
-- for the tenant: handleAdminGrade returns a manual-score placeholder for each
-- AI-gradeable question (rule and reuse tiers still run, they call no AI).
-- Changed only by a super admin (audited). Additive and idempotent.
--
-- Rollback: UPDATE tenant_settings SET ai_grading_scope = 'written'. The column
-- stays in place.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS ai_grading_scope TEXT NOT NULL DEFAULT 'written'
    CHECK (ai_grading_scope IN ('written', 'none'));

COMMENT ON COLUMN tenant_settings.ai_grading_scope IS
  'written = AI may grade subjective/scenario/log_analysis (the only AI-gradeable types); none = no AI for this tenant, written answers go to human scoring';
