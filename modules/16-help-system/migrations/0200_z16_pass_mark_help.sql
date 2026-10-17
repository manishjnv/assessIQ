-- 0200_z16_pass_mark_help.sql
--
-- Z-16 (2026-10-17): help row for the per-assessment pass mark field.
--   NEW admin.assessments.pass_mark
-- Mirrors content/en/admin.yml (row copied from the regenerated seeds/help_content.sql).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New key only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.pass_mark',
  'admin',
  'en',
  'The score a candidate needs to pass. You can change it only while the assessment is a draft.',
  $$## Pass mark

The pass mark is the score a candidate needs to pass, from 1 to 100 percent.
It starts at the default of the level you chose. You can change it only while
the assessment is a draft. After you publish, it is locked, so every candidate
is judged by the same mark.

- **A score at the pass mark passes.** 60 percent passes a pass mark of 60.
- **Every pass earns a certificate.** A score of 90 percent or more earns
  Distinction. Any other pass earns Completion.
- **A pass mark above 90 makes Completion and Distinction the same band.**
  Every pass is then 90 percent or more, so every certificate is Distinction.
- **Old results do not change.** Each result keeps the pass mark it was judged by.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
