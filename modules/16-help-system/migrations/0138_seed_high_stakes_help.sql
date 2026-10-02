-- 0138_seed_high_stakes_help.sql
--
-- NEW  admin.assessment.high_stakes        checkbox on the create-assessment form
-- NEW  admin.assessment.high_stakes.edit   "High-stakes grading" card on the assessment detail page
--                                          (+ badge on the super-admin evaluation page)
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.high_stakes', 'admin', 'en',
  'Have two AI models grade every answer. If they do not agree, the answer goes to a person.',
  $$## High-stakes grading

Tick this for tests where a wrong grade matters. Every written answer is
graded by **two different AI models**.

- **They agree:** the grade is proposed as normal.
- **They differ by even one band, or the second model fails:** the answer is
  marked **needs review** and is left out of Accept all. A person decides.
- **Reused grades are switched off.** An identical earlier answer is graded
  again rather than copied.
- It is **off by default**, and grading takes a little longer.

You can also change this after the test is created.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.high_stakes.edit', 'admin', 'en',
  'Turn the two-model vote on or off for this test, even after it is published.',
  $$## Edit high-stakes grading

Tick **Two AI models must agree** and press **Save grading settings**.
Nothing else about the test changes.

- **You can change this after publishing.** It applies to grading runs that
  start afterwards; grades already proposed are not changed.
- When on, any disagreement between the two models, or a failure of the
  second model, sends the answer to **needs review**.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
