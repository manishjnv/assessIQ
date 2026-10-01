-- 0125_seed_results_sort_help.sql
--
-- Help content for the campus-placement results export (2026-10-01):
--   NEW      admin.assessment.results_csv.sort            "Sort by" select next to
--                                                         "Download results (CSV)"
--   UPDATED  admin.assessments.invite.import_csv          optional roll_number / branch columns
--   UPDATED  admin.assessments.results.download_csv       new columns (roll, branch, rank,
--                                                         integrity counts)
-- Mirrors content/en/admin.yml. Same pattern as 0120: idempotent INSERT ... ON CONFLICT
-- DO NOTHING; UPDATEs touch only the global v1 row; 0011 is NOT regenerated (editing an
-- applied migration trips the migrate.ts checksum-drift guard).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.results_csv.sort', 'admin', 'en',
  'Choose the row order of the downloaded results: by name, by rank, or by branch and then rank.',
  $$## Sort the results CSV

- **Name** (default): alphabetical.
- **Rank**: highest percent first; students without a released score come last.
- **Branch then rank**: branches A to Z, best rank first inside each branch.
  Students with no branch listed come last.

Branch and roll number come from the optional `branch` and `roll_number`
columns of the candidate CSV import.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET long_md = replace(long_md,
$$header with `name` and `email` (any capitalisation). Other columns
   are ignored.$$,
$$header with `name` and `email` (any capitalisation). Optional columns:
   `roll_number` (also `roll no`, `roll`, `enrollment`) and `branch` (also
   `department`, `dept`). Re-importing a student updates roll number and
   branch only when the cell is not empty. Other columns are ignored.$$),
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.import_csv' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET long_md = replace(long_md,
$$- **Columns:** name, email, status, started and submitted times, score, max
  score, percent, Pass/Fail, and one percentage column per category.$$,
$$- **Columns:** name, email, roll number, branch, status, started and
  submitted times, score, max score, percent, Pass/Fail, rank,
  tab switches, paste count, full-screen exits, and one percentage column
  per category.
- **Rank** is 1, 2, 2, 4 style (ties share a rank) by percent, highest
  first. It is blank until a score is released to you.
- **Tab switches, paste count, full-screen exits** are integrity signals
  counted while the candidate was in the test. They are hints for you to
  review, not proof of cheating.$$),
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.assessments.results.download_csv' AND locale = 'en' AND version = 1;
