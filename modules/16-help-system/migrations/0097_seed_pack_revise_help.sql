-- 0097_seed_pack_revise_help.sql
--
-- Inline button help for the new "Revise (new version)" CTA on the Pack detail
-- page (modules/10-admin-dashboard/src/pages/pack-detail.tsx). Backs the
-- HelpTip on the Revise button added with the "lock at assignment" feature.
--
-- WHY a separate migration instead of regenerating 0011:
--   0011_seed_help_content.sql is already applied in production and the runner
--   never re-applies a migration by content, so help rows authored after 0011
--   must ship as a forward migration. Source of truth is
--   content/en/admin.yml (this row is byte-identical to its new entry).
--   Same pattern as 0093_seed_question_bank_button_help.sql.
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING. Global
-- rows (tenant_id IS NULL) must be inserted as the postgres superuser, which
-- BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.revise', 'admin', 'en',
  'Move a published pack to draft, edit, then re-publish as a new version. Existing tests are unaffected.',
  $$## Revise (new version)

Moves a **Published** pack back to **Draft** so you can edit it, then you
re-publish it as a new version. Super-admin only — this acts on the platform
master library. Already-published assessments keep the exact content they were
locked with at publish (they're frozen, so candidates are unaffected). When you
re-publish, every tenant clone of this set auto-updates in place, and only
NEWLY-published assessments draw the new content.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
