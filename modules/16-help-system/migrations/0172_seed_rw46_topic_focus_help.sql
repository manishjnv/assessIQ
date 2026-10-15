-- 0172_seed_rw46_topic_focus_help.sql
--
-- RW-46 (2026-10-15): help row for the optional "Topic focus" field on the admin generate wizard.
-- NEW  admin.generate_wizard.topic_focus
-- Mirrors content/en/admin.yml (row copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).


INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.generate_wizard.topic_focus',
  'admin',
  'en',
  'Optional. A short subject that the new questions must stay close to.',
  $$## Topic focus

Use this field to point the generator at one narrow subject.

- **Optional.** Leave it empty and the tool uses the category only.
- **Length.** Use 200 characters or fewer. The Generate button stays off while the text is too long.
- **Scope.** The focus applies to every category in this run.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
