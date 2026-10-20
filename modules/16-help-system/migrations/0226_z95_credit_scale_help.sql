-- 0226_z95_credit_scale_help.sql
--
-- Z-95 credit scale x10: help text for admin.settings.billing.usage and .credits_burn states the new amounts
-- (mock 10, real 20, real with camera 30). Mirrors content/en/admin.yml.
-- New version per key = highest existing version + 1; skipped when the same text is already present.
-- Idempotent. Old versions stay (readers take the highest version), as in 0165/0176.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.settings.billing.usage', 'admin', 'en',
  'Mock 10, real 20, real with camera 30 credits per graded attempt. Grading is never blocked. Amber at 80%, red when over.',
  $$## Your plan & usage

**How credits work.**
Credits are used when a candidate attempt reaches the graded state — that
is, after the candidate submits and the AI grading completes. A mock test
uses 10 credits, a real test 20, and a real test with camera 30.
Re-grading the same attempt never charges again; the credits are used once
for each attempt. Credits are counted across your whole organisation.

**Grading is never blocked.**
Assigning, submitting, and grading always work, even when you have used more
than your included credits. The usage indicator is there to keep you informed
— it is not a gate.

**Usage banner colours.**
A banner appears at the top of your dashboard when your usage is notable:

| Colour | Meaning |
|--------|---------|
| Green | You have used less than 80% of your included credits — all clear. |
| Amber | You have used 80–100% of your included credits. Grading still works; consider contacting your platform operator. |
| Red | You are over your included credits. Grading still works — contact your platform operator to discuss your plan. |

Organisations on an unlimited plan see no banner at all.

**Changing your plan.**
You cannot change your own plan. Contact your platform operator — they set
your tier and credit allowance.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.settings.billing.usage' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.settings.billing.usage' AND locale = 'en'
    AND short_text = 'Mock 10, real 20, real with camera 30 credits per graded attempt. Grading is never blocked. Amber at 80%, red when over.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.settings.billing.credits_burn', 'admin', 'en',
  'Credits used so far, split by test type: mock, real, and real with camera.',
  $$## Credits used by test type

A mock test uses 10 credits. A real test uses 20 credits. A real test with
camera uses 30 credits. The credits are used once for each graded attempt.
A re-grade of the same attempt does not use credits again.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.settings.billing.credits_burn' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.settings.billing.credits_burn' AND locale = 'en'
    AND short_text = 'Credits used so far, split by test type: mock, real, and real with camera.'
);
