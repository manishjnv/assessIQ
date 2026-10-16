-- 0177_rw87_help_copy_pass_2.sql
--
-- RW-87 pass 2 (2026-10-16): long sentences split to the STE limit (25 words), British "colour",
-- no contractions. The seed is ON CONFLICT DO NOTHING, so each changed key carries a new version row
-- in content/en/{admin,candidate}.yml.
-- BUMP admin.activity.heatmap.legend (v2)
-- BUMP admin.activity.leaderboard.delta (v2)
-- BUMP admin.activity.streak.explanation (v2)
-- BUMP admin.assessment.reminders (v2)
-- BUMP admin.assessments.invitations.resend_result (v2)
-- BUMP admin.assessments.invite.import_result (v2)
-- BUMP admin.assessments.list.content_source (v2)
-- BUMP admin.assessments.results.download_csv (v2)
-- BUMP admin.auth.login.tenant_slug (v3)
-- BUMP admin.auth.mfa.enroll_vs_verify (v3)
-- BUMP admin.certificates.revoke (v3)
-- BUMP admin.evaluations.accept_all (v2)
-- BUMP admin.evaluations.manual_score (v2)
-- BUMP admin.gen_score.structural (v2)
-- BUMP admin.platform (v3)
-- BUMP admin.platform.billing (v3)
-- BUMP admin.platform.edit_admin (v2)
-- BUMP admin.platform.entitlements (v2)
-- BUMP admin.question_bank.list.create.domain (v3)
-- BUMP admin.question_bank.pack.activate_drafts (v2)
-- BUMP admin.question_bank.pack.attempt_status (v2)
-- BUMP admin.question_bank.pack.publish (v2)
-- BUMP admin.questions.generate.draft (v3)
-- BUMP admin.questions.type.kql.expected_keywords (v2)
-- BUMP admin.reports.cohort.heatmap (v2)
-- BUMP admin.reports.heatmap.colors (v2)
-- BUMP admin.reports.individual.open_attempt (v2)
-- BUMP admin.rubric.anchor.required (v2)
-- BUMP admin.settings.billing.ai_generate_mode (v2)
-- BUMP admin.shell.nav.mobile_menu (v2)
-- BUMP admin.users.list.candidate.fields (v3)
-- BUMP admin.webhooks.replay (v2)
-- BUMP candidate.activity (v3)
-- BUMP candidate.attempt.flag (v3)
-- BUMP candidate.attempt.kql.mobile_tip (v3)
-- BUMP candidate.attempt.navigator.toggle (v2)
-- BUMP candidate.auth.session_status (v2)
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.activity.heatmap.legend',
  'admin',
  'en',
  'Heatmap colour bands — from no activity (lightest) to highest activity (darkest indigo).',
  $$## Heatmap intensity bands

Each cell represents one day. The five intensity levels are:

| Score band | Count |
|---|---|
| 0 (empty) | No submitted attempts that day |
| 1 (light) | 1–2 submitted attempts |
| 2 | 3–5 submitted attempts |
| 3 | 6–10 submitted attempts |
| 4 (dark) | 11 or more submitted attempts |

Counts reflect completed (submitted/graded/released) attempts in your organisation only.
The heatmap always shows the rolling 52-week window that ends today. It does not respond to the period toggle, which controls the stat cards and leaderboard.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.activity.leaderboard.delta',
  'admin',
  'en',
  'Delta % compares submitted attempts this period to the prior period of equal length; null for a new question set.',
  $$## Leaderboard delta

Each leaderboard row shows a **delta** between the current period and the
immediately preceding period of equal length:

- **Week:** current 7 days vs prior 7 days
- **Month:** current 30 days vs prior 30 days
- **Quarter:** current 90 days vs prior 90 days

The delta is `((current − prior) / prior) × 100`, rounded to one decimal place.

**Direction indicators:**
- ↑ Up — delta > +0.5%
- ↓ Down — delta < −0.5%
- Flat — delta within ±0.5% (small noise suppression)

