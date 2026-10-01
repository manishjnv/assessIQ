-- 0120_seed_invite_resend_help.sql
--
-- Help content for candidate-invitation resend + 7-day links (2026-10-01), on the
-- admin assessment detail page (modules/10-admin-dashboard/src/pages/
-- assessment-detail.tsx, "Invitations." section):
--   NEW      admin.assessments.invitations.resend         per-row "Resend" button
--   NEW      admin.assessments.invitations.resend_all     "Resend to everyone who
--                                                         hasn't started (n)" button
--   NEW      admin.assessments.invitations.resend_result  resent / skipped / still-to-send chips
--   UPDATED  admin.platform.admin_email                   said the first-admin invitation
--                                                         link is valid 72 h; it has been
--                                                         7 days since 03-users shipped
--                                                         (copy fix, same flavour as the
--                                                         candidate-link 72 h -> 7 d fix)
-- Mirrors content/en/admin.yml. Follows the 0115 / 0116 pattern.
-- Idempotent: INSERTs use ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
-- the UPDATE rewrites only the global v1 row (tenant overrides untouched) and is
-- safe to re-run. 0011 is NOT regenerated: editing an applied migration trips the
-- tools/migrate.ts checksum-drift guard at deploy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invitations.resend', 'admin', 'en',
  'Email this candidate a new link, valid for 7 days. The old link stops working straight away.',
  $$## Resend an invitation

Use this when a candidate missed the 7-day window, lost the email, or you
revoked their invitation by mistake.

- **A new link is emailed** and is valid for 7 days from now.
- **The old link stops working** the moment you press Resend. If the
  candidate opens it, they are told it has expired or been replaced and to
  use the newest email.
- Works for invitations that are waiting, opened, expired or revoked.
- **Not available once the candidate has started.** From then on the
  attempt belongs to them, so the button is hidden and their row shows
  **View attempt**.

Inviting a candidate again (from **+ Invite candidates** or a CSV import)
after their invitation was revoked or expired does the same thing.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invitations.resend_all', 'admin', 'en',
  'Email a new 7-day link to every candidate who hasn''t started. Their old links stop working.',
  $$## Resend to everyone who hasn't started

Sends a fresh link to each candidate on this assessment who has not
started: invitations that are waiting, opened or expired. The number in
brackets is how many emails will go out.

- **Old links stop working** straight away, so each candidate must use the
  newest email.
- **Revoked invitations are left alone.** Resend those one at a time from
  their row.
- **Candidates who have started** are never touched.
- **Up to 200 emails per click.** If more are waiting you are told how many
  are left; press the button again to send the rest. Links sent in the last
  10 minutes are not sent twice.
- Invitation emails go out through the normal email queue, so a large batch
  may take a little while to arrive.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invitations.resend_result', 'admin', 'en',
  'How many invitations were resent, how many were skipped (and why), and how many are still to send.',
  $$## Resend result

- **Resent** — new links emailed.
- **Skipped** — rows that could not be resent, with the reason, for example
  the candidate started in the meantime, their account is disabled, or the
  email could not be queued. Skipped rows are not lost: open the row and
  press Resend to try again.
- **Still to send** — more candidates are waiting than one click can send
  (200). Press **Resend to everyone who hasn't started** again to continue.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Email address of the company''s first admin. An invitation link (valid 7 days) is sent here on provisioning.',
       long_md = $$## First-admin email

The email address entered here receives a one-time invitation link
immediately after the tenant is provisioned. The link is valid for 7 days.

The invited user signs in via the link and is granted `role = admin` for
the new tenant. They can then invite additional admins and reviewers from
the Users page.

If the invitation expires before the admin accepts it, a platform operator
can re-provision or manually re-invite via the API.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.admin_email' AND locale = 'en' AND version = 1;
