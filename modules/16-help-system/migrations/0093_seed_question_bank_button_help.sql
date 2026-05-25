-- 0093_seed_question_bank_button_help.sql
--
-- Inline button help (Wave 1) for the Question Bank list + Pack detail pages
-- (modules/10-admin-dashboard/src/pages/question-bank.tsx + pack-detail.tsx).
-- Backs the HelpTip tooltips on: New Pack, Add to workspace, Generate questions,
-- Publish pack, Archive pack, Activate drafts.
--
-- WHY a separate migration instead of regenerating 0011:
--   0011_seed_help_content.sql is already applied in production and the runner
--   never re-applies a migration by content, so help rows authored after 0011
--   must ship as a forward migration. Source of truth is
--   content/en/admin.yml (these rows are byte-identical to its new entries).
--   Same pattern as 0089_seed_gen_score_help.sql and 0092_seed_platform_domain_help.sql.
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING. Global
-- rows (tenant_id IS NULL) must be inserted as the postgres superuser, which
-- BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.list.new_pack', 'admin', 'en',
  'Create a new question pack for a domain. Super-admin only — it starts empty, in Draft.',
  $$## New pack

Creates an empty question pack for one role-readiness domain. A new pack
starts in **Draft**: you add levels and questions, then **Publish** it to
make it usable in assessments. Only super-admins can create packs — company
admins build assessments from packs they've been licensed.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.list.add_to_workspace', 'admin', 'en',
  'Copy a licensed platform set into your company so you can build assessments from it.',
  $$## Add to workspace

Makes your own copy of a platform question set your company is licensed for
("clone-on-use"). The copy lives in your Question Bank and is what your
assessments draw from. Adding it again is a no-op — you already have the copy.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.generate', 'admin', 'en',
  'Open the wizard to AI-generate draft questions for this pack. Drafts need review before going live.',
  $$## Generate questions

Opens the generation wizard, which uses the pack's knowledge base to produce
`ai_draft` questions for a level. Generation never publishes or activates —
each draft must be reviewed (and edited if needed) before it can be used.
Super-admin only.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.publish', 'admin', 'en',
  'Lock the pack and make it usable — snapshots questions and activates every draft so assessments can draw them.',
  $$## Publish pack

Flips the pack from Draft to **Published**, snapshots every question as a
permanent version, and **activates all draft questions** so assessments can
immediately draw from them ("published = usable"). Editing a question after
publish adds a new version; already-published assessments stay pinned to the
snapshot they were built on.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.archive', 'admin', 'en',
  'Retire this pack and hide it from pickers. Reversible via the Archived tab; blocked if a live assessment uses it.',
  $$## Archive pack

Soft-deletes the pack: it disappears from the default list and the
assessment-creation pickers. This is the only delete path — there is no hard
delete. It's reversible (find it under the **Archived** filter). Archiving is
refused if a currently-live assessment still references the pack.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.activate_drafts', 'admin', 'en',
  'Activate draft questions added after publishing so assessments can draw them. Publish already activates the rest.',
  $$## Activate drafts

Publishing a pack already activates its questions. This button only matters
for **draft questions added to a pack that is already published** — it flips
those remaining drafts to `active` so assessments can draw them. It appears
only when a level actually has draft questions waiting.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