**Null delta** shows when the question set had zero submitted attempts in the prior period but has submitted attempts in the current period. It is a new entry with no baseline to compare.

The leaderboard groups by question set (catalog-wide rollup), so a question set with
multiple active assessment cycles appears as one row.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.activity.streak.explanation',
  'admin',
  'en',
  'Current streak counts consecutive days with at least one submitted attempt; longest streak is the all-time best.',
  $$## Streak calculation

**Current streak** — the number of consecutive calendar days (ending today or
yesterday) on which at least one assessment was submitted. A day with zero
submitted attempts resets the streak to 0.

**Longest streak** — the longest unbroken run of active days in the 365-day
window queried by the heatmap endpoint. If today has no submitted attempts yet, the current streak may be shorter than yesterday's value. It updates when AssessIQ records the first submitted attempt of the day.

AssessIQ computes streaks in TypeScript from the daily bucket data. It uses no SQL window functions. Streaks reflect the live `attempts` table with same-day precision.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessment.reminders',
  'admin',
  'en',
  'Automatically email a reminder to students who have not started this assessment.',
  $$## Automatic reminders

Tick **Send automatic reminders**, choose how many hours before the deadline,
then press **Save reminder settings**. It is **off by default**.

- **Who gets one:** students who were invited but have not started. Each invitation gets one reminder. It is sent within the hours you chose before the invitation expires or the assessment closes, whichever is sooner.
- **The link in the reminder replaces the earlier one.** The deadline does
  not move; a reminder never extends anything.
- **Sent in the background**, roughly every 30 minutes, after the invitation
  email has had at least 6 hours.
- **Limit:** the platform sends at most 100 reminders in any 24 hours, because
  the email provider has a daily cap. Sign-in codes and invitations always go first.
- The invitations list shows **Reminder sent** for students who got one.
  Resending an invitation gives that student a fresh reminder later.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.invitations.resend_result',
  'admin',
  'en',
  'How many invitations were resent, how many were skipped (and why), and how many are still to send.',
  $$## Resend result

- **Resent** — new links emailed.
- **Skipped** — rows that could not be resent, with the reason. A reason can be that the candidate started in the meantime, their account is disabled, or the email could not be queued. Skipped rows are not lost: open the row and
  press Resend to try again.
- **Still to send** — more candidates are waiting than one click can send
  (200). Press **Resend to everyone who hasn't started** again to continue.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.invite.import_result',
  'admin',
  'en',
  'What happened to each row: created, already existing, invited, or skipped (with the reason).',
  $$## Import result

- **Created** — new candidate accounts added to your organisation.
- **Existing** — the email was already a candidate here, so it was reused.
- **Invited** — invitation emails queued for this assessment.
- **Skipped** — rows that were not imported or not invited. Each shows the row number (the header is row 1), the email and the reason. A reason can be an invalid email, a missing name or a repeated email in the file. It can also be an email that belongs to a non-candidate (an admin). It can also be a candidate who already has an invitation for this assessment.

Use **Download skipped rows** to get a CSV you can correct and upload again.
If you see an email-volume warning, some invitations may arrive later than
usual because the email plan has a shared daily limit.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.list.content_source',
  'admin',
  'en',
  'Your platform operator generates questions. You build assessments from the content your organisation has been granted.',
  $$## Where your questions come from

**Generation is done by your platform operator, not by your organisation.**
The platform operator runs question generation into a shared question bank and then
grants your organisation access to the subjects or question sets it needs.
You cannot generate questions yourself.

**You assemble assessments from granted content.**
When you create or edit an assessment, you can only select question sets that your
organisation has been granted. The selection list shows only what is available to
you.

**Publishing is checked on the server.**
If you try to publish an assessment whose question set was not granted to your organisation, the server refuses with a clear message. The assessment stays in draft. You will need to contact your platform operator to
get that question set enabled for your organisation.

**Need more content?**
Contact your platform operator. They can grant additional subjects or question sets
to your organisation from the platform settings.

