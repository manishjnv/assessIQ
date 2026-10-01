-- 0112_seed_mfa_skip_help.sql
--
-- Help content for the "Skip for now" link on the admin authenticator setup
-- page (data-help-id="admin.auth.mfa.skip"), shown only while MFA is optional
-- for the session (MFA_REQUIRED=false). Mirrors content/en/admin.yml.
-- Same pattern as 0110. Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.auth.mfa.skip', 'admin', 'en',
  'Two-factor sign-in is optional for your company right now, so you can skip this and set it up later.',
  $$## Skip authenticator setup for now

Your company does not require two-factor sign-in yet, so you can go straight
to the dashboard with **Skip for now**. You can set up an authenticator app
later from the **Set up authenticator** banner on the dashboard.

We still recommend it: it protects your company's candidate data if your
email account is ever compromised.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
