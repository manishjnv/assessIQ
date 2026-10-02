-- 0143_seed_sections_edit_help.sql
--
-- NEW  admin.assessment.sections.edit   "Test sections" edit card on the admin assessment page
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.sections.edit', 'admin', 'en',
  'Change the sections of a draft test before any student starts it.',
  $$## Edit sections

Use **Edit sections** to change the name, questions, minutes and calculator of
each section, or to add and remove sections.

- **Only drafts.** The button is off once the test is published.
- **Locked after the first attempt.** Once any student has started, sections
  cannot change. If you see this message when saving, someone started the
  test while you were editing.
- If every section has a question count, the test total becomes their sum.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
