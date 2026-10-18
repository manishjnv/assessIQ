-- 0204_z23_webhook_secret_help.sql
--
-- Z-23 session 2 (2026-10-18): the Webhook secret card moved from the Embed page to the
-- Webhooks page. Three help rows for the card on the new page.
--   NEW admin.webhooks.secret, admin.webhooks.secret_value, admin.webhooks.secret_regenerate
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- The old admin.embed.webhook_secret row stays (no unused row is deleted).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.secret',
  'admin',
  'en',
  'The key that signs every webhook request from your organisation.',
  $$## Webhook secret

AssessIQ signs each webhook request with one organisation key. Your server uses the key to check that a request is real. The key is different from the embed signing secrets on the Embed tab.

- **The key shows once.** The system cannot show an old key again.
- **One key covers all endpoints.** A new key replaces the old key for every endpoint.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.secret_value',
  'admin',
  'en',
  'The new key shows here one time. Copy it before you leave the page.',
  $$## The key value

The field is hidden until you regenerate the key. Select the eye icon to show or hide the key. Select **Copy** and store the key in a safe place. If you lose it, regenerate it.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.secret_regenerate',
  'admin',
  'en',
  'Make a new webhook key. The old key stops working at once.',
  $$## Regenerate the webhook secret

Select **Regenerate** and confirm. The old key stops working at once, so requests that your server checks with the old key fail. Update your server with the new key straight away.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
