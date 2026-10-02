-- 0133_seed_test_sections_help.sql
--
-- NEW  admin.assessment.sections       "Test sections" fieldset on the create-assessment form
-- NEW  candidate.attempt.section       section header / timer / "Finish section" in the runner
-- NEW  candidate.attempt.calculator    on-screen calculator
-- Mirrors content/en/admin.yml + candidate.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.sections', 'admin', 'en',
  'Split the test into timed sections, such as Quantitative, Logical and Verbal.',
  $$## Test sections

Add a section for each part of the test. For each one set a **name**, the
**number of questions**, the **minutes** and whether a **calculator** is allowed.
You can also tick **categories** so the section only draws from them.

- **Each section has its own timer.** When it runs out, that section's answers
  are locked and the student moves on to the next section.
- **The student cannot go back** to a finished section.
- **The whole test ends** when the last section ends. The total time is the
  sum of the section minutes (the level's duration is not used).
- **No sections?** Leave this empty and the test works as before, with one timer.
- You cannot combine sections with a blueprint.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.attempt.section', 'candidate', 'en',
  'This test has timed sections. You cannot return to a section once it is finished.',
  $$## Test sections

The test is split into sections. The timer at the top is for the **current
section** only.

- When the section timer reaches zero, your answers in that section are saved
  and locked, and the next section opens.
- Press **Finish section** to move on early. You will be asked to confirm,
  because **you cannot come back** to that section.
- The test ends when the last section ends, or when you submit in the last section.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.attempt.calculator', 'candidate', 'en',
  'A basic calculator for this section: add, subtract, multiply, divide.',
  $$## Calculator

Use the on-screen buttons or your keyboard: digits and **.** to type, **+ - * /**
for the operations, **Enter** or **=** for the result, **Backspace** to delete
and **Esc** to clear.

It is a basic calculator with no memory. Your answer still has to be typed into
the question yourself.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
