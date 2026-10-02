-- 0146_update_help_text_corrections.sql
--
-- Help-text correction pass (review fix RS3). Mirrors content/en/*.yml.
-- UPDATED 29 existing keys: internal words removed from customer-visible text, untrue claims
--   corrected (tenant AI budget, tenant re-run, Google-only sign-in, email template editor,
--   KQL 'AI rubric review', revoke audit wording, consent text), pasted paragraph moved.
-- NEW      10 keys (UI help ids and page prefixes that had no content).
-- Safe to run once with psql and safe to re-run: UPDATEs rewrite only the global v1 rows
-- (tenant overrides are untouched); the INSERTs use ON CONFLICT DO NOTHING.
-- 0011 is regenerated from the YAML by tools/generate-help-seed.ts and is not applied by hand.

UPDATE help_content
   SET short_text = 'Your organization''s slug — the unique URL-safe ID we issued during onboarding (e.g. acme-soc).',
       long_md = $$## Tenant slug

Each AssessIQ tenant has a short, URL-safe identifier you'll use at every
sign-in. It usually mirrors your team or product name (e.g. `acme-soc`,
`acme-secops`). Your AssessIQ administrator received the slug at onboarding;
if you don't have it, ask them — it is not the same as your email domain.

The slug is also used in webhook payloads and embed-iframe URLs, so once it
is set it stays stable. Renaming a tenant is a manual operation that
requires support.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.auth.login.tenant_slug' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.auth.login.tenant_slug', 'admin', 'en',
  'Your organization''s slug — the unique URL-safe ID we issued during onboarding (e.g. acme-soc).',
  $$## Tenant slug

Each AssessIQ tenant has a short, URL-safe identifier you'll use at every
sign-in. It usually mirrors your team or product name (e.g. `acme-soc`,
`acme-secops`). Your AssessIQ administrator received the slug at onboarding;
if you don't have it, ask them — it is not the same as your email domain.

The slug is also used in webhook payloads and embed-iframe URLs, so once it
is set it stays stable. Renaming a tenant is a manual operation that
requires support.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'First-time admins enroll an authenticator app here; returning admins enter their 6-digit code to sign in.',
       long_md = $$## TOTP enrollment vs verification

The first time an admin signs in, AssessIQ shows a QR code and asks you to
scan it with an authenticator app (Google Authenticator, Authy, 1Password,
Microsoft Authenticator). After scanning, enter the 6-digit code shown in
the app to confirm the secret matches.

Returning admins skip the QR code and only enter the 6-digit code. Codes
rotate every 30 seconds; AssessIQ accepts the previous, current, and next
code to absorb small clock drifts.

Lockout policy: five wrong codes in a row locks the account for 15 minutes.
When you enroll, AssessIQ shows 10 one-time recovery codes. Save them. If you
lose the authenticator and the codes, another admin must reset your enrollment.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.auth.mfa.enroll_vs_verify' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.auth.mfa.enroll_vs_verify', 'admin', 'en',
  'First-time admins enroll an authenticator app here; returning admins enter their 6-digit code to sign in.',
  $$## TOTP enrollment vs verification

The first time an admin signs in, AssessIQ shows a QR code and asks you to
scan it with an authenticator app (Google Authenticator, Authy, 1Password,
Microsoft Authenticator). After scanning, enter the 6-digit code shown in
the app to confirm the secret matches.

Returning admins skip the QR code and only enter the 6-digit code. Codes
rotate every 30 seconds; AssessIQ accepts the previous, current, and next
code to absorb small clock drifts.

Lockout policy: five wrong codes in a row locks the account for 15 minutes.
When you enroll, AssessIQ shows 10 one-time recovery codes. Save them. If you
lose the authenticator and the codes, another admin must reset your enrollment.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'admin = full access · reviewer = grade and override only · candidate = take assessments only.',
       long_md = $$## User roles

| Role | Can do |
|---|---|
| **admin** | Everything: tenant settings, packs, assessments, grading, exports, billing |
| **reviewer** | Grade and override AI verdicts; view assessment results; cannot edit packs or invite users |
| **candidate** | Take assigned assessments; view their own past scores |

Role changes take effect on the next sign-in for that user. Demoting an
admin to reviewer revokes their fresh-MFA gates immediately. There is no
"owner" or "billing" role.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.users.role' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.users.role', 'admin', 'en',
  'admin = full access · reviewer = grade and override only · candidate = take assessments only.',
  $$## User roles

| Role | Can do |
|---|---|
| **admin** | Everything: tenant settings, packs, assessments, grading, exports, billing |
| **reviewer** | Grade and override AI verdicts; view assessment results; cannot edit packs or invite users |
| **candidate** | Take assigned assessments; view their own past scores |

Role changes take effect on the next sign-in for that user. Demoting an
admin to reviewer revokes their fresh-MFA gates immediately. There is no
"owner" or "billing" role.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Bulk import accepts one JSON document. CSV import is planned. Convert spreadsheets to JSON first.',
       long_md = $$## Question import format

Bulk import accepts a single JSON document. In summary:

```jsonc
{
  "pack": "soc-analyst-v1",
  "level": "L2",
  "questions": [
    {
      "type": "mcq | kql | scenario | subjective",
      "body": "...",
      "answers": [...],          // shape varies by type
      "rubric": { ... },         // for subjective / scenario
      "tags": ["phishing", "triage"]
    }
  ]
}
```

CSV import is planned. Until then, convert spreadsheets to JSON with a
script of your choice.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.questions.import.format' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.questions.import.format', 'admin', 'en',
  'Bulk import accepts one JSON document. CSV import is planned. Convert spreadsheets to JSON first.',
  $$## Question import format

Bulk import accepts a single JSON document. In summary:

```jsonc
{
  "pack": "soc-analyst-v1",
  "level": "L2",
  "questions": [
    {
      "type": "mcq | kql | scenario | subjective",
      "body": "...",
      "answers": [...],          // shape varies by type
      "rubric": { ... },         // for subjective / scenario
      "tags": ["phishing", "triage"]
    }
  ]
}
```

CSV import is planned. Until then, convert spreadsheets to JSON with a
script of your choice.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Paste up to 500 emails (one per line). Existing users are linked; new users get a magic-link signup.',
       long_md = $$## Bulk invite

Paste up to 500 candidate emails — one per line. AssessIQ:

1. **De-duplicates** within the input list and against existing
   invitations on this assessment.
2. **Links existing users** by email. They receive a sign-in invitation
   only.
3. **Creates pending users** for new emails. They receive a magic-link
   sign-up + assessment invitation in one email.

**Rate-limited:** 500 emails per hour per tenant per admin. The UI shows
a progress bar; if you hit the limit, the remaining emails queue and send
over the next hour automatically.

**Email content:** every invitation uses the standard AssessIQ invitation
email. There is no screen to edit the email text.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.bulk' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.assessments.invite.bulk', 'admin', 'en',
  'Paste up to 500 emails (one per line). Existing users are linked; new users get a magic-link signup.',
  $$## Bulk invite

Paste up to 500 candidate emails — one per line. AssessIQ:

1. **De-duplicates** within the input list and against existing
   invitations on this assessment.
2. **Links existing users** by email. They receive a sign-in invitation
   only.
3. **Creates pending users** for new emails. They receive a magic-link
   sign-up + assessment invitation in one email.

**Rate-limited:** 500 emails per hour per tenant per admin. The UI shows
a progress bar; if you hit the limit, the remaining emails queue and send
over the next hour automatically.

**Email content:** every invitation uses the standard AssessIQ invitation
email. There is no screen to edit the email text.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Archetypes are statistical descriptors, not diagnostic labels. Use them to guide learning — not hiring decisions.',
       long_md = $$## Archetype disclaimer

AssessIQ archetypes are computed by an AI rubric engine that scores
reasoning quality on a 0–4 band scale. They are designed to identify
**learning gaps and strengths at scale**, not to serve as a definitive
measure of individual ability.

**Do not use archetypes as the sole basis for hiring, promotion, or
compensation decisions.** They are complementary signals to human
review, structured interviews, and on-the-job evaluation.

Archetype accuracy depends on:
- Question prompt quality (well-scoped rubric anchors improve band accuracy)
- Attempt length (short assessments yield less signal)
- How many questions are scored automatically and how many are written
  answers evaluated by AssessIQ

Results should be reviewed alongside raw scores and grading transcripts.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.reports.archetype.disclaimer' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.archetype.disclaimer', 'admin', 'en',
  'Archetypes are statistical descriptors, not diagnostic labels. Use them to guide learning — not hiring decisions.',
  $$## Archetype disclaimer

AssessIQ archetypes are computed by an AI rubric engine that scores
reasoning quality on a 0–4 band scale. They are designed to identify
**learning gaps and strengths at scale**, not to serve as a definitive
measure of individual ability.

**Do not use archetypes as the sole basis for hiring, promotion, or
compensation decisions.** They are complementary signals to human
review, structured interviews, and on-the-job evaluation.

Archetype accuracy depends on:
- Question prompt quality (well-scoped rubric anchors improve band accuracy)
- Attempt length (short assessments yield less signal)
- How many questions are scored automatically and how many are written
  answers evaluated by AssessIQ

Results should be reviewed alongside raw scores and grading transcripts.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Per-call grading cost is not shown. AssessIQ runs the evaluation, so no per-call cost is billed to you.',
       long_md = $$## Grading cost breakdown: not available

A per-call cost report is not available for your company. AssessIQ
evaluates written answers itself, and usage is counted in credits under
your plan tier.

See **Your plan and usage** on the Settings page for your credit usage.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.reports.cost.empty_in_claude_code_vps_mode' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.cost.empty_in_claude_code_vps_mode', 'admin', 'en',
  'Per-call grading cost is not shown. AssessIQ runs the evaluation, so no per-call cost is billed to you.',
  $$## Grading cost breakdown: not available

A per-call cost report is not available for your company. AssessIQ
evaluates written answers itself, and usage is counted in credits under
your plan tier.

See **Your plan and usage** on the Settings page for your credit usage.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Older audit rows are archived to cold storage. Lists archives and lets you restore rows into the live table.',
       long_md = $$## Archived audit log

To keep the live `audit_log` table fast, rows older than the retention
window are archived to cold storage (S3 in production). The **Archived
audit log** card at the bottom of `/admin/audit` lists available archives.

**Archive list columns:**

- **Date** — the date range covered by the archive file.
- **Rows** — how many audit log rows the archive contains.

**Restoring an archive:**

Click **Restore** on any archive row. A confirmation dialog shows the
row count and asks you to confirm before copying rows back into the live
`audit_log` table.

Restored rows are immediately visible in the main audit table. The archive
file itself is not deleted — the restore is additive only.

**Note:** archiving needs object storage to be set up. Without it, the
archives list is empty and a restore returns an error. This is expected in
a development setup.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.audit.archives' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.audit.archives', 'admin', 'en',
  'Older audit rows are archived to cold storage. Lists archives and lets you restore rows into the live table.',
  $$## Archived audit log

To keep the live `audit_log` table fast, rows older than the retention
window are archived to cold storage (S3 in production). The **Archived
audit log** card at the bottom of `/admin/audit` lists available archives.

**Archive list columns:**

- **Date** — the date range covered by the archive file.
- **Rows** — how many audit log rows the archive contains.

**Restoring an archive:**

Click **Restore** on any archive row. A confirmation dialog shows the
row count and asks you to confirm before copying rows back into the live
`audit_log` table.

Restored rows are immediately visible in the main audit table. The archive
file itself is not deleted — the restore is additive only.

**Note:** archiving needs object storage to be set up. Without it, the
archives list is empty and a restore returns an error. This is expected in
a development setup.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Archived assessments are soft-deleted. Contact your platform admin to restore. There is no self-service restore.',
       long_md = $$## Restoring archived assessments

Archiving an assessment sets its status to `archived` and hides it from
the active assessments list. The underlying data (attempts, gradings,
scores) is fully preserved.

**To restore** today:

1. Contact your AssessIQ platform administrator.
2. Provide the assessment ID (visible in the audit log entry for the
   archive action).
3. The admin updates `status = 'active'` and re-enables any active
   invite links.

**Grading data:** attempts submitted before archiving retain their scores
and archetype assignments. No re-grading is triggered on restore.

Self-service restore via the UI is planned for Phase 4.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.audit.archives.restore_procedure' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.audit.archives.restore_procedure', 'admin', 'en',
  'Archived assessments are soft-deleted. Contact your platform admin to restore. There is no self-service restore.',
  $$## Restoring archived assessments

Archiving an assessment sets its status to `archived` and hides it from
the active assessments list. The underlying data (attempts, gradings,
scores) is fully preserved.

**To restore** today:

1. Contact your AssessIQ platform administrator.
2. Provide the assessment ID (visible in the audit log entry for the
   archive action).
3. The admin updates `status = 'active'` and re-enables any active
   invite links.

**Grading data:** attempts submitted before archiving retain their scores
and archetype assignments. No re-grading is triggered on restore.

Self-service restore via the UI is planned for Phase 4.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Optional email domain for the tenant (e.g. company.com). Used for display — not enforced as a sign-in restriction.',
       long_md = $$## Tenant domain (optional)

Recording the company's email domain (e.g. `company.com`) is informational
only. It is stored with the company record and shown in the company list
for operator reference.

It does **not** currently restrict sign-in to that domain or auto-assign
users. Domain-based sign-in and auto-provisioning are planned for a
future release.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.domain' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.platform.domain', 'admin', 'en',
  'Optional email domain for the tenant (e.g. company.com). Used for display — not enforced as a sign-in restriction.',
  $$## Tenant domain (optional)

Recording the company's email domain (e.g. `company.com`) is informational
only. It is stored with the company record and shown in the company list
for operator reference.

It does **not** currently restrict sign-in to that domain or auto-assign
users. Domain-based sign-in and auto-provisioning are planned for a
future release.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'An admin signs in with Google or an emailed code at this address. Changing it transfers the login identity.',
       long_md = $$## Admin email — the login identity

AssessIQ resolves a signed-in admin to their account purely by their
verified email. The admin proves the email with Google sign-in or with a
one-time code sent to that address. The email field here is therefore the account's
**login identity**, not just a contact detail.

**Pending admin (invite not yet accepted).** Changing the email is safe:
the old invitation link is retired and a fresh one is sent to the new
address.

**Accepted admin.** Changing the email **transfers account ownership**. The
admin is signed out and can only sign back in with Google or an emailed
code at the new address. If they don't control that address they will be locked out; if
someone else controls it, that person gains access. Because of this, the
change requires an explicit confirmation checkbox.

Either way, the new email must not already belong to another user in the
same company.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.edit_admin.email' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.platform.edit_admin.email', 'admin', 'en',
  'An admin signs in with Google or an emailed code at this address. Changing it transfers the login identity.',
  $$## Admin email — the login identity

AssessIQ resolves a signed-in admin to their account purely by their
verified email. The admin proves the email with Google sign-in or with a
one-time code sent to that address. The email field here is therefore the account's
**login identity**, not just a contact detail.

**Pending admin (invite not yet accepted).** Changing the email is safe:
the old invitation link is retired and a fresh one is sent to the new
address.

**Accepted admin.** Changing the email **transfers account ownership**. The
admin is signed out and can only sign back in with Google or an emailed
code at the new address. If they don't control that address they will be locked out; if
someone else controls it, that person gains access. Because of this, the
change requires an explicit confirmation checkbox.

Either way, the new email must not already belong to another user in the
same company.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = '6-digit code from your authenticator app. Required before provisioning a new tenant (fresh-MFA gate).',
       long_md = $$## MFA step-up — authenticator code

Creating a new company tenant is a high-privilege operation gated behind
fresh TOTP verification (code must have been entered within the last 15
minutes).

If your session's MFA is stale, the create form switches to a step-up
prompt. Enter the current 6-digit code from your authenticator app
(Google Authenticator, Authy, 1Password, etc.) and click **Verify & create**.

On success the platform automatically retries the create operation — you
do not need to re-enter the form values.

**Lockout:** five wrong codes in a row locks the account for 15 minutes.
Wait for the lockout to expire before retrying.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.mfa_code' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.platform.mfa_code', 'admin', 'en',
  '6-digit code from your authenticator app. Required before provisioning a new tenant (fresh-MFA gate).',
  $$## MFA step-up — authenticator code

Creating a new company tenant is a high-privilege operation gated behind
fresh TOTP verification (code must have been entered within the last 15
minutes).

If your session's MFA is stale, the create form switches to a step-up
prompt. Enter the current 6-digit code from your authenticator app
(Google Authenticator, Authy, 1Password, etc.) and click **Verify & create**.

On success the platform automatically retries the create operation — you
do not need to re-enter the form values.

**Lockout:** five wrong codes in a row locks the account for 15 minutes.
Wait for the lockout to expire before retrying.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'In-app notifications are fetched every 15 seconds. There is no live push yet.',
       long_md = $$## In-app notification polling

The admin dashboard polls for new in-app notifications every **15 seconds**
using a short-poll strategy. Notifications include:

- Grading complete (an attempt's AI grading finished)
- Bulk invite batch complete (all emails sent)
- Assessment boundary transitions (e.g. attempt timer expired)

**Why short-poll?** AssessIQ does not run a live-push server yet. Short
polling over HTTPS is simpler to operate and sufficient for the current
notification volume.

Live push will be considered when real-time status updates become
time-critical.

If a notification arrives between polls, it will appear at the next tick.
The 15-second window is intentional — it avoids overloading the DB with
sub-second polling while keeping the perceived lag minimal for admin-level
workflows.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.notifications.in_app.short_poll_interval' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.notifications.in_app.short_poll_interval', 'admin', 'en',
  'In-app notifications are fetched every 15 seconds. There is no live push yet.',
  $$## In-app notification polling

The admin dashboard polls for new in-app notifications every **15 seconds**
using a short-poll strategy. Notifications include:

- Grading complete (an attempt's AI grading finished)
- Bulk invite batch complete (all emails sent)
- Assessment boundary transitions (e.g. attempt timer expired)

**Why short-poll?** AssessIQ does not run a live-push server yet. Short
polling over HTTPS is simpler to operate and sufficient for the current
notification volume.

Live push will be considered when real-time status updates become
time-critical.

If a notification arrives between polls, it will appear at the next tick.
The 15-second window is intentional — it avoids overloading the DB with
sub-second polling while keeping the perceived lag minimal for admin-level
workflows.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'The AI''s free-text reasoning for its band choice. Read before accepting or overriding.',
       long_md = $$## AI justification

The AI grader writes a short explanation of why it chose the verdict it did.
Read this before clicking Accept — it surfaces the evidence and reasoning
that drove the band choice.

If the justification is vague ("the answer is mostly correct"), that is a
signal to ask for a re-run before accepting.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.proposal.justification' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.proposal.justification', 'admin', 'en',
  'The AI''s free-text reasoning for its band choice. Read before accepting or overriding.',
  $$## AI justification

The AI grader writes a short explanation of why it chose the verdict it did.
Read this before clicking Accept — it surfaces the evidence and reasoning
that drove the band choice.

If the justification is vague ("the answer is mostly correct"), that is a
signal to ask for a re-run before accepting.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'A second check gave a different result by 2 or more bands. Pick the verdict to keep.',
       long_md = $$## Second check

On some answers AssessIQ's evaluation runs a second check that grades the
answer independently. If the two results differ by 2 or more bands, they
appear side by side.

You must pick one verdict and write a reconciliation note before
submitting. AssessIQ records which check you chose, so later analysis can
find systematic disagreements.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.proposal.escalation' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.proposal.escalation', 'admin', 'en',
  'A second check gave a different result by 2 or more bands. Pick the verdict to keep.',
  $$## Second check

On some answers AssessIQ's evaluation runs a second check that grades the
answer independently. If the two results differ by 2 or more bands, they
appear side by side.

You must pick one verdict and write a reconciliation note before
submitting. AssessIQ records which check you chose, so later analysis can
find systematic disagreements.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Accept saves the AI''s proposal as the final grade. No fresh MFA required.',
       long_md = $$## Accept AI proposal

Clicking Accept:

1. Saves the AI's band, score, anchor hits, and justification as the final
   grade for the answer.
2. Does **not** release the attempt to the candidate on its own. When you
   accept the last missing grade, the attempt is released to its company.

Accept does not require fresh MFA. Override does.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.accept' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.accept', 'admin', 'en',
  'Accept saves the AI''s proposal as the final grade. No fresh MFA required.',
  $$## Accept AI proposal

Clicking Accept:

1. Saves the AI's band, score, anchor hits, and justification as the final
   grade for the answer.
2. Does **not** release the attempt to the candidate on its own. When you
   accept the last missing grade, the attempt is released to its company.

Accept does not require fresh MFA. Override does.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Re-run grades this answer again. Use it for complex cases or appeals. AssessIQ evaluators only.',
       long_md = $$## Re-run

**Re-run** asks the evaluation to grade this answer again. Only AssessIQ
evaluators can start it. Company admins cannot.

Use it for:

- Complex multi-step scenario answers where the first result looks shallow.
- Appeals: the candidate disputes the grade and you want an independent
  re-assessment.
- Calibration: a spot-check of whether earlier results hold up on a sample
  of high-stakes attempts.

A re-run result waits for you to accept it or override it. The earlier
grade stays in place until you decide.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.grading.rerun.opus' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.grading.rerun.opus', 'admin', 'en',
  'Re-run grades this answer again. Use it for complex cases or appeals. AssessIQ evaluators only.',
  $$## Re-run

**Re-run** asks the evaluation to grade this answer again. Only AssessIQ
evaluators can start it. Company admins cannot.

Use it for:

- Complex multi-step scenario answers where the first result looks shallow.
- Appeals: the candidate disputes the grade and you want an independent
  re-assessment.
- Calibration: a spot-check of whether earlier results hold up on a sample
  of high-stakes attempts.

A re-run result waits for you to accept it or override it. The earlier
grade stays in place until you decide.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Sum of earned points across all questions, normalized to 100. Bands are shown per-question only.',
       long_md = $$## Total score

The attempt total is a weighted sum of per-question scores, normalized to
100. It is calculated once all questions are graded.

For subjective questions, the per-question score is `reasoning_band × 25`,
so a band-3 answer on a 20-point question contributes 15 points.

The total does **not** drive pass/fail thresholds directly — the archetype
and cohort percentile are also factors. See `admin.scoring.cohort.percentiles`.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.scoring.attempt.total' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.scoring.attempt.total', 'admin', 'en',
  'Sum of earned points across all questions, normalized to 100. Bands are shown per-question only.',
  $$## Total score

The attempt total is a weighted sum of per-question scores, normalized to
100. It is calculated once all questions are graded.

For subjective questions, the per-question score is `reasoning_band × 25`,
so a band-3 answer on a 20-point question contributes 15 points.

The total does **not** drive pass/fail thresholds directly — the archetype
and cohort percentile are also factors. See `admin.scoring.cohort.percentiles`.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Rank within the cohort. 90th percentile = scored higher than 90% of candidates on the same assessment.',
       long_md = $$## Cohort percentiles

Cohort percentiles are computed once the cohort has ≥5 released results.
They are recomputed on every new release.

A candidate at the 90th percentile scored higher than 90% of the cohort
on the same assessment + level. Percentiles are assessment-scoped — they
do not span across assessments or levels.

The report shows the median and percentile bands (P25, P50, P75, P90).
Full bell-curve distribution charts are planned.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.scoring.cohort.percentiles' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.scoring.cohort.percentiles', 'admin', 'en',
  'Rank within the cohort. 90th percentile = scored higher than 90% of candidates on the same assessment.',
  $$## Cohort percentiles

Cohort percentiles are computed once the cohort has ≥5 released results.
They are recomputed on every new release.

A candidate at the 90th percentile scored higher than 90% of the cohort
on the same assessment + level. Percentiles are assessment-scoped — they
do not span across assessments or levels.

The report shows the median and percentile bands (P25, P50, P75, P90).
Full bell-curve distribution charts are planned.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Questions about your plan? Contact your AssessIQ administrator. No limit blocks inviting or publishing.',
       long_md = $$## Questions about your plan

Your company is on a plan tier. Usage is counted in credits. See **Your
plan and usage** on this page for the numbers.

- AssessIQ evaluates written answers. You do not start evaluation yourself.
- No limit blocks you from inviting candidates or publishing results.
- To check your plan tier or discuss changes, contact your AssessIQ
  administrator. Use the email address in your onboarding documents.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.settings.billing.budget' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.billing.budget', 'admin', 'en',
  'Questions about your plan? Contact your AssessIQ administrator. No limit blocks inviting or publishing.',
  $$## Questions about your plan

Your company is on a plan tier. Usage is counted in credits. See **Your
plan and usage** on this page for the numbers.

- AssessIQ evaluates written answers. You do not start evaluation yourself.
- No limit blocks you from inviting candidates or publishing results.
- To check your plan tier or discuss changes, contact your AssessIQ
  administrator. Use the email address in your onboarding documents.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'A usage banner shows at 80% of your included credits. It is information only and never blocks you.',
       long_md = $$## Usage banner threshold

When your credit usage reaches 80% of the credits included in your plan, a
banner appears at the top of your dashboard. It is informational only.
Inviting, submitting, grading and publishing keep working, even when you
use more than your included credits.

To change your plan, contact your AssessIQ administrator.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.settings.billing.alert_threshold' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.billing.alert_threshold', 'admin', 'en',
  'A usage banner shows at 80% of your included credits. It is information only and never blocks you.',
  $$## Usage banner threshold

When your credit usage reaches 80% of the credits included in your plan, a
banner appears at the top of your dashboard. It is informational only.
Inviting, submitting, grading and publishing keep working, even when you
use more than your included credits.

To change your plan, contact your AssessIQ administrator.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Help text supports Markdown. The editor preview shows plain text only. Readers see full rendering.',
       long_md = $$## Help content Markdown

Help text bodies accept GitHub-flavored Markdown: headings, bold, italic,
code blocks, ordered/unordered lists, and tables.

The editor shows a **plain-text preview** only. Full Markdown rendering in
the editor is planned. Candidates and admins who read the help drawer see
rendered Markdown.

**What to avoid:**
- Raw HTML tags — they are stripped before storage.
- Inline images — not supported in this phase.
- Custom CSS classes — the design system renders Markdown in a sandboxed
  `aiq-prose` container with fixed styles.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.settings.help_content.markdown' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.help_content.markdown', 'admin', 'en',
  'Help text supports Markdown. The editor preview shows plain text only. Readers see full rendering.',
  $$## Help content Markdown

Help text bodies accept GitHub-flavored Markdown: headings, bold, italic,
code blocks, ordered/unordered lists, and tables.

The editor shows a **plain-text preview** only. Full Markdown rendering in
the editor is planned. Candidates and admins who read the help drawer see
rendered Markdown.

**What to avoid:**
- Raw HTML tags — they are stripped before storage.
- Inline images — not supported in this phase.
- Custom CSS classes — the design system renders Markdown in a sandboxed
  `aiq-prose` container with fixed styles.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Question generation mode: omnibus = single prompt; sharded = one prompt per question type. Effective on next request.',
       long_md = $$## Generation mode

Controls how AI question generation works for this company.

| Value | Meaning |
|---|---|
| **Use global default** | Inherits the platform-wide setting (currently omnibus). Choose this to undo a company-specific override. |
| **omnibus** | All questions are generated in a single AI prompt. Lower latency but no per-type quality tuning. |
| **sharded** | Questions are generated in separate per-type prompts (one each for mcq, log_analysis, scenario, kql, subjective). Higher fidelity; slightly longer wall-clock time. |

**Rollout:** sharded is the target default. Until the quality checks pass
consistently, the global default stays omnibus and companies move to
sharded one at a time as a quality pilot.

**Audit trail:** every change to this setting is recorded in the audit log
with the before value, the after value and the person who made the change.

**Need a change without the screen?** Ask the AssessIQ engineering team.
The change takes effect on the next generation request.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.settings.ai_generate_mode' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.settings.ai_generate_mode', 'admin', 'en',
  'Question generation mode: omnibus = single prompt; sharded = one prompt per question type. Effective on next request.',
  $$## Generation mode

Controls how AI question generation works for this company.

| Value | Meaning |
|---|---|
| **Use global default** | Inherits the platform-wide setting (currently omnibus). Choose this to undo a company-specific override. |
| **omnibus** | All questions are generated in a single AI prompt. Lower latency but no per-type quality tuning. |
| **sharded** | Questions are generated in separate per-type prompts (one each for mcq, log_analysis, scenario, kql, subjective). Higher fidelity; slightly longer wall-clock time. |

**Rollout:** sharded is the target default. Until the quality checks pass
consistently, the global default stays omnibus and companies move to
sharded one at a time as a quality pilot.

**Audit trail:** every change to this setting is recorded in the audit log
with the before value, the after value and the person who made the change.

**Need a change without the screen?** Ask the AssessIQ engineering team.
The change takes effect on the next generation request.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Control how many questions to generate per type. Auto-weighted defaults come from L1/L2/L3 weight tables.',
       long_md = $$## Generate questions modal — per-type distribution

The Generate modal shows a **per-type chip row** alongside the total count
input. Each chip (MCQ, KQL, Scenario, Subjective) shows the auto-weighted
count calculated from the pack's L1/L2/L3 weight table.

**Using per-type overrides:**

- Click a chip to open the per-type count spinner.
- Adjust the count for each type. The total across types must equal the
  requested count — a running-sum indicator validates this in real time.
- Click **Reset** to restore the auto-weighted defaults.

**Subjective handling:**

- In **omnibus mode**, subjective questions fold into the MCQ quota and
  use the same generation call.
- In **sharded mode**, subjective is its own generation call
  with a separate `generate-rubric` skill pass before insert.

### Notes

- The 1–30 cap applies to the total, not per type.
- Overrides are one-time — they reset on the next modal open.
- Parallel chunking (1–10 / 11–20 / 21–30) and the 5-minute prompt
  cache window still apply; see `admin.questions.generate.draft` for
  timing details.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.questions.generate.modal' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.questions.generate.modal', 'admin', 'en',
  'Control how many questions to generate per type. Auto-weighted defaults come from L1/L2/L3 weight tables.',
  $$## Generate questions modal — per-type distribution

The Generate modal shows a **per-type chip row** alongside the total count
input. Each chip (MCQ, KQL, Scenario, Subjective) shows the auto-weighted
count calculated from the pack's L1/L2/L3 weight table.

**Using per-type overrides:**

- Click a chip to open the per-type count spinner.
- Adjust the count for each type. The total across types must equal the
  requested count — a running-sum indicator validates this in real time.
- Click **Reset** to restore the auto-weighted defaults.

**Subjective handling:**

- In **omnibus mode**, subjective questions fold into the MCQ quota and
  use the same generation call.
- In **sharded mode**, subjective is its own generation call
  with a separate `generate-rubric` skill pass before insert.

### Notes

- The 1–30 cap applies to the total, not per type.
- Overrides are one-time — they reset on the next modal open.
- Parallel chunking (1–10 / 11–20 / 21–30) and the 5-minute prompt
  cache window still apply; see `admin.questions.generate.draft` for
  timing details.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Open-ended written-reasoning questions scored via AI rubric. Rubric is generated separately; admin must activate.',
       long_md = $$## Subjective questions

Subjective questions present a freeform prompt to candidates, who type a
written response. There are no multiple-choice options, no expected syntax,
and no keyword hints. Scoring is AI-driven against rubric anchors.

**Authoring flow:**

1. Generate (or import) a subjective question — it enters `ai_draft`.
2. Open the draft in the question editor.
3. Review or edit the rubric anchors (auto-generated via the
   `generate-rubric` skill during generation in sharded mode).
4. Activate the question to add it to the pool.

**Candidate experience:**

- Sees the prompt and a freeform text area.
- No syntax hints or expected-keyword display.
- Response length is unconstrained within the attempt time limit.

**Grading:** AssessIQ's evaluation scores the written response against the
rubric anchors. The evaluator can re-run or override the result.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.questions.subjective' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.questions.subjective', 'admin', 'en',
  'Open-ended written-reasoning questions scored via AI rubric. Rubric is generated separately; admin must activate.',
  $$## Subjective questions

Subjective questions present a freeform prompt to candidates, who type a
written response. There are no multiple-choice options, no expected syntax,
and no keyword hints. Scoring is AI-driven against rubric anchors.

**Authoring flow:**

1. Generate (or import) a subjective question — it enters `ai_draft`.
2. Open the draft in the question editor.
3. Review or edit the rubric anchors (auto-generated via the
   `generate-rubric` skill during generation in sharded mode).
4. Activate the question to add it to the pool.

**Candidate experience:**

- Sees the prompt and a freeform text area.
- No syntax hints or expected-keyword display.
- Response length is unconstrained within the attempt time limit.

**Grading:** AssessIQ's evaluation scores the written response against the
rubric anchors. The evaluator can re-run or override the result.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Revoke marks the certificate revoked and blocks the PDF. The reason shows on the public verify page.',
       long_md = $$## Revoking a certificate

Revocation is a **soft delete** — the credential record is preserved and
the verify page still loads, but displays a red "Revoked" badge instead of
a green verification check.

**Effects of revocation:**

- Public verify page (`/verify/<credential_id>`) shows red badge + revoke reason
- PDF download returns 410 Gone
- Share buttons are disabled in the candidate's "My Certificates" view
- The revoke action is recorded in the audit log (who and when). The
  reason text is kept on the certificate, not copied into the log.

**The reason field is required** (10–500 characters). It appears on the
public verify page, so write it as a professional explanation that a
recruiter might read: e.g., "Certificate issued in error — assessment was
invalidated." rather than internal jargon.

**Revocation is irreversible.** A revoked certificate cannot be reissued.
If the candidate earns the credential again, AssessIQ issues a new
certificate. Revocations are logged in the audit trail with the acting
admin's identity.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.certificates.revoke' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.certificates.revoke', 'admin', 'en',
  'Revoke marks the certificate revoked and blocks the PDF. The reason shows on the public verify page.',
  $$## Revoking a certificate

Revocation is a **soft delete** — the credential record is preserved and
the verify page still loads, but displays a red "Revoked" badge instead of
a green verification check.

**Effects of revocation:**

- Public verify page (`/verify/<credential_id>`) shows red badge + revoke reason
- PDF download returns 410 Gone
- Share buttons are disabled in the candidate's "My Certificates" view
- The revoke action is recorded in the audit log (who and when). The
  reason text is kept on the certificate, not copied into the log.

**The reason field is required** (10–500 characters). It appears on the
public verify page, so write it as a professional explanation that a
recruiter might read: e.g., "Certificate issued in error — assessment was
invalidated." rather than internal jargon.

**Revocation is irreversible.** A revoked certificate cannot be reissued.
If the candidate earns the credential again, AssessIQ issues a new
certificate. Revocations are logged in the audit trail with the acting
admin's identity.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Explain why this certificate is being revoked.',
       long_md = $$## Revoke reason

Explain why this certificate is being revoked. This reason is stored with
the certificate record. You must write 10 to 500 characters.

The reason is visible to admins in the certificate list and on the public
verify page (so verifiers know the credential is no longer valid). The audit
log records that you revoked the certificate and when. It does **not** copy
the reason text, to avoid storing potentially sensitive text in an
append-only log.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.certificates.revoke_reason' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.certificates.revoke_reason', 'admin', 'en',
  'Explain why this certificate is being revoked.',
  $$## Revoke reason

Explain why this certificate is being revoked. This reason is stored with
the certificate record. You must write 10 to 500 characters.

The reason is visible to admins in the certificate list and on the public
verify page (so verifiers know the credential is no longer valid). The audit
log records that you revoked the certificate and when. It does **not** copy
the reason text, to avoid storing potentially sensitive text in an
append-only log.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Confirm it is you, taking the test alone, and agree to the Terms and Privacy Policy before you begin.',
       long_md = $$## Consent and AI-use notice

Before the timer starts we ask you to confirm that you are the person
invited, that you will take the test on your own, and that you agree to the
Terms and Privacy Policy. Your results may be shared with the company that
invited you. We record when you agreed.

**How answers are scored:** multiple-choice answers are scored
automatically. Written answers, if any, are evaluated by AssessIQ
evaluators with AI assistance, before the company that invited you
releases the results.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'candidate.intro.consent' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.intro.consent', 'candidate', 'en',
  'Confirm it is you, taking the test alone, and agree to the Terms and Privacy Policy before you begin.',
  $$## Consent and AI-use notice

Before the timer starts we ask you to confirm that you are the person
invited, that you will take the test on your own, and that you agree to the
Terms and Privacy Policy. Your results may be shared with the company that
invited you. We record when you agreed.

**How answers are scored:** multiple-choice answers are scored
automatically. Written answers, if any, are evaluated by AssessIQ
evaluators with AI assistance, before the company that invited you
releases the results.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

UPDATE help_content
   SET short_text = 'Type your KQL query in this box. It is saved as you work and scored later by an AssessIQ evaluator.',
       long_md = $$## KQL answer box

This is a plain text box. Type or paste your KQL query. There is no syntax
highlighting, autocomplete or automatic check in this box.

- Your query is saved as you work.
- Your query is not run against real data.
- Your query is not scored automatically. An AssessIQ evaluator reads and
  scores it.
$$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'candidate.attempt.kql.editor' AND locale = 'en' AND version = 1;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'candidate.attempt.kql.editor', 'candidate', 'en',
  'Type your KQL query in this box. It is saved as you work and scored later by an AssessIQ evaluator.',
  $$## KQL answer box

This is a plain text box. Type or paste your KQL query. There is no syntax
highlighting, autocomplete or automatic check in this box.

- Your query is saved as you work.
- Your query is not run against real data.
- Your query is not scored automatically. An AssessIQ evaluator reads and
  scores it.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.release_confirm', 'admin', 'en',
  'Publish this result to the candidate and email them. Published results can''t be changed.',
  $$## Confirm publish

This window shows a summary of the scores so you can check them before you
publish.

- **Publish to candidate** shows the candidate their final result and emails
  them.
- A certificate is issued if the candidate qualifies.
- Published results are final. Scores can no longer be overridden.
- Questions that are flagged for review have no committed grade. The
  published result shows only the questions that have final grades.
- Choose **Cancel** to go back without publishing.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.print_review', 'admin', 'en',
  'Print this review, or save it as a PDF, with each answer, its grade and the reasons.',
  $$## Print review

**Print review** opens your browser's print window with a print-friendly
version of this page. Choose a printer, or choose "Save as PDF" to keep a
copy.

- The button appears when the attempt has at least one grade.
- Buttons and menus are left out of the printed page.
- The print includes only what you can see on this screen. Check the
  candidate details before you share it, because it can contain personal
  data.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.grading_in_progress', 'admin', 'en',
  'Grading is running now. The page checks every 15 seconds and shows the grades when they are ready.',
  $$## Grading in progress

The banner shows that AssessIQ is grading the written answers of this
attempt now.

- The page checks for new grades every 15 seconds. The banner goes away on
  its own.
- You can leave this page. The grades are here when you return.
- **Check now** looks for new grades at once.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.grading_stalled', 'admin', 'en',
  'A grading run did not finish. Use Re-grade to start it again.',
  $$## Grading looks stalled

A grading run started some time ago and did not finish. This can happen
when AssessIQ restarts while a run is in progress.

1. Choose **Re-grade** at the top of the page.
2. Wait for the grades to appear.

Answers that were already graded keep their grades.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.grading_summary', 'admin', 'en',
  'How far this attempt has progressed, with one label for each question.',
  $$## Grading summary

- **Graded** shows how many questions have a final grade, out of all
  questions in the attempt.
- **Score** shows the points earned so far, out of the maximum.
- Each question has its own label. **Needs review** means the AI could not
  give a safe grade, so a person must score it. **Re-run ready** means a new
  result waits for you to accept or override it.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.activity.feed', 'admin', 'en',
  'A live list of what admins and candidates did in your workspace. Filter by role.',
  $$## Activity feed

The feed lists recent actions across your workspace, newest first.

- Use the role buttons (**All**, **Admin**, **Reviewer**, **Candidate**) to
  show one group of people.
- The feed shows 20 items at a time. Choose **Load more** to see older
  items.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.list.page', 'admin', 'en',
  'All candidate submissions across your assessments, with status filters.',
  $$## Attempts

This page lists every candidate attempt for your company.

- Use the status tabs (**All**, **Submitted**, **Pending grading**,
  **Graded**, **Released**) to narrow the list.
- Select a column heading to sort.
- Open an attempt to see each answer, its grade and the reasons, and to
  publish the result.

Written answers are evaluated by AssessIQ. A result becomes **Ready to
publish** after the evaluation is released to you.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.dashboard.home.page', 'admin', 'en',
  'Your starting page: results waiting for you and a shortcut to create an assessment.',
  $$## Dashboard

- **In queue**, **Awaiting evaluation** and **Ready to publish** count the
  attempts in your results queue.
- **Results queue** lists the attempts. Open one to review and publish it.
- **Refresh** loads the latest numbers. **New assessment** opens the
  assessments page.
- A usage banner appears at the top when your credit usage is notable. It
  never blocks you.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.users.list.page', 'admin', 'en',
  'Everyone in your company: invite people, filter by role and manage access.',
  $$## Users

This page lists the people in your company.

- Use **Invite user** to add a person. An invitation email is sent.
- Use the role filters and the search box to find a person.
- Use the toggles to show disabled or removed users.
- For a candidate, you can export that person's data from their row.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.queue.page', 'admin', 'en',
  'AssessIQ''s work list of written answers to evaluate, oldest first.',
  $$## Evaluations

This page is the work list for AssessIQ evaluators. Each row is one attempt
that has written answers and has not been released back to its company.

- Work from the top. **Evaluate next** opens the oldest row.
- You see the company, assessment and level, not the candidate's name.
- When you accept the last grade of an attempt, it is released to its
  company.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
