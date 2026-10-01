-- 0115_seed_result_release_help.sql
--
-- Help content for the scoring / result-release change (spec 2026-10-01, FE):
--   NEW      admin.settings.result_release_mode  (Result release section on the
--                                                 tenant Settings page)
--   NEW      candidate.results.list              (/candidate/results page)
--   NEW      candidate.auth.org_code             ("Organisation code" field on
--                                                 /candidate/login)
--   UPDATED  candidate.submit.confirm            (no longer promises an admin-run
--                                                 grading queue; says what happens
--                                                 after submit)
--   UPDATED  candidate.result.bands              (no bands / AI justifications —
--                                                 owner rule P1; key name kept
--                                                 because renaming breaks tenant
--                                                 overrides)
-- Mirrors content/en/admin.yml + candidate.yml. New rows follow the 0110 pattern.
-- Idempotent: INSERTs use ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
-- the two UPDATEs rewrite only the global v1 rows (tenant overrides untouched) and
-- are safe to re-run. 0011 is NOT regenerated: editing an applied migration trips
-- the tools/migrate.ts checksum-drift guard at deploy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.result_release_mode', 'admin', 'en',
  'Choose whether results go to candidates automatically once complete, or only when you publish them.',
  $$## Result release

This setting decides when a candidate can see their result.

- **Manual (default).** A finished result waits for you. Candidates see
  nothing — and are not emailed — until you publish it.
- **Automatic.** A result is published as soon as it is complete: the
  candidate sees their score and is emailed straight away.

A result is **complete** only when every question has a final score.
Candidates never see a partial or provisional score, in either mode.

**Switching to Automatic does not publish results that are already
waiting** — you can still publish those yourself.

You may be asked for a fresh authenticator code when you save. Each
change is recorded in the audit log.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.results.list', 'candidate', 'en',
  'Every result your organisation has released to you, newest first, with a link to any certificate you earned.',
  $$## My results

This page lists the results your organisation has **released** to you,
newest first. Each one shows your score, the percentage, whether you
passed, and a link to your certificate when you earned one.

- A result appears here only when marking is finished and it has been
  published — never earlier, and never as a partial score.
- When a result is published we also email you, with a link back to this
  page.
- Don't see an assessment you took? Its result has not been released yet.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.auth.org_code', 'candidate', 'en',
  'Your organisation''s short code, for example acme-college. If you don''t have it, ask your administrator.',
  $$## Organisation code

The code identifies the organisation (a school, college or company) that
registered you, so AssessIQ can find your account. It is made of lowercase
letters, digits and hyphens, for example `acme-college`.

- If you opened this page from a link in an email from us, the code is
  already included and this box is not shown.
- Otherwise, ask your administrator for the code.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Your result appears here within a minute if it can be scored instantly; otherwise it is emailed to you.',
       long_md = $$## After you submit

Your answers are saved and the timer has stopped. There is nothing more
you need to do.

- **Instant scoring.** If every question is multiple choice and your
  organisation publishes results automatically, your result appears on
  this page in under a minute.
- **Otherwise** your result is emailed to your registered address, shown
  here with part of it hidden (for example `r***@gmail.com`). The message
  on this page says how long that usually takes.
- You only ever see a **complete, final** result — never a partial score
  while marking is still in progress.

If the email does not arrive, check your spam folder. You can also sign
in to the candidate portal with the same email address to see your
results.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'candidate.submit.confirm' AND locale = 'en' AND version = 1;

UPDATE help_content
   SET short_text = 'Your result shows your score, the percentage and whether you passed. You only ever see a complete, final result.',
       long_md = $$## Understanding your result

A released result shows four things:

- **Score** — the points you earned out of the total available, for
  example 42 / 60.
- **Percent** — your score as a percentage of the total.
- **Passed or Not passed** — your percentage compared with the pass mark
  set for this assessment.
- **Certificate** — if you earned one, a link to view and verify it.

A result is released only when marking is finished and final. You will
never see a partial or provisional score. Answer keys and per-question
marks are not shown.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'candidate.result.bands' AND locale = 'en' AND version = 1;
