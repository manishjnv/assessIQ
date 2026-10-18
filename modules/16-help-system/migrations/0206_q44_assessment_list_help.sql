-- 0206_q44_assessment_list_help.sql
--
-- Q44 (2026-10-19): help rows for the assessments list row delete/cancel action,
-- the "Clear empty drafts" button and the simplified status tabs.
--   NEW admin.assessments.row_delete
--   NEW admin.assessments.clear_empty_drafts
--   NEW admin.assessments.status_tabs
-- Mirrors content/en/admin.yml. Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.row_delete',
  'admin',
  'en',
  'Delete a test that has no attempts, or cancel a test that has attempts.',
  $$## Delete or cancel a test

Each row has one action. The action depends on whether candidates started the test.

- **Delete** removes a test that no candidate started. It also removes its invitations. You cannot undo it.
- **Cancel** retires a test that candidates started. The attempts and results stay. You cannot undo it.
- **A confirm box opens first.** It names the test and says if you can undo the action.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.clear_empty_drafts',
  'admin',
  'en',
  'Delete all empty drafts in one step. An empty draft has no attempts and no invitations.',
  $$## Clear empty drafts

Use this to remove drafts you made by mistake.

- **Empty means three things.** The test is a draft, it has no attempts, and it has no invitations.
- **The box shows the count first.** You confirm before anything is deleted. You cannot undo it.
- **Other tests stay.** The server checks each test again and skips any that is not an empty draft.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.status_tabs',
  'admin',
  'en',
  'Filter the list: All, Drafts, Live (published or active), or Finished (closed or cancelled).',
  $$## Status tabs

- **All** shows every test except cancelled tests.
- **Drafts** shows tests you have not published.
- **Live** shows tests that are published or active.
- **Finished** shows tests that are closed or cancelled.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
