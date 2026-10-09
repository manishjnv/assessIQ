-- 0163_seed_generate_wizard_structured_case_help.sql
--
-- RW-5 (2026-10-09): admin.generate_wizard.page now says structured case
-- questions are written by hand (the wizard generates only mcq, log_analysis,
-- scenario, kql, subjective). New version 2 of the existing key; version 1 stays
-- for history and reads take the newest version. Mirrors content/en/admin.yml.
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. 0011 is not regenerated.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.generate_wizard.page', 'admin', 'en',
  'Platform tool that makes draft questions for a level, a domain and its categories, ready for review.',
  $$## Generate questions

This tool is for AssessIQ platform admins. Companies do not write question packs.

- **Set up.** Pick a level, a domain and the categories. For each category, choose the question types and the number of questions for each type.
- **Generate.** The tool works on one category at a time. You can leave the page. The work continues and you can return later.
- **Review.** Read each draft as a formatted question. You can edit a draft, approve it, or approve many at once.
- **Types.** Multiple-choice, log analysis, scenario, KQL and subjective questions are made here. Numeric, multi-select, ordering and structured case questions are written by hand.
- Nothing reaches a candidate until you approve it.
$$,
  2, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
