-- 0110_seed_results_download_help.sql
--
-- Help content for the "Download results (CSV)" button on the admin assessment
-- detail page (data-help-id="admin.assessments.results.download_csv").
-- Mirrors content/en/admin.yml. Same pattern as 0107.
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.results.download_csv', 'admin', 'en',
  'Download a live spreadsheet of every invited candidate''s result for this assessment, ready for a placement cell.',
  $$## Download results (CSV)

One row per invited candidate, always up to date (not the nightly report).

- **Columns:** name, email, status, started and submitted times, score, max
  score, percent, Pass/Fail, and one percentage column per category.
- **Status** shows invited (not started), in_progress, submitted, graded or
  released. Score, percent and Pass/Fail stay blank until the attempt is graded.
- **Pass/Fail** uses the passing score of the assessment's level.
- Opens correctly in Excel, including Indian names. Up to 10,000 rows.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
