-- 0145_seed_ordering_help.sql
--
-- NEW  admin.question.content.ordering, admin.question.ordering.items, admin.question.ordering.scoring
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.content.ordering', 'admin', 'en',
  'Ordering question: the candidate puts the items in the right order. Scored automatically.',
  $$## Ordering question

The candidate sees the items in a shuffled order and moves them with Up and Down
buttons. Scored automatically, no AI.

- Write a **question** and **2 to 10 items**, in the CORRECT order.
- The order you type is the answer key. Each candidate sees the items shuffled,
  and never in the correct order.
- A blank answer scores 0. The answer key is never sent to the candidate.
- To ask "pick the log line", use a multi-select question whose options are the log lines.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.ordering.items', 'admin', 'en',
  'Type the items in the correct order. Candidates see them shuffled.',
  $$## Items

Type each item on its own row, in the order that is **correct**. Use Up and Down
to move a row and Remove to delete it. You need at least 2 and at most 10 items.

Do not write the order in the item text, for example "Step 1". The candidate sees
the items in a shuffled order.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.ordering.scoring', 'admin', 'en',
  'All or nothing, or partial credit for items in the right place.',
  $$## Scoring

- **All or nothing** (default): full points only when every item is in the right place.
- **Partial credit**: points x (items in the right place) / (number of items).

A missing or invalid answer scores 0.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
