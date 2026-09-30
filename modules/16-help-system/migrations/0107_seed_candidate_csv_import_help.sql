-- 0107_seed_candidate_csv_import_help.sql
--
-- Help content for the bulk candidate CSV import on the admin assessment
-- detail page (modules/10-admin-dashboard/src/pages/assessment-detail.tsx):
--   - data-help-id="admin.assessments.invite.import_csv"     ("Import from CSV" button)
--   - data-help-id="admin.assessments.invite.import_result"  (import result panel)
--
-- Forward migration (0011 is already applied in production); mirrors the new
-- entries in content/en/admin.yml. Same pattern as 0093, 0094, 0097, 0099, 0105.
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invite.import_csv', 'admin', 'en',
  'Upload a CSV of names and emails to add candidates and invite them to this assessment in one go.',
  $$## Import candidates from CSV

Add many candidates at once instead of one by one.

1. **Download the sample CSV** to see the format. The first row must be a
   header with `name` and `email` (any capitalisation). Other columns
   are ignored.
2. **Choose your file.** You will see a preview of the first 10 rows and
   the total row count before anything is saved.
3. **Confirm.** New candidates are created, people who already exist in
   your company are reused, and everyone is invited to this assessment.

**Limits:** up to 1,000 rows and about 512 KB per file, UTF-8 text.
Duplicate emails in the file are only counted once (the first row wins).
A bad row never stops the rest — it is listed afterwards so you can fix it.
Invitation emails go out through the normal email queue, so a large import
may take a little while to reach everyone.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invite.import_result', 'admin', 'en',
  'What happened to each row: created, already existing, invited, or skipped (with the reason).',
  $$## Import result

- **Created** — new candidate accounts added to your company.
- **Existing** — the email was already a candidate here, so it was reused.
- **Invited** — invitation emails queued for this assessment.
- **Skipped** — rows that were not imported or not invited. Each shows the
  row number (the header is row 1), the email and the reason, for example
  an invalid email, a missing name, a repeated email in the file, an email
  that belongs to a non-candidate (admin or reviewer), or a candidate who
  already has an invitation for this assessment.

Use **Download skipped rows** to get a CSV you can correct and upload again.
If you see an email-volume warning, some invitations may arrive later than
usual because the email plan has a shared daily limit.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
