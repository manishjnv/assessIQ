-- 0195_exp4_import_v2_help.sql
--
-- EXP-4 (2026-10-17): import v2 help rows for the question import page.
--   NEW admin.question_import.columns
--   NEW admin.question_import.rights_status
--   NEW admin.question_import.difficulty
--   NEW admin.question_import.duplicates
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.
-- Production help rows come from forward migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.columns',
  'admin',
  'en',
  'New template columns: exam stage, subject path, difficulty, rights, origin, source, language, previous-year paper.',
  $$## Template columns (v2)

The templates have these columns after `negative_marks`. All are optional except `rights_status`.

- **exam_stage.** The name or code of a stage in the Exam structure framework, for example `SSC CGL Tier 1`.
- **subject_path.** Subject, unit and outcome, separated by `/`, for example `Quant/Arithmetic/Percentage`. A name that does not exist is a row error.
- **difficulty and difficulty_scale.** See the difficulty help.
- **rights_status.** Required. See the rights help.
- **origin.** Where the question came from. If you leave it empty, AssessIQ picks it from `rights_status`.
- **source_ref, source_url, seed_ref.** A free note, a web link and the id of a seed. They are kept with the question.
- **language.** A code such as `en` or `hi`. The default is `en`.
- **pyq_year, pyq_shift.** The year and shift of a previous-year paper.

Older files without these columns still upload. Each row then shows a `rights_status` error until you add the value.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.rights_status',
  'admin',
  'en',
  'Required for CSV and XLSX rows: who may use this question and on what terms.',
  $$## Rights status

- **original.** Written for AssessIQ. Default origin: original_human.
- **derived_from_source.** Rewritten from a source. Default origin: derived_from_source.
- **scraped_raw.** Copied from a web page. It imports, but a question set that holds it cannot be published.
- **licensed.** Used under a licence. Default origin: licensed.
- **metadata_only.** Only the tags are yours. Default origin: original_human.
- **withdrawn** is not allowed here. Use the withdraw action on a question.

GIFT, Aiken and QTI files cannot hold this column. Their rows are saved as `original`.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.difficulty',
  'admin',
  'en',
  'Source difficulty is mapped to the 1 to 5 scale. The original label is kept.',
  $$## Difficulty

Fill `difficulty`. Fill `difficulty_scale` if the label is not a plain 1 to 5 number.

- **words.** easy = 2, medium = 3, hard = 4.
- **1-3.** 1 = 1, 2 = 3, 3 = 5.
- **1-5.** The number stays as it is.

If you leave the scale empty, a number from 1 to 5 uses `1-5` and any other label uses `words`. An unknown label is a row error.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.duplicates',
  'admin',
  'en',
  'Three duplicate checks: same question, same text, and similar text.',
  $$## Duplicate checks

- **Same question.** The content is identical to a question in the file or the bank. The row is a duplicate and is left out.
- **Same text.** The text is the same after case, spaces and option labels such as `A)` are ignored. The row is a duplicate and is left out.
- **Looks similar.** The question text is close to an existing question. The row stays ready. Check it, and skip it if it is a copy.

The similar check needs the `pg_trgm` extension in the database. If it is missing, the report says the check was not run.
Questions that were saved before hashes were stored are matched by their content, in the same subject only.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
