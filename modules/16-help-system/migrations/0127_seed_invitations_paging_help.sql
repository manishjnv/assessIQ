-- 0127_seed_invitations_paging_help.sql
-- Help content for the paged invitations list (2026-10-02):
--   NEW  admin.assessments.invitations.paging  "Showing x-y of N" + Previous / Next
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invitations.paging', 'admin', 'en',
  'Invitations are shown 100 at a time. Use Previous and Next to move between pages.',
  $$## Invitation pages

The list shows up to 100 invitations at a time. The line on the left says
which rows you are looking at, for example **Showing 101-200 of 340**.

- **Previous / Next** move one page. Sorting applies to the page on screen.
- **Resend to everyone who hasn't started** always covers every page, not
  only the one you are looking at.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
