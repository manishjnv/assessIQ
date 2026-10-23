-- 0251_pack_target_and_invite_help.sql
--
-- EXP-36 / EXP-38: help for the invite limit field (platform billing drawer), the target question set
-- picker on the two import screens, and the per-section question set picker. Mirrors content/en/admin.yml.
-- New keys only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0241.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.billing.invite_limit', 'admin', 'en',
  'The most students one assessment can invite. Set a number, or tick Unlimited. The internal tier is unlimited.',
  $$## Students per assessment

This sets the most students you can invite to one assessment for this organisation.

- **Number.** Enter a whole number from 1 to 1000000.
- **Unlimited.** Tick the box. Any number of students can be invited.

The limit counts active invitations only: pending, viewed and started. Submitted, expired and revoked invitations do not count.

The internal tier is always unlimited. Saving needs a fresh authenticator code and is written to the audit log.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.billing.invite_limit' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.billing.invite_limit' AND locale = 'en'
    AND short_text = 'The most students one assessment can invite. Set a number, or tick Unlimited. The internal tier is unlimited.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.question_import.target_pack', 'admin', 'en',
  'Optional. Add these questions to a question set you already have in this subject. Blank = create a new set.',
  $$## Add to an existing question set

Leave this as "No" to create a new question set from the file.

To add the questions to a set you already have:

1. Choose the subject first.
2. Choose the question set. Archived sets do not appear.
3. Optional: choose a level. Leave it blank to use each row's level column in the file.

The question set name field is not used when you add to a set.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.question_import.target_pack' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.question_import.target_pack' AND locale = 'en'
    AND short_text = 'Optional. Add these questions to a question set you already have in this subject. Blank = create a new set.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.org_upload.target_pack', 'admin', 'en',
  'Optional. Add these questions to a question set your organisation already has in this subject.',
  $$## Add to an existing question set

Leave this as "No" to create a new question set from the file.

To add the questions to a set you already have:

1. Choose the subject first.
2. Choose the question set. Archived sets do not appear.
3. Optional: choose a level. Leave it blank to use each row's level column in the file.

The question set name field is not used when you add to a set.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.org_upload.target_pack' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.org_upload.target_pack' AND locale = 'en'
    AND short_text = 'Optional. Add these questions to a question set your organisation already has in this subject.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessment.sections.pack', 'admin', 'en',
  'Optional. Use another published question set for this section. The default is the assessment''s own set.',
  $$## Question set for this section

Each section can draw its questions from a published question set of your organisation. Leave the choice on the default to use the assessment's own question set.

- Only published sets appear.
- The section's categories must belong to the subject of the set it uses.
- A section with no set keeps the assessment's own set.

Sections can change only while the assessment is a draft with no attempts.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.pack' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.pack' AND locale = 'en'
    AND short_text = 'Optional. Use another published question set for this section. The default is the assessment''s own set.'
);