**Note for internal-tier organisations.**
If your organisation is on the internal plan, you are not subject to the content-grant
restriction — all content is available to you.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.results.download_csv',
  'admin',
  'en',
  'Download a live spreadsheet of every invited candidate''s result for this assessment, ready for a placement cell.',
  $$## Download results (CSV)

One row per invited candidate, always up to date (not the nightly report).

- **Columns:** name, email, roll number, branch, status, started and submitted times, score, max score, percent, Pass/Fail, rank, tab switches, paste count, full-screen exits. Each category also has one percentage column.
- **Rank** is 1, 2, 2, 4 style (ties share a rank) by percent, highest
  first. It is blank until a score is sent to you.
- **Tab switches, paste count, full-screen exits** are integrity signals
  counted while the candidate was in the assessment. They are hints for you to
  review, not proof of cheating.
- **Status** shows invited (not started), in_progress, submitted, graded or
  released. Score, percent and Pass/Fail stay blank until the attempt is graded.
- **Pass/Fail** uses the passing score of the assessment's difficulty.
- Opens correctly in Excel, including Indian names. Up to 10,000 rows.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.auth.login.tenant_slug',
  'admin',
  'en',
  'Your organisation''s slug — the unique URL-safe ID we issued during onboarding (for example acme-soc).',
  $$## Organisation slug

Each AssessIQ organisation has a short, URL-safe identifier you use at every
sign-in. It usually mirrors your team or product name (for example `acme-soc`,
`acme-secops`). Your AssessIQ administrator received the slug at onboarding. If you do not have it, ask them. It is not the same as your email domain.

The slug is also used in webhook payloads and embed-iframe URLs, so once it
is set it stays stable. Renaming an organisation is a manual operation that
requires support.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.auth.mfa.enroll_vs_verify',
  'admin',
  'en',
  'First-time admins enroll an authenticator app here; returning admins enter their 6-digit code to sign in.',
  $$## TOTP enrollment vs verification

The first time an admin signs in, AssessIQ shows a QR code. Scan it with an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator). After scanning, enter the 6-digit code shown in
the app to confirm the secret matches.

Returning admins skip the QR code and only enter the 6-digit code. Codes
rotate every 30 seconds; AssessIQ accepts the previous, current, and next
code to allow for small clock differences.

Five wrong codes in a row lock the account for 15 minutes.
When you enroll, AssessIQ shows 10 one-time recovery codes. Save them. If you
lose the authenticator and the codes, another admin must reset your enrollment.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.certificates.revoke',
  'admin',
  'en',
  'Revoke marks the certificate revoked and blocks the PDF. The reason shows on the public verify page.',
  $$## Revoking a certificate

Revocation is a **soft delete**. The credential record is kept and the verify page still loads. The page shows a red "Revoked" badge instead of a green verification check.

**Effects of revocation:**

- Public verify page (`/verify/<credential_id>`) shows red badge + revoke reason
- PDF download returns 410 Gone
- Share buttons are disabled in the candidate's "My Certificates" view
- The revoke action is recorded in the audit log (who and when). The
  reason text is kept on the certificate, not copied into the log.

**The reason field is required** (10–500 characters). It appears on the public verify page, so a recruiter might read it. Do not use internal jargon. Write a professional explanation, for example: "Certificate issued in error — assessment was invalidated."

**Revocation is irreversible.** A revoked certificate cannot be reissued.
If the candidate earns the credential again, AssessIQ issues a new
certificate. Revocations are logged in the audit trail with the acting
admin's identity.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.evaluations.accept_all',
  'admin',
  'en',
  'Accepts every AI proposal that did not fail. The accept that completes the attempt sends it to the organisation.',
  $$## Accept all

Commits every AI proposal on this attempt that has no failure. AssessIQ skips proposals that failed. It also skips proposals where the two AI models disagreed by two score bands or more. You can **Re-run** them or enter a **manual score**.

