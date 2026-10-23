-- 0256_org_upload_and_affected_help.sql
--
-- EXP-17 organisation upload screen (source note, licence id, plan limits panel) and the two EXP-12
-- review panel ids that had no entry yet (Mark reviewed, Show filter). Mirrors content/en/admin.yml.
-- New keys only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0251 (the guard compares the real key).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.org_upload.source_note', 'admin', 'en',
  'Optional. A short note on where these questions came from. Up to 500 characters.',
  $$## Source note

- **Optional.** Add a short note about where the questions come from.
- **Limit.** Up to 500 characters. The counter shows how many you have used.
- **Use.** The note is saved with the upload. It helps you and your reviewers later.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.org_upload.source_note' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.org_upload.source_note' AND locale = 'en'
    AND short_text = 'Optional. A short note on where these questions came from. Up to 500 characters.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.org_upload.licence_id', 'admin', 'en',
  'The licence number AssessIQ creates when you add the questions. Shows After commit until then.',
  $$## Licence number

- **Created by AssessIQ.** The number is made when you add the questions.
- **Before that.** The column shows After commit while the upload is only checked.
- **Use.** Give this number to support when you ask about an upload.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.org_upload.licence_id' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.org_upload.licence_id' AND locale = 'en'
    AND short_text = 'The licence number AssessIQ creates when you add the questions. Shows After commit until then.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.org_upload.limits', 'admin', 'en',
  'What your plan allows for your uploads. No limit means there is no cap on that item.',
  $$## Plan limits

- **Questions per upload.** The most questions one file can add.
- **Uploads this month.** The most uploads you can make in one calendar month.
- **Questions in total.** The most uploaded questions your organisation can keep.
- **No limit.** There is no cap on that item.
- **Zero.** Your plan does not allow that upload.

When the panel says the limits are not enforced yet, they show your plan only. They do not stop an upload.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.org_upload.limits' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.org_upload.limits' AND locale = 'en'
    AND short_text = 'What your plan allows for your uploads. No limit means there is no cap on that item.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.question_bank.review.affected_mark', 'admin', 'en',
  'Record that you checked this attempt. You can add a note. It changes no marks.',
  $$## Mark reviewed

- **What it records.** A manual review mark for this attempt, with an outcome and an optional note.
- **Marks.** It changes no marks. Rescoring is not automatic.
- **Change.** Use Change review to set a new outcome or note.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.question_bank.review.affected_mark' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.question_bank.review.affected_mark' AND locale = 'en'
    AND short_text = 'Record that you checked this attempt. You can add a note. It changes no marks.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.question_bank.review.affected_filter', 'admin', 'en',
  'Show all attempts, only attempts not reviewed yet, or only reviewed attempts.',
  $$## Filter attempts

- **All attempts.** Shows every attempt that used an older version of this question.
- **Not reviewed yet.** Shows attempts with no review mark.
- **Reviewed.** Shows attempts that have a review mark.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.question_bank.review.affected_filter' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.question_bank.review.affected_filter' AND locale = 'en'
    AND short_text = 'Show all attempts, only attempts not reviewed yet, or only reviewed attempts.'
);
