-- 0202_z41_key_shortcuts_help.sql
--
-- Z-41 (2026-10-18): help row for the P and N keyboard shortcut switch on the take page.
--   NEW candidate.attempt.key_shortcuts
-- Mirrors content/en/candidate.yml (row copied from the regenerated seeds/help_content.sql).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New key only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.key_shortcuts',
  'candidate',
  'en',
  'Turn the P (Previous) and N (Next) keys on or off. Tick the box to use them.',
  $$## Keyboard shortcuts P and N

Two single keys move between questions. Press **P** for the previous question.
Press **N** for the next question.

- **The box is ticked by default.** The keys work when your cursor is not in a
  text box, a list or an editor.
- **Clear the box to turn the keys off.** Then P and N do nothing. This stops
  accidental moves if you use speech input or press keys by mistake.
- **Your choice stays on this browser.** It does not change your answers.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