When the accept gives every question a final grade, the grading is complete
and the attempt is **sent to the organisation in that same step**. There is no
separate send click. Before that last accept the page tells you so, for
example "Accepting the last grade sends this result to Acme". If the organisation
releases automatically, the student gets the result within a minute.

An attempt the organisation sent back is already graded, so accepting new grades on
it does not send it again. Use **Send to organisation** for that.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.evaluations.manual_score',
  'admin',
  'en',
  'Score an answer by hand when it has no grade, such as KQL. A reason is required.',
  $$## Manual score

Use this when an answer has no grade, for example a KQL answer (the AI does not grade those). Use it also for an AI proposal you do not want to accept.

- Enter a score from 0 up to the question's points.
- A reason is required. It is saved with the grade but kept out of the audit
  log.
- You may be asked for a fresh authenticator code.
- If it is the last missing grade, saving it completes the grading and
  sends the attempt to the organisation, just like the last accept.

A question can be scored manually only once. After that, use **Override grade**.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.structural',
  'admin',
  'en',
  'Per-type counts of drafts that passed or failed the schema and difficulty structural gates, with top failure reasons.',
  $$## Structural quality

Per question-type, how many generated drafts **passed** or **failed** the structural gates. The gates are the per-type content schema and the difficulty structural validator (Bloom/NICE tagging, required fields, distractor and step shape). The **reasons** column lists the most common failure causes.

The footer line shows total passed / total and how many results regressed against the stored baseline. A non-zero regression count usually triggers a `warning` or `regression` verdict.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform',
  'admin',
  'en',
  'Platform operator control centre. Add organisations and see all of them. Organisation admins never see this page.',
  $$## What you can do here

You are signed in as a **platform operator** — the person who runs
AssessIQ for every organisation. This page is your control centre.

**Add a new organisation.**
Select **Create organisation**, then enter three items:

- the organisation's name,
- a short web-friendly name for it (the "slug" — lowercase letters,
  numbers and hyphens; it is suggested for you from the name),
- the email address of the person who will be that organisation's first
  administrator.

AssessIQ then sets the organisation up and emails that person an invitation
to sign in and manage their organisation. You do not manage the organisation's
day-to-day work — its own administrator does that.

**See every organisation.**
The list below shows each organisation, its short name, whether it is active,
and the date it was added.

## Good to know

- **Only you see this.** Organisation administrators never see
  the Platform page or this organisation list. Each organisation only ever sees
  its own data, never another organisation's.
- **Extra sign-in check.** AssessIQ may ask for the 6-digit code from your authenticator app when you create an organisation. This happens if it has been a while since you signed in. Just enter the code if prompted — anything
  you have already typed in the form is kept.
- **What happens when you add an organisation.** AssessIQ creates the organisation,
  prepares its question categories, emails the first administrator, and
  switches the organisation on. If anything goes wrong partway through, the
  organisation is left switched off and you see an error — so a half-finished
  organisation is never live.
- **What you cannot do from here.** This page does not let you sign in as
  an organisation, change an organisation's questions or candidates, or remove an
  organisation. Those are deliberately separate; ask for them if you need them.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.billing',
  'admin',
  'en',
  'Per-organisation billing drawer: set tier, set credits, view used and included credits, download CSV.',
  $$## Per-organisation billing drawer

Open any organisation's row on the Platform page to see its billing drawer.

**What you can do here:**

- **Set the plan tier** — free, pro, enterprise, or internal. The internal
  tier is unlimited and is exempt from credit metering.
- **Set a custom included-credit number** — override the tier default if an
  organisation has a bespoke arrangement. Leave blank for the internal tier
  (unlimited).
- **See used / included** shows how many credits the organisation has consumed this cycle against its allowance. It is live and read-only. An overage badge shows if the organisation is over.
- **Download a CSV** — export the organisation's billing events for out-of-band
  invoicing or reconciliation.

**Enforcement is soft and out-of-band.**
The system never hard-blocks an organisation for being over their included credits.
Grading always works. You follow up directly with the organisation when usage
warrants it.

