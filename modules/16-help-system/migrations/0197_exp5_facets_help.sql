-- 0197_exp5_facets_help.sql
--
-- EXP-5 (2026-10-17): help rows for the search box and filters on the question set page.
--   NEW admin.question_bank.pack.filter_search
--   NEW admin.question_bank.pack.filter_stage
--   NEW admin.question_bank.pack.filter_subject
--   NEW admin.question_bank.pack.filter_unit
--   NEW admin.question_bank.pack.filter_outcome
--   NEW admin.question_bank.pack.filter_difficulty
--   NEW admin.question_bank.pack.filter_origin
--   NEW admin.question_bank.pack.filter_rights
--   NEW admin.question_bank.pack.filter_review
--   NEW admin.question_bank.pack.filter_language
--   NEW admin.question_bank.pack.filter_solution
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.
-- Production help rows come from forward migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_search',
  'admin',
  'en',
  'Search the text of the questions. A small typing mistake still finds the question.',
  $$## Search questions

Type words from a question or its answer options. The list updates after a short pause. The search ignores letter case and the solution text. If no question has all your words, AssessIQ also looks for words that are close, so a small typing mistake still finds the question. Clear the box to show all questions again.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_stage',
  'admin',
  'en',
  'Show only questions linked to one exam stage.',
  $$## Exam stage

Pick an exam stage, for example a tier of an exam. The list shows questions linked to that stage. The number in brackets is how many questions match with your other filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_subject',
  'admin',
  'en',
  'Show only questions in one subject.',
  $$## Subject

Pick a subject from the subject map. The list shows questions linked to that subject or to any topic or subtopic below it. The number in brackets is how many questions match with your other filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_unit',
  'admin',
  'en',
  'Show only questions in one topic.',
  $$## Topic

Pick a topic, for example Arithmetic. The list shows questions linked to that topic or to any subtopic below it. The number in brackets is how many questions match with your other filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_outcome',
  'admin',
  'en',
  'Show only questions in one subtopic.',
  $$## Subtopic

Pick the most specific level, for example Percentage. The list shows questions linked to that subtopic. The number in brackets is how many questions match with your other filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_difficulty',
  'admin',
  'en',
  'Show only questions in a difficulty range from 1 (easy) to 5 (hard).',
  $$## Difficulty

Choose the lowest and the highest difficulty. Both ends are included. Questions with no difficulty set are hidden while you use this filter. The number in brackets is how many questions have that difficulty with your other filters.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_origin',
  'admin',
  'en',
  'Show only questions from one source type, for example written by hand or by AI.',
  $$## Origin

Origin tells you where a question came from: written by hand, written by AI, rewritten from a source, copied from a web page, uploaded by an organisation, or licensed. Pick one value to filter the list.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_rights',
  'admin',
  'en',
  'Show only questions with one rights status.',
  $$## Rights

Rights status tells you who may use a question. A question set that holds a question with an unsafe status cannot be published. Pick one value to filter the list.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_review',
  'admin',
  'en',
  'Show only questions in one review state.',
  $$## Review

Review state shows how far a question is in the check by the super admin: in review, verified, disputed, or needs a fix. Not set means the question has not entered review. Pick one value to filter the list.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_language',
  'admin',
  'en',
  'Show only questions written in one language.',
  $$## Language

Pick the main language of the question, for example en for English or hi for Hindi.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.filter_solution',
  'admin',
  'en',
  'Show only questions with, or without, a written solution.',
  $$## Solution

A question has a solution when its explanation text is not empty. Pick With solution or Without solution to filter the list.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
