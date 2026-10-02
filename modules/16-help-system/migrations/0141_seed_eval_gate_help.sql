-- 0141_seed_eval_gate_help.sql
--
-- NEW  admin.evaluations.eval_gate       eval-gate warning banner on /admin/platform/evaluations
-- NEW  admin.evaluations.grading_quality AI grading quality (override rate per prompt version) card
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.eval_gate', 'admin', 'en',
  'Warns when the AI grading prompts have changed since the last eval you approved.',
  $$## Eval gate

The grading prompts are files on the server. After any edit, run the eval on the
server and **bless** it; that records the prompts as approved.

- **Blocked** — the gate is set to enforce and the prompts are not approved, so AI
  grading refuses to run until the eval is blessed.
- **Not approved yet** — the gate only warns. Grading still works, but the current
  prompts have not been through a passing eval.

The steps are in `modules/07-ai-grading/eval/README.md`: run, compare, bless, then
switch the gate to enforce.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.grading_quality', 'admin', 'en',
  'How often admins changed the AI''s grade, for each version of the grading prompts.',
  $$## AI grading quality

One row per version of the grading prompts (the short code is the prompt version),
over the last 90 days.

- **AI grades** — grades the AI gave.
- **Overrides** — grades an admin changed afterwards.
- **Override rate** — overrides divided by AI grades. Lower is better.
- **Band change** — on average, how many bands (0 to 4) the admin moved the grade.
- **Score change** — on average, how much the score moved, as a percent of the
  question's points.

A version with few grades is not reliable yet. Use this to compare a new prompt
version with the one before it.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