**Isolation.**
Each organisation only ever sees its own data. No organisation can see another
organisation's usage or billing information.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.edit_admin',
  'admin',
  'en',
  'Update the organisation''s primary admin — name or email. Requires fresh MFA.',
  $$## Edit admin

Update the organisation's primary-contact admin without re-provisioning the
organisation. You can change their display name and correct or change their email.

**Email is the login identity** — see the email field's own help for the
consequences of changing it.

This is a platform-operator action gated by fresh MFA (a TOTP code entered within the last 15 minutes). AssessIQ may ask you to enter your authenticator code again. Every change is recorded in the audit log.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.entitlements',
  'admin',
  'en',
  'Grant or revoke an organisation''s access to a subject or question set. Question generation is platform-operator-only.',
  $$## Organisation entitlements

From the billing drawer for any organisation, you can manage which content that
organisation can use.

**Grant or revoke access.**
Add a subject or a specific question set to an organisation's entitlements
to make that content available when their admins build assessments. Remove
an entitlement to stop the organisation publishing assessments that use that
content. An assessment that is already published keeps running. If you reopen a closed assessment, AssessIQ checks it again against the organisation's current grants. A reopen can fail if you have since revoked the question set it uses.

**Question generation is yours, not theirs.**
Only you, as the platform operator, can generate questions. Generation runs
into the shared question bank. Organisation admins assemble assessments only
from content you have granted to them — they have no generate button.

**Publishing is server-checked.**
When an organisation admin publishes an assessment, the server checks that the
assessment's question set is in the organisation's active entitlements. If it is
not, publishing is refused and the assessment stays in draft.

**Internal-tier organisations are exempt.**
An organisation on the internal tier has access to all content without needing
explicit entitlement grants.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.list.create.domain',
  'admin',
  'en',
  'The role-readiness subject this question set covers (for example SOC analyst or DevOps). Set once; choose carefully.',
  $$## Question set subject

A *question set* is a collection of questions across difficulties for a single role-readiness
subject. The subject is metadata only. AssessIQ has no subject-specific code paths. The subject does control the default rubric key points, the example UI copy, and how question sets sort in the admin browser.

Common values: `soc-analyst`, `devops-engineer`, `cloud-architect`,
`identity-engineer`, `incident-responder`. Use lowercase, dash-separated.

You cannot rename a question set's subject after questions exist under it — clone
the question set into a new subject instead.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.activate_drafts',
  'admin',
  'en',
  'Activate draft questions added after publishing so assessments can draw them. Publish already activates the rest.',
  $$## Activate drafts

Publishing a question set already activates its questions. This button only matters for **draft questions added to a question set that is already published**. It changes those remaining drafts to `active` so assessments can draw them. It appears
only when a difficulty actually has draft questions waiting.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.attempt_status',
  'admin',
  'en',
  'Colour-coded status on each difficulty row shows the latest generation result. Expands on failure.',
  $$## Generation-attempt status on difficulty rows

Each difficulty row in question-set detail shows a small status indicator reflecting
the most recent generation attempt for that question set + difficulty combination.

**Status colours:**

| Colour | Status | Meaning |
|---|---|---|
| Green | `success` | Last run succeeded; all requested questions inserted |
| Amber | `partial` | Some questions inserted; one or more chunks failed |
| Red | `failed` | No questions inserted; run terminated with an error |
| Blue (animated) | `running` | Generation is in progress |

The row **polls automatically** when status is `running`, re-fetching
every few seconds. After 10 consecutive polls with no status change,
polling stops — refresh the page or visit the generation-history page for
the full `stderr_tail`.

For `failed` or `partial` rows, expand the status disclosure to see a
brief error summary. The full `stderr_tail` is available on the
generation-history page (`/admin/generation-attempts`).
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.publish',
  'admin',
  'en',
  'Lock the question set and make it usable — snapshots questions and activates every draft so assessments can draw them.',
  $$## Publish question set

