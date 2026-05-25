-- 0092_seed_platform_domain_help.sql
--
-- Forward seed for the two `admin.platform.domains` / `admin.platform.domain_name`
-- help keys that back the Platform Domains management section + its create-form
-- name field (modules/10-admin-dashboard/src/pages/platform.tsx).
--
-- WHY a separate migration instead of relying on 0011:
--   0011_seed_help_content.sql is already applied in production and the migration
--   runner never re-runs an applied migration by content, so new help rows
--   authored after 0011 must ship as a forward migration to reach prod. The
--   canonical 0011 seed has ALSO been regenerated in this PR so the generator
--   output stays in sync with content/en/admin.yml; these INSERTs are
--   byte-identical to the platform-domain rows it emits. (Same pattern as
--   0089_seed_gen_score_help.sql.)
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING — safe to
-- apply more than once. Global rows (tenant_id IS NULL) must be inserted as the
-- postgres superuser, which BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.domains',
  'admin',
  'en',
  'Subject domains shared across every company. Archiving hides a domain everywhere without revoking licenses.',
  $$## Platform domains

Platform domains are the subject-area categories that the platform
operator defines and propagates to every company tenant.

**Creating a domain** makes it available in every company's domain
pickers immediately. The URL slug is generated automatically from the
name and cannot be changed after creation.

**Archiving a domain** removes it from every company's pickers and
prevents new entitlements or assessments from being based on it.
Archiving is catalog-only — it does not revoke existing licenses or
alter previously published assessments. Questions tagged to an archived
domain keep their tags. You can reactivate the domain at any time.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.domain_name',
  'admin',
  'en',
  'The domain name; the URL slug is generated automatically and shared across all companies.',
  $$## Domain name

Enter a human-readable name for the domain (for example, "Security
Operations" or "Cloud Infrastructure"). The platform generates a
URL-safe slug from the name automatically. The slug is shared across
every company tenant and appears in entitlement records, question tags,
and API responses.

The slug cannot be changed after the domain is created, so choose a
name that reflects a stable subject area.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
