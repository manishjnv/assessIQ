-- 0111_seed_candidate_pretest_help.sql
--
-- Help content for the candidate pre-test screen on /take/:token:
-- candidate.intro.system_check, .practice, .consent. Mirrors content/en/candidate.yml.
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.intro.system_check', 'candidate', 'en',
  'A quick automatic check that your connection, browser and storage are ready. Fix any item marked Fix needed.',
  $$## System check

Before you begin, AssessIQ runs a few quick checks in your browser:

- **Internet connection** and **connection to AssessIQ**: your answers save
  to our server as you work.
- **Cookies and storage**: needed to keep you signed in and keep a local
  backup of your answers. Private or incognito windows often block them.
- **Browser**: use the latest Chrome, Edge, Firefox or Safari.
- **Screen size**: a very small screen only shows a heads-up.

Nothing is sent about your device. If something needs fixing, follow the
hint, then choose **Check again**. You can begin once every item is OK.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.intro.practice', 'candidate', 'en',
  'One sample question so you can see how choosing an answer works. It is not saved and not scored.',
  $$## Practice question

This sample question uses the same answer options you will see in the test.
Pick an option to try it. Nothing you choose here is saved, scored or
shared. The timer has not started yet.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.intro.consent', 'candidate', 'en',
  'Confirm it is you, taking the test alone, and agree to the Terms and Privacy Policy before you begin.',
  $$## Consent and AI-use notice

Before the timer starts we ask you to confirm that you are the person
invited, that you will take the test on your own, and that you agree to the
Terms and Privacy Policy. Your results may be shared with the company that
invited you. We record when you agreed.

**How answers are scored:** multiple-choice answers are scored
automatically. Written answers, if any, are evaluated with AI assistance and
reviewed by the assessment admin.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
