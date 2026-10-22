-- 0241_accent_colour_help.sql
--
-- Z-119: help for the organisation colour field on the organisation settings page. Mirrors content/en/admin.yml.
-- New key only, version 1. Idempotent: INSERT ... WHERE NOT EXISTS, as in 0239.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.tenant_settings.accent_colour', 'admin', 'en',
  'Colour for buttons and links. It must be readable on white (contrast 4.5 to 1 or more). Blank = default.',
  $$## Organisation colour

Pick the colour for buttons and links in your admin and candidate screens. The colour must be readable as text on white, with a contrast of at least 4.5 to 1. The page shows the contrast and a preview button before you save. Leave the field blank to use the default colour. Changing the colour needs a fresh authenticator check.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.accent_colour' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.tenant_settings.accent_colour' AND locale = 'en'
    AND short_text = 'Colour for buttons and links. It must be readable on white (contrast 4.5 to 1 or more). Blank = default.'
);
