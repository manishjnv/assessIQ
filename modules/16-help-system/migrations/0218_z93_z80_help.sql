-- 0218_z93_z80_help.sql
--
-- Z-93 credit ledger (2 keys) and Z-80 locked-feature popup (1 key). Mirrors content/en/admin.yml.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.settings.billing.credits_balance',
  'admin',
  'en',
  'Credits you can still use. Credits expire 12 months after they are added.',
  $$## Credit balance

Your balance is the sum of all credits that have not expired. Each graded
attempt uses credits from the grant that expires first. A grant can come
from your monthly free credits or from credits your AssessIQ administrator
adds for you. The next expiry date shows when the first credits run out.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.settings.billing.credits_burn',
  'admin',
  'en',
  'Credits used so far, split by test type: mock, real, and real with camera.',
  $$## Credits used by test type

A mock test uses 1 credit. A real test uses 2 credits. A real test with
camera uses 3 credits. The credits are used once for each graded attempt.
A re-grade of the same attempt does not use credits again.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.locked.contact',
  'admin',
  'en',
  'This feature is not in your plan. Contact AssessIQ to get full access.',
  $$## Full access needed

- **What.** This feature is not in your plan.
- **Next step.** Select **Contact us**. It opens the AssessIQ contact page.
- **Nothing changes.** Your settings stay as they are.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

