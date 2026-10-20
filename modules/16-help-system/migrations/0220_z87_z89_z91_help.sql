-- 0220_z87_z89_z91_help.sql
--
-- Z-89 test type, Z-87 desktop-only, Z-91 readiness check help (4 keys). Mirrors content/en/admin.yml and candidate.yml.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessment.invite.test_type',
  'admin',
  'en',
  'Real exam: laptop or desktop only, counts in reports. Mock test: any device, no certificate.',
  $$## Test type

- **Real exam.** The candidate must use a laptop or desktop. The candidate passes a readiness check before Begin. Results count in your reports and can earn a certificate.
- **Mock test.** The candidate can use any device. Results show a Mock label. A mock gives no certificate and stays out of your real-exam reports.
- **You choose.** You pick the type when you invite. The candidate cannot change it.
- **Attempts.** A mock does not use up the attempts of a real exam.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.test_type_mock',
  'candidate',
  'en',
  'This is a mock test. It is practice: it gives no certificate and does not count as the real exam.',
  $$## Mock test

This is a practice run of the test. You can take it on any device.

- **No certificate.** A mock test does not give a certificate.
- **Labelled.** Your result shows a Mock label.
- **Real exam later.** The real exam needs a laptop or desktop computer.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.readiness',
  'candidate',
  'en',
  'A quick check of your device, screen, browser and internet. Fix any item marked Fix needed, then select Retry.',
  $$## Readiness check

Before a real exam, AssessIQ checks that your device is ready.

- **Laptop or desktop.** Phones and tablets cannot take a real exam.
- **Screen size.** Use a screen of at least 1024 by 600 pixels.
- **Browser.** Use a recent Chrome, Edge, Firefox or Safari.
- **Internet speed.** A slow connection can lose your answers.

Select **Retry** after you fix an item. You can begin when every item passes.
For a mock test, this check is optional practice and never stops you.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.device_blocked',
  'candidate',
  'en',
  'Please open this link on a laptop or desktop computer to take this test.',
  $$## Open this link on a laptop or desktop

A real exam cannot start on a phone or tablet.

- **Your invitation is safe.** It is not used up.
- **What to do.** Open the same link on a laptop or desktop computer.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