Changes the question set from Draft to **Published** and snapshots every question as a permanent version. It also **activates all draft questions**, so assessments can use them immediately ("published = usable"). Editing a question after
publish adds a new version; already-published assessments stay pinned to the
snapshot they were built on.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.questions.generate.draft',
  'admin',
  'en',
  'Generate 1–30 AI draft questions from the question-set detail page. Review and activate each draft.',
  $$## AI-assisted question generation

The **Generate questions** button is in the difficulty row of the question-set detail page. It sends the question set's knowledge base and rubric key points to the AI pipeline. It returns 1–30 `ai_draft` questions per call. Each draft is staged
for review — generation does not auto-publish or activate any question.

**Using the generator:**

1. Open a question set, expand the difficulty you want to fill.
2. Select **Generate questions**, set the count (1–30), optionally narrow
   the topic focus, then select **Generate**.
3. New `ai_draft` questions appear in the question list. Open each one
   in the question editor to review key points and rubric, then activate.

Time for a single call:

- count ≤ 10  → one model call, ~30–90 s per question (cold cache)
- count 11–20 → two parallel model calls, ~3–4 min total
- count 21–30 → three parallel model calls, ~3–5 min total

### Notes

- **Cache window:** the prompt context (skill + knowledge-base JSON,
  ~25 K tokens) caches for 5 minutes after a call. A second click within
  5 minutes reuses the cache and is 2–3× faster.
- **Topic dedupe:** parallel chunks may independently propose the same
  topic. The handler drops case-insensitive duplicates against existing
  question set topics and across chunks before insert.
- **Review still required:** each `ai_draft` must be opened, reviewed,
  and individually activated — generation does not auto-publish.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.questions.type.kql.expected_keywords',
  'admin',
  'en',
  'Tokens that MUST appear (case-insensitive) for the answer to score above score band 0. Add 1–5 per question.',
  $$## KQL expected keywords

KQL questions are graded on a hybrid: **deterministic keyword presence**
plus AI judgement on syntactic and semantic correctness. The keyword list is the deterministic floor. If none of the listed tokens appear in the candidate's query, the answer can score at most score band 0. This is true however good the rest of the query is.

**Recommendations:**

- Pick tokens that are *necessary*, not sufficient: a query that lacks
  `where` or the target table cannot be correct.
- 1–5 keywords per question. More than 5 makes scoring brittle.
- Use case-insensitive matching (`Where`, `where`, `WHERE` all match).
- Quoted identifiers (`"My Table"`) are matched literally; bare tokens
  are matched as whole words (`time` will not match `timestamp`).

The AI grader sees the keyword list as a hint and uses it to ground its
own judgement — admin can still override.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.reports.cohort.heatmap',
  'admin',
  'en',
  'Topic by score heatmap for one question set: answers, correct answers, hit rate and median score band.',
  $$## Topic heatmap

For the selected question set, each row is a topic. A row shows the number of answers and the number that earned full marks. It also shows the hit rate and the mean and median score band for written answers. Choose another question set with the
selector to compare. Released results only.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.reports.heatmap.colors',
  'admin',
  'en',
  'Heat cell colour = average reasoning band for that topic-level pair: green (3–4), amber (2), red (0–1).',
  $$## Topic heatmap colour scale

Each cell in the topic heatmap represents one topic × difficulty combination.
The colour encodes the mean **reasoning band** (0–4) of all graded questions
in that cell:

| Colour | Score band range | Interpretation |
|---|---|---|
| Green | 3–4 | Strong reasoning; candidates consistently explained the concept |
| Amber | 2 | Partial reasoning; correct answers but shallow justification |
| Red | 0–1 | Weak reasoning; frequent guessing or pattern-matching |

A cell shows as **grey** when fewer than two attempts have graded answers
for that topic — not enough data to draw a meaningful conclusion.

The **hit rate** (right side of each cell) is the fraction of questions in
that cell answered correctly, regardless of reasoning band.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.reports.individual.open_attempt',
  'admin',
  'en',
  'Opens the attempt page, where the behaviour and integrity card shows the recorded events and the radar.',
  $$## Open attempt

