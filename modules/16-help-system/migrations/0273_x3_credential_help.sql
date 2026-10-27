-- 0273_x3_credential_help.sql
--
-- Help for the credential share row and expiry on the public verify page (X3a, X3b). Four new keys, version 1.
-- Mirrors content/en/candidate.yml. Idempotent: INSERT ... WHERE NOT EXISTS (as in 0271).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'public.verify.share_whatsapp', 'all', 'en',
  'Send this verified credential to a friend or group on WhatsApp.',
  $$## Share on WhatsApp

Opens WhatsApp with a short message and the public verification link
of this certificate. Anyone who opens the link can check that it is real.

Only **active** certificates can be shared. A revoked or expired certificate
has no WhatsApp link.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'public.verify.share_whatsapp' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'public.verify.share_whatsapp' AND locale = 'en'
    AND short_text = 'Send this verified credential to a friend or group on WhatsApp.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'public.verify.share_x', 'all', 'en',
  'Post this verified credential on X.',
  $$## Share on X

Opens the X post box with a short message and the public verification link
of this certificate. You can change the text before you post.

Only **active** certificates can be shared. A revoked or expired certificate
has no X link.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'public.verify.share_x' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'public.verify.share_x' AND locale = 'en'
    AND short_text = 'Post this verified credential on X.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'public.verify.valid_until', 'all', 'en',
  'The last day this certificate counts as valid.',
  $$## Valid until

Some certificates have an end date. After this date the page shows
**Expired**. A certificate with no end date does not expire.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'public.verify.valid_until' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'public.verify.valid_until' AND locale = 'en'
    AND short_text = 'The last day this certificate counts as valid.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'public.verify.expired', 'all', 'en',
  'The end date of this certificate has passed.',
  $$## Expired

The end date of this certificate has passed. The certificate was real when
it was issued, but it is no longer current. Sharing is switched off.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'public.verify.expired' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'public.verify.expired' AND locale = 'en'
    AND short_text = 'The end date of this certificate has passed.'
);
