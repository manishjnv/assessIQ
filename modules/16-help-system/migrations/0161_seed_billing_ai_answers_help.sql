-- 0161_seed_billing_ai_answers_help.sql
--
-- FU-A9 (2026-10-06): NEW admin.settings.billing.ai_answers (the second meter
-- on the plan card). Mirrors content/en/admin.yml. Idempotent INSERT ... ON
-- CONFLICT DO NOTHING; 0011 regenerated in the same commit.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.billing.ai_answers', 'admin', 'en',
  'Written answers AssessIQ evaluated this month, against the number your plan includes. Information only.',
  $$## AI-evaluated answers

Your plan includes a number of AI-evaluated written answers per month. One
answer is counted when AssessIQ accepts its evaluation; a re-evaluation of
the same answer is not counted again. Multiple-choice answers never count.

The number resets on the monthly date shown under **Counting since**. Like
credits, this meter is information only: nothing blocks inviting,
submitting or publishing. To change your plan, contact your AssessIQ
administrator.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
