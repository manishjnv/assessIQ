-- 0275_uat_org_code_help.sql
-- Help for the organisation code block in admin settings and the "See all your results" link on the Submitted page
-- (owner UAT 2026-10-29, Option A). Two new keys, version 1. Mirrors content/en/admin.yml and candidate.yml.
-- Idempotent: INSERT ... WHERE NOT EXISTS (as in 0271).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.org_code', 'admin', 'en',
  'The code students use to sign in and see their results.',
  $$## Organisation code

Students sign in to see their results with this code and their email address.

- **Invitation emails** already carry the code and a sign-in link.
- **Student sign-in link.** Copy it and share it if a student asks. The link has the code in it, so the student types only the email.
- **Read only.** The code cannot be changed here. Old links keep working.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.org_code' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.org_code' AND locale = 'en'
    AND short_text = 'The code students use to sign in and see their results.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.take.submitted.signin', 'candidate', 'en',
  'Sign in to see all your results. The link already has your organisation code.',
  $$## See all your results

This link opens the sign-in page for your organisation. You only type your email address. We send you a sign-in link.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.take.submitted.signin' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.take.submitted.signin' AND locale = 'en'
    AND short_text = 'Sign in to see all your results. The link already has your organisation code.'
);
