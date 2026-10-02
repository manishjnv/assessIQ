-- 0130_seed_integrity_edit_help.sql
--
-- NEW  admin.assessment.integrity.edit  "Test integrity" card on the assessment detail page
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.integrity.edit', 'admin', 'en',
  'Change the full-screen and copy-paste switches for this test, even after it is published.',
  $$## Edit test integrity

Turn **Require full screen** and **Block copy and paste** on or off for this
test, then press **Save integrity settings**. Nothing else about the test changes.

- **You can change this after publishing.** The new setting applies to
  attempts that start afterwards.
- **A student already taking the test** picks up the change the next time
  their page loads (for example a refresh).
- Attempts already recorded keep their existing integrity counts.

Treat the numbers as a signal to look into, not proof of cheating.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
