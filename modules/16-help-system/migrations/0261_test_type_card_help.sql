-- 0261_test_type_card_help.sql
--
-- Test-type card chooser on the Assessments page (Z-142/Z-153): one group entry and three card entries
-- (Mock, Real, Real with camera). Mirrors content/en/admin.yml. New keys only, version 1.
-- Idempotent: INSERT ... WHERE NOT EXISTS, as in 0256 (the guard compares the real key and text).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type', 'admin', 'en',
  'Choose the test type. It cannot change after you publish. A Real test is the default.',
  $$## Test type

- **Choose one type.** The type sets the rules, the cost and where results appear.
- **Locked after publish.** You cannot change the type after you publish.
- **Default.** Real is selected first.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type' AND locale = 'en'
    AND short_text = 'Choose the test type. It cannot change after you publish. A Real test is the default.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.mock', 'admin', 'en',
  'Practice test. 10 credits per submitted test. Any device. Readiness check optional. No certificate.',
  $$## Mock test

- **Use.** Practice for candidates.
- **Cost.** 10 credits for each submitted test.
- **Device.** Any device.
- **Readiness check.** Optional.
- **Certificate.** Not issued.
- **Results.** They count only in the mock dashboard.
- **Full screen and copy block.** You may switch them on.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.mock' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.mock' AND locale = 'en'
    AND short_text = 'Practice test. 10 credits per submitted test. Any device. Readiness check optional. No certificate.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.real', 'admin', 'en',
  'Official test. 20 credits per submitted test. Laptop or desktop. Readiness check required.',
  $$## Real test

- **Use.** The official test. Results count in analytics.
- **Cost.** 20 credits for each submitted test.
- **Device.** Laptop or desktop only.
- **Readiness check.** Required before the candidate starts.
- **Full screen and copy block.** Always on.
- **Certificate.** Allowed.
- **Feedback.** Score only. No per-question feedback.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.real' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.real' AND locale = 'en'
    AND short_text = 'Official test. 20 credits per submitted test. Laptop or desktop. Readiness check required.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.real_camera', 'admin', 'en',
  'Real test with the camera always on. 30 credits per submitted test. Needs the camera notice confirmed.',
  $$## Real test with camera

- **Same as Real.** The device, readiness check, full screen, copy block and certificate rules are the same.
- **Camera.** Always on during the test.
- **Cost.** 30 credits for each submitted test.
- **Before publish.** Your organisation must confirm the camera notice in Settings.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.real_camera' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.real_camera' AND locale = 'en'
    AND short_text = 'Real test with the camera always on. 30 credits per submitted test. Needs the camera notice confirmed.'
);
