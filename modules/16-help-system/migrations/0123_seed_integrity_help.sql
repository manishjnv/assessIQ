-- 0123_seed_integrity_help.sql
--
-- Help content for Integrity v1 (2026-10-01):
--   NEW  admin.assessment.integrity.fullscreen        "Require full screen" checkbox (create form)
--   NEW  admin.assessment.integrity.block_copy_paste  "Block copy and paste" checkbox (create form)
--   NEW  admin.attempt.integrity                      Integrity card on the attempt detail page
-- Mirrors content/en/admin.yml. Follows the 0120 pattern: idempotent INSERTs, 0011 NOT
-- regenerated (editing an applied migration trips the tools/migrate.ts checksum guard).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.integrity.fullscreen', 'admin', 'en',
  'Candidates are asked to take the test in full screen. Leaving it is recorded, not prevented.',
  $$## Require full screen

Candidates see a message asking them to enter full screen before they can
carry on. Each time they leave full screen it is **recorded** and shown on
the attempt's Integrity card, and the message appears again.

What it does not do:

- **It cannot stop a candidate leaving full screen.** Browsers always let
  people exit; we only record it.
- **The timer is never paused** while the message is showing.
- **Some devices do not support full screen** (for example iPhones). There the
  test simply carries on and no full-screen events are recorded.

Treat the numbers as a signal to look into, not proof of cheating.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessment.integrity.block_copy_paste', 'admin', 'en',
  'Turns off copy, cut, paste and right-click on the test page. Attempts are still recorded.',
  $$## Block copy and paste

While a candidate takes the test, copy, cut, paste and the right-click menu
are switched off, and a short note tells them so. Each blocked copy or paste is
**recorded** and counted on the attempt's Integrity card.

What it does not do:

- **It only covers the test page.** A candidate can still look at other
  windows or devices; use "Left the test tab" to see how often they left.
- **Typing is unaffected.** Only clipboard use is blocked.

Treat the numbers as a signal to look into, not proof of cheating.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempt.integrity', 'admin', 'en',
  'How often this candidate left the test tab, used copy and paste, or left full screen.',
  $$## Integrity

Counts of what the test page recorded during this attempt:

- **Left the test tab** - switched to another tab or window and came back.
- **Copied / Pasted** - clipboard use. **Pasted (blocked)** is how many pastes
  were stopped because the assessment blocks copy and paste.
- **Left full screen** - only counted when the assessment requires full screen.
- **Opened in another tab** - the attempt was open in a second tab.

These are signals, not scores, and never change the result. Candidates are told
that leaving the tab is recorded and shared with you. A candidate on a device
that does not support the feature will show zero.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
