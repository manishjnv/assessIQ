-- 0264_mock_scope_help.sql
--
-- Help for the mock scope control on the exam blueprints page (EXP-35): one new key, version 1.
-- Mirrors content/en/admin.yml.
-- Idempotent: INSERT ... WHERE NOT EXISTS. The guard compares the real key and text, as in 0263.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.blueprints.mock_scope', 'admin', 'en',
  'Choose the full test, or only some subjects, and a smaller size.',
  $$## What the mock covers

- **Full test.** All sections of the exam, at full size.
- **Chosen subjects only.** Tick the subjects you want. The mock has only those sections.
- **Size.** Use 75, 50 or 25 percent of the questions and of the time for each section.

A shorter mock is a practice test. It has no cut-off. Marks per question stay the same. It costs the same credits as any mock.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.blueprints.mock_scope' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.blueprints.mock_scope' AND locale = 'en'
    AND short_text = 'Choose the full test, or only some subjects, and a smaller size.'
);
