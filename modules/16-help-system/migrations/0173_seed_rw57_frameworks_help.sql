-- 0173_seed_rw57_frameworks_help.sql
--
-- RW-57 part 2 (2026-10-15): help row for the "Curriculum frameworks" section on the Platform page.
-- NEW  admin.platform.frameworks
-- Mirrors content/en/admin.yml (row copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).


INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.frameworks',
  'admin',
  'en',
  'Board curricula that you can load into the shared catalog. Loading again updates the same entries.',
  $$## Curriculum frameworks

A curriculum framework is a board syllabus: grades, subjects and chapter
titles. It holds structure only. It holds no questions.

**Load** adds the curriculum to the shared catalog. Every organisation
can then use it.

**Reload** runs the same load again. It updates changed entries and adds
no copies. It never removes an entry.

The Release column shows the edition in the bundled file. The Loaded
column shows the edition now in the catalog.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
