-- owned by modules/02-tenancy
-- 0283 (Z-172) - per-organisation switch for the candidate answer key after submit.
--
-- Default FALSE (off). When off, no candidate of the organisation sees a per-question key, whatever
-- the assessment feedback_level says (effectiveLevel in @assessiq/core/feedback-copy). When on,
-- the assessment level still has to be set and the attempt has to be a released Mock attempt, so this
-- switch can only hide more, never show more. Read in the same transaction as the key itself.
-- Changed only by updateCandidateAnswerKey (audited). Additive and idempotent. No new table, so the
-- existing tenant_settings row-level policies apply unchanged.
-- Rollback: UPDATE tenant_settings SET candidate_answer_key = false. The column stays in place.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS candidate_answer_key BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenant_settings.candidate_answer_key IS
  'When true, released Mock attempts of this organisation may show the per-question answer key (still gated by the assessment feedback_level). Changed only by updateCandidateAnswerKey (audited).';
