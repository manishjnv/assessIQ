-- 0153_seed_structured_case_help.sql
--
-- NEW  admin.question.editor.content.structured_case, admin.question.editor.structured_case.steps,
--      admin.question.editor.structured_case.scoring, candidate.attempt.structured_case
-- Mirrors content/en/admin.yml and candidate.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.editor.content.structured_case', 'admin', 'en',
  'Structured case: a log or incident story, then choice steps. Scored automatically.',
  $$## Structured case

Use this for "select the suspicious lines", "which IOC" or "what is the next step"
questions. The candidate reads a **context** and an optional **log excerpt**, then
answers each **step**. Scored automatically, no AI.

- Write a **title** and a **context**. The log excerpt is optional and shows in a monospace box.
- Add 1 to 12 **steps**. Each step is a choice question with 2 to 8 options.
- The correct marks are the answer key. They are never sent to the candidate.
- Options are shown in the order you write them.
- For free-text answers, use a scenario or subjective question instead.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.editor.structured_case.steps', 'admin', 'en',
  'Each step: a prompt, one or many answers, 2 to 8 options, and the correct marks.',
  $$## Steps

For each step write a **prompt** and the **options**. Then choose how the candidate answers:

- **Select one**: use the radio mark for the single correct option.
- **Select many**: tick every correct option.

A step needs at least 2 and at most 8 options, and at least one correct option.
A question has 1 to 12 steps.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.editor.structured_case.scoring', 'admin', 'en',
  'Partial credit gives the average of the step scores. All or nothing needs every step right.',
  $$## Scoring

- **Partial credit** (default): the question score is the average of the step scores.
  A many-select step scores (right ticks - wrong ticks) / (number correct), never below 0.
- **All or nothing**: full points only when every step is fully right.

A missing or invalid answer scores 0 for that step.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.attempt.structured_case', 'candidate', 'en',
  'Read the case, then answer each step. Choose one answer or tick all that apply.',
  $$## Structured case

Read the story and the log first. Then answer each step in order.

- A round button means choose **one** answer.
- A square box means tick **all** answers that apply.
- You can change your answers until you submit the test.
- A step you leave blank scores 0.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
