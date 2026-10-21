-- 0235_suggested_time_help.sql
--
-- Z-103: help for the suggested time on the Start a test page. Mirrors content/en/admin.yml.
-- New key only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0234.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.suggested_time', 'admin', 'en',
  'A time estimate from the number and type of questions. It is a suggestion only.',
  $$## Suggested time

The estimate uses the number of questions you chose and the type and difficulty of the questions in the set.

- **Use suggested time.** The button copies the estimate into the time limit box.
- **Your choice.** You can change the number in the box. The suggestion does not apply by itself.
- **Full mock.** A full mock keeps the time of its blueprint. No suggestion shows.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.suggested_time' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.suggested_time' AND locale = 'en'
    AND short_text = 'A time estimate from the number and type of questions. It is a suggestion only.'
);
