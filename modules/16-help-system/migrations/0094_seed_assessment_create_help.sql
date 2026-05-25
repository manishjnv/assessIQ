-- 0094_seed_assessment_create_help.sql
--
-- Inline button help (Wave 2) for the "Create assessment" submit button on the
-- Assessments page (modules/10-admin-dashboard/src/pages/assessments.tsx).
-- The other Wave-2 buttons (Publish, Invite candidates, Revoke, Reissue) reuse
-- help keys that already exist (admin.assessments.publish, .invite.bulk,
-- admin.certificates.revoke, .reissue) — Wave 2 broadened those pages' helpPage
-- prefix so the existing content actually loads; only this one new key is added.
--
-- Source of truth: content/en/admin.yml. Forward migration (0011 already applied
-- in prod); ON CONFLICT DO NOTHING; global row (tenant_id NULL) inserted as the
-- postgres superuser which BYPASSes the help_content INSERT RLS policy. Same
-- pattern as 0089 / 0092 / 0093.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.create.submit', 'admin', 'en',
  'Create this assessment as a Draft. You then Publish it to open candidate invitations.',
  $$## Create assessment

Saves the assessment in **Draft** — nothing is sent to candidates yet. From
the assessment's detail page you then **Publish** it (which freezes its
question set and opens it) and **invite candidates**. A draft can be edited
or deleted freely before publishing.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
