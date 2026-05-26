-- 0099_seed_candidate_fields_help.sql
--
-- Help content for the candidate Name + Designation fields shown in the
-- "Add candidate" drawer on the admin Users page
-- (modules/10-admin-dashboard/src/pages/users.tsx, data-help-id="admin.users.candidate.fields").
--
-- WHY a separate migration instead of regenerating 0011:
--   0011_seed_help_content.sql is already applied in production and the runner
--   never re-applies a migration by content, so help rows authored after 0011
--   must ship as a forward migration. Source of truth is
--   content/en/admin.yml (this row is byte-identical to its new entry there).
--   Same pattern as 0093, 0094, 0097.
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING. Global
-- rows (tenant_id IS NULL) must be inserted as the postgres superuser, which
-- BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.users.candidate.fields', 'admin', 'en',
  'Candidates are added directly with no email sent. Name is shown in their assessment link; designation is optional.',
  $$## Adding a candidate

Candidates are added directly to the tenant — no invitation email is sent
at this step. They receive a secure assessment link only when you assign
them to a specific assessment from the assessment's detail page.

**Name** is required. It is shown in the candidate's assessment invitation
email and appears in grading and reporting views.

**Designation** is optional free-text context (e.g. "SOC Analyst L1",
"Junior DevOps Engineer"). It is stored as metadata on the user record and
surfaced in exports and the grading UI to help admins distinguish between
candidates with similar profiles. It does not affect scoring or access.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
