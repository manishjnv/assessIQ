-- 0288_sections_help_countdown_text.sql
--
-- What: adds version 2 of two admin help keys in the assessment sections editor:
--   admin.assessment.sections.lock
--   admin.assessment.sections.seconds_per_question
-- Each v2 drops the last bullet, "Keep it off / Keep it blank for a live assessment
-- until the take page countdown is ready." The rest of each text is unchanged.
-- Z-187 (S86 follow-up of Z-184).
--
-- Why: the take page countdown has shipped (Z-174 item 1), so the advice is stale.
-- The seed uses ON CONFLICT (tenant_id, key, locale, version) DO NOTHING, so a text
-- edit at the same version never reaches a database that already has the row.
-- See docs/RCA_LOG.md, "2026-10-06 — Regenerated seed migration 0011 did not update
-- existing help rows in production". The fix is a new version row. The app reads the
-- highest version (modules/16-help-system/src/service.ts, ORDER BY version DESC).
-- The v1 rows stay in place and are superseded.
--
-- Matching YAML: content/en/admin.yml sets version: 2 on both keys. The seed
-- (seeds/help_content.sql) emits the same v2 text.
--
-- Idempotent: each insert runs only when the key already exists (EXISTS) and no
-- version 2 row exists yet (NOT EXISTS). On a fresh database the key does not exist
-- while migrations run, so nothing is inserted here. The post-migration seed then
-- inserts v2 with the same text, and its ON CONFLICT clause skips it if present.
--
-- Rollback: DELETE FROM help_content
--   WHERE tenant_id IS NULL AND locale = 'en' AND version = 2
--     AND key IN ('admin.assessment.sections.lock',
--                 'admin.assessment.sections.seconds_per_question');
-- The v1 rows are untouched, so the lookup falls back to the old text.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessment.sections.lock', 'admin', 'en',
  'Stop candidates from going back to this section once they leave it.',
  $$## Lock this section after leaving it

Turn this on so a candidate cannot return to this section after they leave it.

- **Only with a whole-test time.** The switch shows only when the assessment has a
  total time for the whole test.
- **No changes after leaving.** The candidate cannot change answers in this section
  after they leave it.
$$,
  2, 'active'
WHERE EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.lock' AND locale = 'en'
)
AND NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.lock' AND locale = 'en' AND version = 2
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessment.sections.seconds_per_question', 'admin', 'en',
  'Time for each question in this section, in seconds, 10 to 3600. Blank sets no time per question.',
  $$## Seconds per question

Set the time for each question in this section, in seconds (10 to 3600).
Leave the field blank to set no time per question.

- **Each question has its own time.** When the time for a question runs out, that
  question closes.
- **Blank means no time per question.** The section then has only the whole-test time.
$$,
  2, 'active'
WHERE EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.seconds_per_question' AND locale = 'en'
)
AND NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessment.sections.seconds_per_question' AND locale = 'en' AND version = 2
);
