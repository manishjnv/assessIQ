-- 0135_seed_reminders_help.sql
--
-- NEW  admin.assessment.reminders  "Automatic reminders" card on the assessment detail page
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.reminders', 'admin', 'en',
  'Automatically email a reminder to students who have not started this test.',
  $$## Automatic reminders

Tick **Send automatic reminders**, choose how many hours before the deadline,
then press **Save reminder settings**. It is **off by default**.

- **Who gets one:** students who were invited but have not started, once per
  invitation, when the invitation expires or the test closes (whichever is
  sooner) within the hours you chose.
- **The link in the reminder replaces the earlier one.** The deadline does
  not move; a reminder never extends anything.
- **Sent in the background**, roughly every 30 minutes, after the invitation
  email has had at least 6 hours.
- **Limit:** the platform sends at most 100 reminders in any 24 hours, because
  the email provider has a daily cap. Sign-in codes and invitations always go first.
- The invitations list shows **Reminder sent** for students who got one.
  Resending an invitation gives that student a fresh reminder later.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
