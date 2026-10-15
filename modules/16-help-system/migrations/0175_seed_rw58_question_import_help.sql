-- 0175_seed_rw58_question_import_help.sql
--
-- RW-58 (2026-10-16): help rows for the super-admin "Import questions" page (/admin/question-import).
-- NEW  admin.question_import.page
-- NEW  admin.question_import.template
-- NEW  admin.question_import.upload
-- NEW  admin.question_import.report
-- NEW  admin.question_import.commit
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).


INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.page',
  'admin',
  'en',
  'Platform tool that adds questions from a CSV or XLSX file to a new draft question set.',
  $$## Import questions

This tool is for AssessIQ platform admins.

- **Template.** Download a template for one question type. Fill it in and save it.
- **Upload.** Pick a subject and the file. The file can be up to 4 MB.
- **Report.** AssessIQ checks every row. Nothing is saved yet.
- **Fix.** Edit a row that has a problem, or skip it.
- **Commit.** Ready rows go into a new draft question set. Rows with problems are left out.
- Nothing reaches a candidate until you publish the question set.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.template',
  'admin',
  'en',
  'A blank file with the right columns for one question type.',
  $$## Template

Choose a question type and a file format. The template lists the columns
that type needs. Keep the header row. Add one question in each row.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.upload',
  'admin',
  'en',
  'Pick the subject and the file. AssessIQ checks the file and shows a report.',
  $$## Upload

- **Subject.** The new question set uses this subject.
- **Question set name.** Optional. The file name is used if you leave it empty.
- **File.** Use a CSV or XLSX file of 4 MB or less.

The check does not save anything.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.report',
  'admin',
  'en',
  'The result for each row: ready, needs a fix, duplicate or skipped.',
  $$## Report

- **Ready.** The row is valid and will be added.
- **Needs a fix.** Open the details to see the problem. Use **Fix** to edit the row, or **Skip row**.
- **Duplicate.** The question already exists. It is not added again.
- **Skipped.** You chose to leave this row out.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.commit',
  'admin',
  'en',
  'Adds the ready rows to a new draft question set. Rows with problems are left out.',
  $$## Commit

Commit adds every ready row to a new **draft** question set. You can add
questions only once for each import. Open the draft to review it, then
publish it when it is ready.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
