-- 0154_help_text_no_reviewer_role.sql
--
-- RV60: the reviewer role is removed from the product (owner decision 2026-10-02).
-- Company admins review and publish results. These rows described the role.
-- Text only. No row is added or removed. Safe to re-run.

UPDATE help_content
   SET short_text = $aiq$admin = full access · candidate = take assessments only.$aiq$,
       long_md = $aiq$## User roles

| Role | Can do |
|---|---|
| **admin** | Everything: tenant settings, packs, assessments, grading, exports, billing |
| **candidate** | Take assigned assessments; view their own past scores |

Role changes take effect on the next sign-in for that user. There is no
"owner", "billing" or "reviewer" role: admins review and publish results.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.users.role' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$Platform operator control centre. Add companies and see every company on AssessIQ. Company admins never see this page.$aiq$,
       long_md = $aiq$## What you can do here

You are signed in as a **platform operator** — the person who runs
AssessIQ for every company. This page is your control centre.

**Add a new company.**
Click **Create company**, then fill in three things:

- the company's name,
- a short web-friendly name for it (the "slug" — lowercase letters,
  numbers and hyphens; it is suggested for you from the name),
- the email address of the person who will be that company's first
  administrator.

AssessIQ then sets the company up and emails that person an invitation
to sign in and take over their company. You do not manage the company's
day-to-day work — its own administrator does that.

**See every company.**
The list below shows each company, its short name, whether it is active,
and the date it was added.

## Good to know

- **Only you see this.** Company administrators never see
  the Platform page or this company list. Each company only ever sees
  its own data, never another company's.
- **Extra sign-in check.** When you create a company, AssessIQ may ask
  for the 6-digit code from your authenticator app if it has been a
  while since you signed in. Just enter the code if prompted — anything
  you have already typed in the form is kept.
- **What happens when you add a company.** AssessIQ creates the company,
  prepares its question categories, emails the first administrator, and
  switches the company on. If anything goes wrong partway through, the
  company is left switched off and you see an error — so a half-finished
  company is never live.
- **What you cannot do from here.** This page does not let you log in as
  a company, change a company's questions or candidates, or remove a
  company. Those are deliberately separate; ask for them if you need them.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$Email address of the company's first admin. An invitation link (valid 7 days) is sent here on provisioning.$aiq$,
       long_md = $aiq$## First-admin email

The email address entered here receives a one-time invitation link
immediately after the tenant is provisioned. The link is valid for 7 days.

The invited user signs in via the link and is granted `role = admin` for
the new tenant. They can then invite additional admins from
the Users page.

If the invitation expires before the admin accepts it, a platform operator
can re-provision or manually re-invite via the API.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.admin_email' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$Update the company's primary admin — name or email. Requires fresh MFA.$aiq$,
       long_md = $aiq$## Edit admin

Update the company's primary-contact admin without re-provisioning the
tenant. You can change their display name and correct or change their email.

**Email is the login identity** — see the email field's own help for the
consequences of changing it.

This is a platform-operator action gated by fresh MFA (a TOTP code entered
within the last 15 minutes); you may be prompted to re-enter your
authenticator code. Every change is recorded in the audit log.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.platform.edit_admin' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$Anonymize toggle hides candidate emails. Leaderboard data is admin-only and never shown to candidates.$aiq$,
       long_md = $aiq$## Leaderboard privacy

The cohort leaderboard is visible to admins only — candidates
never see their rank or peers' scores.

Use the **Anonymize** toggle to hide email addresses when screensharing
or presenting cohort results to stakeholders. The setting is stored in your
browser session only (not tenant-wide).
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.scoring.leaderboard.privacy' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$What happened to each row: created, already existing, invited, or skipped (with the reason).$aiq$,
       long_md = $aiq$## Import result

- **Created** — new candidate accounts added to your company.
- **Existing** — the email was already a candidate here, so it was reused.
- **Invited** — invitation emails queued for this assessment.
- **Skipped** — rows that were not imported or not invited. Each shows the
  row number (the header is row 1), the email and the reason, for example
  an invalid email, a missing name, a repeated email in the file, an email
  that belongs to a non-candidate (an admin), or a candidate who
  already has an invitation for this assessment.

Use **Download skipped rows** to get a CSV you can correct and upload again.
If you see an email-volume warning, some invitations may arrive later than
usual because the email plan has a shared daily limit.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.import_result' AND locale = 'en';

UPDATE help_content
   SET short_text = $aiq$A live list of what admins and candidates did in your workspace. Filter by role.$aiq$,
       long_md = $aiq$## Activity feed

The feed lists recent actions across your workspace, newest first.

- Use the role buttons (**All**, **Admin**, **Candidate**) to
  show one group of people.
- The feed shows 20 items at a time. Choose **Load more** to see older
  items.
$aiq$,
       updated_at = now()
 WHERE tenant_id IS NULL AND key = 'admin.activity.feed' AND locale = 'en';