The attempt page shows the answers, the scores and the **Behaviour and integrity** card. The card lists the recorded events (tab changes, copy and paste, full screen exits). When the result is released, it also shows the behaviour radar.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.rubric.anchor.required',
  'admin',
  'en',
  'Required key points must be present for the answer to score above score band 0, regardless of overall quality.',
  $$## Required key point

Setting a key point as **required** creates a hard floor. If the AI does not detect this concept, the score band is capped at 0. The quality of the rest of the answer does not change this.

Use sparingly — for concepts so fundamental that their absence represents
a complete misunderstanding. For most key points, leave required off and let
the holistic score band judgement do its work.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.settings.billing.ai_generate_mode',
  'admin',
  'en',
  'Question generation mode: omnibus = single prompt; sharded = one prompt per question type. Effective on next request.',
  $$## Generation mode

Controls how AI question generation works for this organisation.

| Value | Meaning |
|---|---|
| **Use global default** | Inherits the platform-wide setting (currently omnibus). Choose this to undo an organisation-specific override. |
| **omnibus** | All questions are generated in a single AI prompt. Lower latency but no per-type quality tuning. |
| **sharded** | Questions are generated in separate per-type prompts (one each for mcq, log_analysis, scenario, kql, subjective). Higher fidelity; slightly longer wall-clock time. |

**Rollout:** sharded is the target default. Until the quality checks pass
consistently, the global default stays omnibus and organisations move to
sharded one at a time as a quality pilot.

**Audit trail:** The audit log records every change to this setting. It holds the before value, the after value and the person who made the change.

**Need a change without the screen?** Ask the AssessIQ engineering team.
The change takes effect on the next generation request.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.shell.nav.mobile_menu',
  'admin',
  'en',
  'Open the navigation drawer. Available on phone-sized viewports — on a laptop the sidebar is always visible.',
  $$## Open navigation menu

Tap to open the full admin navigation drawer. Available on phone-sized viewports only. On a laptop or desktop, the sidebar is always visible in the left column and this button does not appear.

**Closing the drawer.**
The drawer closes automatically when you:

- Tap any navigation item (the page loads and the drawer closes).
- Tap the dark backdrop behind the drawer.
- Press **Escape** on a hardware keyboard.

**Keyboard users.** When the drawer opens, focus moves to the first
navigation item. Tab cycles through items inside the drawer; Shift-Tab
cycles backwards. Focus returns to the hamburger button when the drawer
closes.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.users.list.candidate.fields',
  'admin',
  'en',
  'Candidates are added directly with no email sent. Name is shown in their assessment link; designation is optional.',
  $$## Adding a candidate

Candidates are added directly to the organisation — no invitation email is sent
at this step. They receive a secure assessment link only when you assign
them to a specific assessment from the assessment's detail page.

**Name** is required. It is shown in the candidate's assessment invitation
email and appears in grading and reporting views.

**Designation** is optional free-text context (for example "SOC Analyst L1",
"Junior DevOps Engineer"). It is stored as metadata on the user record. Exports and the grading UI show it. It helps admins tell apart candidates with similar profiles. It does not affect scoring or access.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks.replay',
  'admin',
  'en',
  'Replay re-fires a past delivery to its endpoint. A new delivery record is created — the original is never modified.',
  $$## Replay and retry

**Replay** (recent deliveries table) and **Retry** (failed deliveries table)
both re-send a delivery to its original endpoint. The difference is context:

| Action | Table | When to use |
|---|---|---|
| **Replay** | Recent deliveries | Re-fire any delivery — successful or not — to re-test your endpoint or re-process data |
| **Retry** | Failed deliveries | Re-attempt a delivery that exhausted all automatic retries |

**Invariant:** both actions create a *new* `webhook_deliveries` row linked
to the same endpoint and event payload. The original row is never updated —
the delivery log is append-only for audit compliance.

