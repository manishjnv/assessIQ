-- 0157_seed_help_content_admin_help.sql
--
-- FU-D1/FU-D2/FU-D3 (2026-10-06): the help-content admin page now calls the
-- real routes and has five new elements. NEW keys, all under the page prefix
-- admin.settings.help_content:
--   .page, .scope, .locale, .list, .import
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.
-- 0011 is regenerated from the YAML in the same commit (fresh DBs get the rows
-- from 0011; production gets them from this file).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.page', 'admin', 'en',
  'Edit the help text shown in tooltips and the help drawer. Each save creates a new version.',
  $$## Help content

This page lists every help entry for one locale. Each entry has a key, a short
text (the tooltip) and a longer Markdown body (the help drawer).

- **Platform admins** edit the global text that every company sees.
- **Company admins** can save a company override. The platform text is kept.
- Each save creates a new version. Older versions stay in the database.
- Use **Export JSON** and **Import JSON** for a translation round trip.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.scope', 'admin', 'en',
  'Platform admins change the global text. Company admins save an override for their company only.',
  $$## Global text or company override

- A **global** row has no company. Every company without an override sees it.
- A **company override** replaces the global text for that company only.
- A platform admin save creates a new global version. A company admin save
  creates a new override version.
- The key never changes. It links the text to the screen element.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.locale', 'admin', 'en',
  'The language code of the rows shown, for example en or hi-IN. Readers get en when their locale has no row.',
  $$## Locale

Type a language code such as `en` or `hi-IN` to list the rows for that locale.
When a reader asks for a locale that has no row, the `en` text is shown.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.list', 'admin', 'en',
  'One card per help key. The chip tells if the text is global or a company override, and its version.',
  $$## Entry list

Each card shows the key, the scope chip, the version and the audience, then the
short text and the first lines of the body. Select **Edit** to change the text.
Use the search box to filter by key or short text.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.import', 'admin', 'en',
  'Import a JSON file in the export format. Rows are saved as company overrides for the selected locale.',
  $$## Import JSON

Upload a file that you exported from this page (a list of entries with `key`,
`shortText`, `longMd` and `audience`). Every row is saved as a company override
for the locale shown on the page. A row that already exists at the same version
is skipped.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
