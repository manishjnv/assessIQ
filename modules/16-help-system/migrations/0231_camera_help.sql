-- 0231_camera_help.sql
--
-- Z-74 / Z-82 real-exam camera help (10 new keys). Mirrors content/en/candidate.yml and admin.yml.
-- Candidate: intro camera check and consent, attempt camera mark and camera lost.
-- Admin: camera settings, notice, reviewers, flagged list, files, school flag.
-- New keys only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0226.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.intro.camera_check', 'candidate', 'en',
  'Check that your camera works and the picture is clear before the test day.',
  $$## Camera check

A real exam with a camera needs a working camera.

- **Allow the camera.** Your browser asks first. Choose Allow.
- **Check the picture.** The small picture shows what the camera sees.
- **Fix the angle and light.** Sit where your face is clear and lit from the front.
- **Retry.** If the check fails, fix the problem and press Retry.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.intro.camera_check' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.intro.camera_check' AND locale = 'en'
    AND short_text = 'Check that your camera works and the picture is clear before the test day.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.intro.camera_consent', 'candidate', 'en',
  'Your test uses your camera. Read what is recorded, then choose Allow or do not start.',
  $$## Your camera and this test

The consent screen says why the camera is used, what is recorded, who sees it and how long it is kept.

- **Allow camera and start.** You agree to this use for this test only. The test starts.
- **I do not agree.** The test does not start. Your invitation stays valid. Contact your test organiser.
- **Your rights.** You can ask your test organiser to show or erase your files.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.intro.camera_consent' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.intro.camera_consent' AND locale = 'en'
    AND short_text = 'Your test uses your camera. Read what is recorded, then choose Allow or do not start.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.attempt.camera_indicator', 'candidate', 'en',
  'A small Camera on mark shows that your camera is working during the test.',
  $$## Camera on

The camera is on for this test. The mark shows while the camera works.

- **Stay in view.** Keep your face in the picture.
- **Do not cover the camera.** A covered camera can flag your test.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.attempt.camera_indicator' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.attempt.camera_indicator' AND locale = 'en'
    AND short_text = 'A small Camera on mark shows that your camera is working during the test.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'candidate.attempt.camera_lost', 'candidate', 'en',
  'Your camera stopped. Fix it, then press Retry. The event is flagged for your test organiser.',
  $$## Camera stopped

The camera stopped during your test. The test shows this message until the camera works again.

- **Fix the camera.** Check that it is plugged in and allowed in your browser.
- **Press Retry.** The test continues when the camera works.
- **The event is flagged.** Your test organiser decides what happens next. AssessIQ does not fail you automatically.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'candidate.attempt.camera_lost' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'candidate.attempt.camera_lost' AND locale = 'en'
    AND short_text = 'Your camera stopped. Fix it, then press Retry. The event is flagged for your test organiser.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.camera', 'admin', 'en',
  'Turn the camera on or off for real exams. A school can also turn photos on or off.',
  $$## Camera for real exams

- **Camera on.** Real exams need the candidate to agree to the camera before the test starts.
- **Camera off.** Real exams run without a camera. Mock tests never use the camera.
- **Photos.** Photos are taken during a real exam only when the camera is on.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera' AND locale = 'en'
    AND short_text = 'Turn the camera on or off for real exams. A school can also turn photos on or off.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.camera_notice', 'admin', 'en',
  'Confirm the camera notice your candidates read before they agree to the camera.',
  $$## Camera notice

Candidates read the camera notice before they start a real exam with a camera.

- **Read the notice.** It lists why the camera is used, what is recorded and how long it is kept.
- **Confirm.** Confirm the notice once. A new notice version asks you to confirm again.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera_notice' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera_notice' AND locale = 'en'
    AND short_text = 'Confirm the camera notice your candidates read before they agree to the camera.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.camera_reviewers', 'admin', 'en',
  'Name the people who may review camera files for your organisation. Only they can open them.',
  $$## Camera reviewers

Only named reviewers can see camera photos and video.

- **Add a reviewer.** Pick a user of your organisation. The change is recorded.
- **Remove a reviewer.** The person loses access at once.
- **Platform staff.** AssessIQ staff can also open files to support you.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera_reviewers' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.camera_reviewers' AND locale = 'en'
    AND short_text = 'Name the people who may review camera files for your organisation. Only they can open them.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.camera.review_list', 'admin', 'en',
  'Attempts with a camera flag. Open one to review its photos and video.',
  $$## Flagged attempts

This list shows attempts where the camera saw a problem or the camera stopped.

- **Open an attempt.** See its photos and video.
- **Mark reviewed.** Mark the attempt when you finish the review.
- **Appeal.** Set the appeal state while a candidate disputes the result.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.camera.review_list' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.camera.review_list' AND locale = 'en'
    AND short_text = 'Attempts with a camera flag. Open one to review its photos and video.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.camera.review_files', 'admin', 'en',
  'Photos and video from one attempt. Each view is recorded. Mark the review when done.',
  $$## Camera files

Each view of a file is recorded in the audit log.

- **Look at a file.** Open a photo or video to see it.
- **Flagged moments.** Flagged files show the reason.
- **Keep times.** Files are deleted when their keep time ends. An open appeal keeps them longer.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.camera.review_files' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.camera.review_files' AND locale = 'en'
    AND short_text = 'Photos and video from one attempt. Each view is recorded. Mark the review when done.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.platform.tenants.school', 'admin', 'en',
  'Mark this organisation as a school. A school admin then chooses the camera settings.',
  $$## School flag

A school flag changes how the camera works for this organisation.

- **School on.** The school admin chooses whether the camera and photos are on.
- **School off.** The organisation follows the normal camera rule.
- **Fresh sign-in.** Changing this flag needs a recent two-factor check.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.platform.tenants.school' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.platform.tenants.school' AND locale = 'en'
    AND short_text = 'Mark this organisation as a school. A school admin then chooses the camera settings.'
);