**Idempotency:** your endpoint should handle duplicate deliveries. Include the `X-AssessIQ-Delivery-ID` header in your deduplication logic. It is unique per delivery row, so a replayed delivery has a different ID from the original.

**Signature:** replayed deliveries are re-signed with the current endpoint
secret. If you rotated the secret between the original delivery and the
replay, verify against the new secret.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.activity',
  'candidate',
  'en',
  'Personal activity dashboard: completions, average score, 52-week heatmap, weekly chart and question set rankings.',
  $$## My activity

This page gives you a full picture of your assessment history on this
organisation.

### Stat cards

- **Assessments completed** — total submitted attempts in the selected period,
  broken down by subject.
- **Question sets attempted** — distinct question sets you have ever submitted
  an attempt for.
- **Avg. score** — your mean auto-graded score across all completed
  attempts in the period, with a quartile breakdown.

Use the **This week / This month / This quarter** toggle to adjust the
stats window. The heatmap and weekly chart always show the full 52-week
rolling window regardless of the toggle.

### Activity streak

The 52-week heatmap shows one cell per day. Darker cells mean more
completions on that day. The current streak counts consecutive days with
at least one submitted attempt up to and including today.

### Weekly completions

The stacked bar chart shows how many assessments you submitted each week,
coloured by subject. Hover a bar to see the exact breakdown.

### My question set rankings

One row per question set you have attempted. Shows your **best score** (the highest auto-graded result across all your attempts). It also shows your **rank** among every candidate in this organisation who took the same question set. For example
"#3 of 24" means your best score places you third out of the 24 candidates
who have submitted that question set.

Ranks are computed live and update as other candidates submit new attempts.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.flag',
  'candidate',
  'en',
  'Mark a question to review before you submit. A flag does not change your score.',
  $$## Flag for review

Use this when you want to come back to a question before you submit. For instance, flag a question if you are not sure of your answer or want to verify a query.

Flagged questions appear with a star in the navigation panel. You can flag
multiple questions; the **Review** screen lists all flagged + unanswered
items together so you do not miss anything.

Flagging does not change your score. It is a personal bookmark.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.kql.mobile_tip',
  'candidate',
  'en',
  'KQL is easier on a desktop browser. Use a desktop for long queries.',
  $$## Why KQL is shown with a desktop tip on phones

The KQL question type expects you to write a structured query. Mobile keyboards lack the punctuation, operators, and pipe character that KQL uses frequently. The small viewport also makes it hard to see your full query while you write it.

You can still answer here — the textarea works the same on phone and
desktop, and your autosave runs identically. But if the question is syntax-heavy (multiple pipes, complex joins, regex), open the link on a laptop. It is much faster to answer from there.

This tip only appears on phones. On desktop you see the same editor
without the notice.
$$,
  3,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.navigator.toggle',
  'candidate',
  'en',
  'Open the question navigator. Jump to any question, see which are answered, flagged, or unseen.',
  $$## Question navigator

On a phone, the question navigator is hidden behind a small grid button
in the top bar. Tap it to open a bottom-sheet panel that shows every
question in the assessment as a numbered cell.

Cell colours mean:

- **Filled accent** — the question you are on right now.
- **Soft green** — you have entered an answer.
- **Soft amber outline** — you have flagged the question to revisit.
- **Plain outline** — you have not yet visited the question.

Tap any cell to jump straight to that question. The bottom-sheet
closes automatically after you pick. Your in-progress answer on the
current question is saved before the jump — you will not lose typing.

On a laptop the navigator is always visible on the right side of the
page and this button is hidden.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.auth.session_status',
  'candidate',
  'en',
  'You are currently signed in. Your session lasts 30 days from when you first clicked your sign-in link.',
  $$## Your sign-in session

You are signed in and your session is active. AssessIQ candidate sessions last **30 days** from the moment you clicked your sign-in link. You do not need to sign in again during that period.

The session is tied to this browser. If you switch to a different browser
or device you will need to request a new sign-in link.

**To sign out early**, close your browser or clear cookies. Your
certificates remain available; you just need a fresh link next time.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
