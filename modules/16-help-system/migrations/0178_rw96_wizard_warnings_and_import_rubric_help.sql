-- 0178_rw96_wizard_warnings_and_import_rubric_help.sql
--
-- RW-96 (2026-10-16): help for the difficulty-warning chip in the generate wizard Review step,
-- and for the "Draft rubrics" button on the question import page (RW-97). Two new keys, version 1.
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.generate_wizard.review_warnings',
  'admin',
  'en',
  'A structural check found a possible problem in a draft. The draft is still usable.',
  $$## Draft warnings

A warning comes from an automatic structural check on the draft. Hover over the chip to read each one.

- **Advisory only.** A warning does not block the draft. You can still edit it, approve it or leave it.
- **Common codes.** MCQ_DISTRACTOR_LENGTH_SPREAD and MCQ_STEM_OVERLAP are for multiple-choice questions. LOG_LINES_OUT_OF_RANGE, LOG_FINDINGS_OUT_OF_RANGE and SCENARIO_LENGTH_OUT_OF_RANGE are for size limits.
- **What to do.** Read the message, then edit the question if the problem is real.
- **Header count.** The count above the list shows how many drafts have at least one warning.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.draft_rubrics',
  'admin',
  'en',
  'Drafts and saves a rubric for each imported written or scenario question.',
  $$## Draft rubrics

This button writes a rubric for every imported question that needs one.

- **One at a time.** AssessIQ drafts and saves the rubrics one question after another.
- **Busy message.** The AI runs one job at a time. If you see a busy message, try again in a short while.
- **Review.** Open each question in the question editor to read and change its rubric.
- **Scope.** Only written and scenario questions get a rubric.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
