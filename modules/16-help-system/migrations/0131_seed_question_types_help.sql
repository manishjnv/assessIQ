-- 0131_seed_question_types_help.sql
--
-- Help content for the numeric / multi_select question types (migration 0129):
--   NEW  admin.question.content.numeric
--   NEW  admin.question.content.multi_select
-- Mirrors content/en/admin.yml. Idempotent INSERTs (0011 is not regenerated; editing an
-- applied migration trips the tools/migrate.ts checksum guard).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.content.numeric', 'admin', 'en',
  'Numeric question: the candidate types a number. It is correct if it is within the tolerance of the answer.',
  $$## Numeric question content

The candidate types a number (for example 12.5 or 1,250). Scored automatically,
no AI.

- **question** (required): the text shown to the candidate.
- **answer** (required): the correct number.
- **tolerance** (optional, default 0): how far from the answer still counts,
  as an absolute amount. With answer 100 and tolerance 0.5, anything from 99.5
  to 100.5 is correct.
- **unit** (optional): shown after the input box, for example "km/h". It is only a
  label; there is no unit conversion.
- **rationale** (optional): your note, never shown to the candidate.

Wrong or non-numeric input scores 0. The answer and tolerance are never sent to
the candidate before results are released.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.content.multi_select', 'admin', 'en',
  'Multi-select question: the candidate ticks every option that applies. Scored automatically.',
  $$## Multi-select question content

The candidate sees checkboxes and "Select all that apply". Scored automatically,
no AI.

- **question** (required) and **options** (2 to 10 texts).
- **correct** (required): the numbers of the correct options, counting from 0.
  For options A, B, C, D where A and C are correct, write `[0, 2]`.
- **scoring** (optional): `all_or_nothing` (default) gives full points only when
  the ticked set is exactly the correct set. `partial` gives points x
  (right ticks - wrong ticks) / number correct, never below 0.
- **rationale** (optional): your note, never shown to the candidate.

Options are shuffled per candidate like normal MCQs. Avoid options that point at
each other, such as "All of the above"; those questions keep their written order.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
