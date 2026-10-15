-- 0171_seed_rw45_account_security_help.sql
--
-- RW-45 (2026-10-15): help rows for the admin Account security page (recovery-code
-- regeneration) and the super-admin "Reset two-factor" action.
-- NEW  admin.account.security.page, admin.account.security.regenerate, admin.account.security.code_field, admin.account.security.confirm, admin.account.security.new_codes, admin.account.security.copy_codes, admin.account.security.codes_saved, admin.account.security.enrol, admin.users.list.reset_totp
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.page',
  'admin',
  'en',
  'Your two-factor sign-in status and backup codes.',
  $$## Account security

This page shows if two-factor sign-in is on for your account.

- Select **Regenerate recovery codes** to make a new set of backup codes.
- If two-factor is off, select the link to set it up.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.regenerate',
  'admin',
  'en',
  'Make a new set of backup codes. The old codes stop working.',
  $$## Regenerate recovery codes

Enter a current code from your authenticator app to confirm it is you.
After this, the old backup codes no longer work.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.code_field',
  'admin',
  'en',
  'The 6-digit code that your authenticator app shows now.',
  $$## Authenticator code

Open your authenticator app and type the 6-digit code for AssessIQ.
If the code is not correct, your old backup codes stay valid.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.confirm',
  'admin',
  'en',
  'Check the code and make the new backup codes.',
  $$## Make new codes

This button checks your code. If the code is correct, the page shows the new backup codes once.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.new_codes',
  'admin',
  'en',
  'Your new backup codes. They show once only.',
  $$## New backup codes

Each code works one time if you lose your authenticator app.
Save the codes in a safe place before you leave this page.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.copy_codes',
  'admin',
  'en',
  'Copy all new backup codes to the clipboard.',
  $$## Copy all

Copies the backup codes so that you can paste them in a password manager.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.codes_saved',
  'admin',
  'en',
  'Confirm that you saved the new backup codes.',
  $$## I saved them

Select this button only after you saved the codes. The codes are not shown again.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.account.security.enrol',
  'admin',
  'en',
  'Set up two-factor sign-in with an authenticator app.',
  $$## Set up two-factor sign-in

Opens the set-up page. You get backup codes at the end of set-up.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.users.list.reset_totp',
  'admin',
  'en',
  'Remove the two-factor sign-in of a user. Needs a reason.',
  $$## Reset two-factor

Removes the authenticator app and all backup codes of this user.
The user must set up two-factor again at next sign-in.

- A reason is required. It is saved in the audit log.
- You cannot reset your own two-factor here.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
