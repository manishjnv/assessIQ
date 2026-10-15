-- 0176_rw87_help_copy_pass.sql
--
-- RW-87 (2026-10-16): copy pass on existing help rows (STE + Google style: no contractions,
-- no "e.g."/"etc.", plain verbs, shorter sentences). The seed is ON CONFLICT DO NOTHING, so each
-- changed key carries a new version row (version 2) in content/en/{admin,candidate}.yml.
-- BUMP admin.assessments.invitations.resend_all (v2)
-- BUMP admin.attempts.detail.release_button (v2)
-- BUMP admin.attempts.release_confirm (v2)
-- BUMP admin.audit.export.format (v2)
-- BUMP admin.auth.login.tenant_slug (v2)
-- BUMP admin.auth.mfa.enroll_vs_verify (v2)
-- BUMP admin.certificates.reissue (v2)
-- BUMP admin.certificates.revoke (v2)
-- BUMP admin.gen_score.verdict (v2)
-- BUMP admin.grading.proposal.anchors (v2)
-- BUMP admin.grading.skill_drift (v2)
-- BUMP admin.notifications.in_app.short_poll_interval (v2)
-- BUMP admin.platform (v2)
-- BUMP admin.platform.billing (v2)
-- BUMP admin.platform.domain (v2)
-- BUMP admin.platform.edit_admin.email (v2)
-- BUMP admin.platform.edit_company_name (v2)
-- BUMP admin.platform.mfa_code (v2)
-- BUMP admin.question.editor.subjective.rubric (v2)
-- BUMP admin.question_bank.list.create.domain (v2)
-- BUMP admin.question_bank.list.new_pack (v2)
-- BUMP admin.question_bank.pack.archive (v2)
-- BUMP admin.question_bank.pack.revise (v2)
-- BUMP admin.questions.generate.draft (v2)
-- BUMP admin.questions.type.scenario.step_dependency (v2)
-- BUMP admin.reports.archetype.disclaimer (v2)
-- BUMP admin.rubric.anchor.weight (v2)
-- BUMP admin.scoring.archetype.disclaimer (v2)
-- BUMP admin.tenant_settings.company_name (v2)
-- BUMP admin.users.list.candidate.fields (v2)
-- BUMP admin.webhooks (v2)
-- BUMP candidate.activity (v2)
-- BUMP candidate.attempt.disconnect (v2)
-- BUMP candidate.attempt.flag (v2)
-- BUMP candidate.attempt.kql.mobile_tip (v2)
-- BUMP candidate.attempt.timer (v2)
-- BUMP candidate.auth.link_sent (v2)
-- BUMP candidate.auth.org_code (v2)
-- BUMP candidate.intro.consent (v2)
-- BUMP candidate.intro.integrity (v2)
-- BUMP candidate.intro.system_check (v2)
-- BUMP candidate.results.list (v2)
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

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
`acme-secops`). Your AssessIQ administrator received the slug at onboarding;
if you do not have it, ask them — it is not the same as your email domain.

The slug is also used in webhook payloads and embed-iframe URLs, so once it
is set it stays stable. Renaming an organisation is a manual operation that
requires support.
$$,
  2,
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

The first time an admin signs in, AssessIQ shows a QR code and asks you to
scan it with an authenticator app (Google Authenticator, Authy, 1Password,
Microsoft Authenticator). After scanning, enter the 6-digit code shown in
the app to confirm the secret matches.

Returning admins skip the QR code and only enter the 6-digit code. Codes
rotate every 30 seconds; AssessIQ accepts the previous, current, and next
code to allow for small clock differences.

Five wrong codes in a row lock the account for 15 minutes.
When you enroll, AssessIQ shows 10 one-time recovery codes. Save them. If you
lose the authenticator and the codes, another admin must reset your enrollment.
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
"Junior DevOps Engineer"). It is stored as metadata on the user record and
surfaced in exports and the grading UI to help admins distinguish between
candidates with similar profiles. It does not affect scoring or access.
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
subject. The subject is metadata only — AssessIQ has no subject-specific
code paths — but it controls the default rubric key points, the example UI
copy, and how question sets sort in the admin browser.

Common values: `soc-analyst`, `devops-engineer`, `cloud-architect`,
`identity-engineer`, `incident-responder`. Use lowercase, dash-separated.

You cannot rename a question set's subject after questions exist under it — clone
the question set into a new subject instead.
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

The **Generate questions** button (question-set detail page → difficulty row) sends
the question set's knowledge base and rubric key points to the AI pipeline and
returns 1–30 `ai_draft` questions per call. Each draft is staged
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
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.questions.type.scenario.step_dependency',
  'admin',
  'en',
  'Lock a step so it cannot be answered until the previous step is submitted. Use sparingly.',
  $$## Step dependency

Scenario questions present a multi-step incident. By default, candidates
can navigate freely — they may answer step 3 before step 1 if they want
to think non-linearly. Setting **step dependency** locks each step until
the previous one is submitted.

**When to enable:**

- The branching narrative (we tell the candidate "the alert escalated
  because…") would spoil the answer to an earlier step.
- You want to measure pure decision speed without back-tracking.

**When not to:**

- Standard triage workflows. Real analysts revisit earlier conclusions.
- Investigation-style scenarios where evidence accumulates.

The candidate sees a small lock icon on dependent steps and a clear
"Submit step N to continue" prompt.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.subjective.rubric',
  'admin',
  'en',
  'Key points describe each score band (0/25/50/75/100). Write score band 100 first, then 0, then fill the middle.',
  $$## Subjective rubric key points

AI grading uses the rubric key points as the *one* shared truth between the
AI's judgement and your override. Every grading record stores the key points
that were active at grade time, so an audit trail survives even if you
later refine the rubric.

**Authoring approach that works:**

1. Write **score band 100** first — what does an obviously correct, complete
   answer look like? Be specific: which terms, structures, or tradeoffs
   must appear.
2. Write **score band 0** second — what is missing, vague, or wrong enough to
   score zero? The AI uses this as the negative key point.
3. Fill **score band 50** — the middle: partial credit, missing one of two
   required elements, correct intuition with weak rationale.
4. Fill **score band 25** and **score band 75** by interpolation.

**Anti-patterns:**

- "It depends" or "looks reasonable" — too vague for the AI to ground on.
- Numeric thresholds the AI cannot verify (for example "discusses at least three
  mitigations" works; "scores 7/10 on accuracy" does not work).
- More than ~80 words per score band — the rubric is a contract, not an essay.

Override the AI verdict any time. Your override sits *beside* the AI's
record, never replaces it.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.list.new_pack',
  'admin',
  'en',
  'Create a new question set for a subject. Super-admin only — it starts empty, in Draft.',
  $$## New question set

Creates an empty question set for one role-readiness subject. A new question set
starts in **Draft**: you add difficulties and questions, then **Publish** it to
make it usable in assessments. Only super-admins can create question sets — organisation
admins build assessments from question sets granted to them.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.revise',
  'admin',
  'en',
  'Move a published question set to draft, edit, then re-publish as a new version. Existing assessments are unaffected.',
  $$## Revise (new version)

Moves a **Published** question set back to **Draft** so you can edit it, then you
re-publish it as a new version. Super-admin only — this acts on the platform
master question bank. Already-published assessments keep the exact content they were
locked with at publish (they are frozen, so candidates are unaffected). When you
re-publish, every organisation clone of this set auto-updates in place, and only
newly published assessments draw the new content.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_bank.pack.archive',
  'admin',
  'en',
  'Retire this question set and hide it from pickers. Reversible in Archived; blocked if a live assessment uses it.',
  $$## Archive question set

Soft-deletes the question set: it disappears from the default list and the
assessment-creation pickers. This is the only delete path — there is no hard
delete. You can reverse it: find the question set under the **Archived** filter. Archiving is
refused if a currently-live assessment still references the question set.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.reports.archetype.disclaimer',
  'admin',
  'en',
  'Archetypes are statistical descriptors, not diagnostic labels. Use them to guide learning — not hiring decisions.',
  $$## Archetype disclaimer

AssessIQ archetypes are computed by an AI rubric engine that scores
reasoning quality on a 0–4 score band scale. They are designed to identify
**learning gaps and strengths at scale**, not to serve as a definitive
measure of individual ability.

**Do not use archetypes as the sole basis for hiring, promotion, or
compensation decisions.** They are complementary signals to human
review, structured interviews, and on-the-job performance review.

Archetype accuracy depends on:
- Question prompt quality (well-scoped rubric key points improve score band accuracy)
- Attempt length (short assessments yield less signal)
- How many questions are scored automatically and how many are written
  answers graded by AssessIQ

Results should be reviewed alongside raw scores and grading transcripts.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.audit.export.format',
  'admin',
  'en',
  'The audit log already records admin actions today; the export screen (CSV/JSONL) is available soon.',
  $$## Audit log recording — live; export screen available soon

AssessIQ already maintains an append-only audit log for every significant
admin action. The system writes each entry at the same time as the action, so no entry is
lost silently.

**Audited actions include:**
- `attempt.exported` — admin downloaded a CSV or JSONL export
- `grading.override` — admin manually changed a grading score band
- `user.created`, `user.role_changed`, `user.deactivated`
- `assessment.published`, `assessment.archived`
- `pack.version_bumped`

Audit log entries are immutable. They cannot be edited or deleted by any
admin — including organisation super-admins. Retention is 7 years (configurable
by the platform operator).

**The admin screen to export this log (CSV/JSONL) is not built yet.**
If you need an extract today, contact your platform operator.
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
- **Extra sign-in check.** When you create an organisation, AssessIQ may ask
  for the 6-digit code from your authenticator app if it has been a
  while since you signed in. Just enter the code if prompted — anything
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
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.domain',
  'admin',
  'en',
  'Optional email domain, such as company.com. Display only; it does not restrict sign-in.',
  $$## Organisation domain (optional)

Recording the organisation's email domain (for example `company.com`) is informational
only. It is stored with the organisation record and shown in the organisation list
for operator reference.

It does **not** currently restrict sign-in to that domain or auto-assign
users. Domain-based sign-in and auto-provisioning are planned for a
future release.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.edit_company_name',
  'admin',
  'en',
  'The organisation''s display name (the organisations.name column). Editable; the slug stays fixed. Requires fresh MFA.',
  $$## Organisation name

The organisation's display name, shown in the Platform list and across the admin
UI. You can rename it here at any time. It is a label only, with no effect
on data, logins, or isolation.

**The slug is permanent.** The short URL-safe identifier (for example `acme-corp`)
issued at provisioning is used in webhook payloads and embed URLs, so it
cannot be changed here. Only the display name is editable.

Renaming is a platform-operator action gated by fresh MFA and recorded in
the audit log (`tenant.renamed`).
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.edit_admin.email',
  'admin',
  'en',
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
code at the new address. If they do not control that address they will be locked out; if
someone else controls it, that person gains access. Because of this, the
change requires an explicit confirmation checkbox.

Either way, the new email must not already belong to another user in the
same organisation.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.mfa_code',
  'admin',
  'en',
  '6-digit code from your authenticator app. Required before provisioning a new organisation (fresh-MFA gate).',
  $$## MFA step-up — authenticator code

Creating a new organisation is a high-privilege operation gated behind
fresh TOTP verification (code must have been entered within the last 15
minutes).

If your session's MFA is stale, the create form switches to a step-up
prompt. Enter the current 6-digit code from your authenticator app
(Google Authenticator, Authy or 1Password) and select **Verify & create**.

On success the platform automatically retries the create operation — you
do not need to re-enter the form values.

**Lockout:** five wrong codes in a row locks the account for 15 minutes.
Wait for the lockout to expire before retrying.
$$,
  2,
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
- **See used / included** — a live read-only display of how many credits the
  organisation has consumed this cycle versus their allowance, with an overage
  badge if they are over.
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
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.notifications.in_app.short_poll_interval',
  'admin',
  'en',
  'In-app notifications are fetched every 15 seconds. There is no live push yet.',
  $$## In-app notification polling

The admin dashboard polls for new in-app notifications every **15 seconds**
using a short-poll strategy. Notifications include:

- Grading complete (an attempt's AI grading finished)
- Bulk invite batch complete (all emails sent)
- Assessment boundary transitions (for example attempt timer expired)

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
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.grading.proposal.anchors',
  'admin',
  'en',
  'Green chips = key point phrases the AI found; grey chips = key points it did not detect.',
  $$## Key point findings

Each key point in the rubric is shown as a chip. **Green / hit** means the AI
found the concept in the candidate's answer (with evidence shown on hover).
**Grey / miss** means the concept was absent or the AI was not confident
enough to flag it.

Misses do not automatically reduce the score — score band scoring is holistic.
A score band 3 answer can miss a minor key point if the overall reasoning quality
justifies it. Use the key point display as a *starting point*, not a checklist.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.grading.skill_drift',
  'admin',
  'en',
  'The prompt version used for this grade differs from the current live prompt. Consider re-grading.',
  $$## Skill drift

Each grading row records the SHA-256 hash of the prompt version that
produced it. If the admin updates a grading skill (prompt template), rows
graded with the old version are flagged with a **drift** badge.

Drift is informational — it does not block releasing results. Use it as a
signal to re-run affected attempts when a prompt change was material (for example
a rubric key point was corrected).
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.scoring.archetype.disclaimer',
  'admin',
  'en',
  'Behavioral signals are observational only. They do not affect the score and are not a proxy for integrity.',
  $$## Archetype signal disclaimer

Archetype signals are behavioral telemetry, not integrity flags. They:

- Do **not** adjust the candidate's score in any direction.
- Are **not** a proxy for cheating detection.
- Are context-dependent: a slow pace on Advanced scenarios is normal; the same
  pace on a Beginner triage question might indicate difficulty.

Use signals to understand cohort patterns (for example "Intermediate candidates average
200 edits per attempt") not to make individual pass/fail decisions.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.rubric.anchor.weight',
  'admin',
  'en',
  'Fractional contribution of this key point to the total rubric weight. All key point weights must sum ≤ 1.0.',
  $$## Key point weight

The weight controls how much this key point contributes to the overall
scoring floor. All key point weights must sum to ≤ 1.0 (the UI shows the
running total and blocks saving if exceeded).

Recommended allocation: identify 2–4 *essential* key points (weight 0.2–0.3
each) and 2–4 *supporting* key points (weight 0.05–0.1 each). Leave room in
the total so a strong answer that covers most key points is not penalized by
one missed nuance.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.verdict',
  'admin',
  'en',
  'Roll-up call for this run — pass, warning, or regression — from the structural and runtime checks below.',
  $$## Overall verdict

A single roll-up of the structural-quality and runtime checks for this run:

- **pass** — structural checks pass and no runtime metric failed.
- **warning** — minor issues worth a look (for example a soft metric miss), but not
  a regression.
- **regression** — a structural baseline regressed, or a runtime metric
  failed its threshold.
- **n/a** — not enough data to score (for example the run produced no questions).

The verdict is derived from the tables below; it does not change any drafts.
$$,
  2,
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
recruiter might read, for example: "Certificate issued in error — assessment was
invalidated." rather than internal jargon.

**Revocation is irreversible.** A revoked certificate cannot be reissued.
If the candidate earns the credential again, AssessIQ issues a new
certificate. Revocations are logged in the audit trail with the acting
admin's identity.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.certificates.reissue',
  'admin',
  'en',
  'Updates display fields such as the name. credential_id and issued_at stay the same, so share URLs stay valid.',
  $$## Reissuing a certificate

Reissue is used for **name corrections** — when a candidate's display
name was wrong at issuance and needs to be fixed on the certificate.

**What reissue does:**

- Updates `display_name` to the new value (or re-snapshots from the current
  user record if no override is provided)
- Recomputes the HMAC signature over the updated fields
- **Preserves** `credential_id` and `issued_at` — any LinkedIn share
  URLs or QR codes the candidate already distributed continue to resolve
  to the correct verify page

**What reissue does NOT do:**

- Rotate `credential_id` or `issued_at`
- Change the tier or course_title
- Affect revoked certificates (revoked certs return 410 if reissue is attempted)

**When to use vs. when NOT to use:**

| Use reissue | Do NOT use reissue |
|---|---|
| Legal name change on a valid cert | Candidate did not actually earn the tier |
| Typo in the display name | Certificate should be revoked |
| Re-snapshot after a profile correction | Course title changed (snapshot is intentional) |

Reissue is audited: before/after display_name is recorded with the acting
admin's identity.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.webhooks',
  'admin',
  'en',
  'Register outbound webhooks for real-time events when AssessIQ actions occur (submitted, graded, certificate issued).',
  $$## Webhooks

The **Webhooks** page (`/admin/webhooks`) lets you register HTTPS endpoints
that receive a POST request whenever an AssessIQ event fires.

**What you can do here:**

| Action | Description |
|---|---|
| **New webhook** | Register a new endpoint — provide an https:// URL, select the events you want, and optionally supply your own signing secret |
| **Test** | Fire a synthetic `test.ping` event to verify the endpoint is reachable |
| **Revoke** | Permanently remove the endpoint — no further events will be delivered |
| **View payload** | Expand a delivery row to see the full JSON payload (truncated to 2KB in-UI; Download for full) |
| **Replay** | Re-fire a past delivery to an endpoint (creates a new delivery row; the original is unchanged) |
| **Retry** | Re-attempt a delivery that exhausted all retries |

**Signing secrets:** each endpoint has a shared HMAC secret used to sign
every webhook payload. The plaintext secret is shown exactly once at
creation — save it immediately. Verify signatures with
`HMAC-SHA256(secret, rawBody)` against the `X-AssessIQ-Signature` header.

**`audit.*` subscriptions** require a fresh MFA verification (within 5
minutes) when creating the endpoint. This is a server-side gate — the UI
shows a warning but the server enforces it unconditionally.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.company_name',
  'admin',
  'en',
  'The organisation name shown in the app header and in emails to your candidates.',
  $$## Organisation name

This is your organisation's **display name**. It appears in the app header
and in emails sent to your candidates (invitations, reminders).

- Use 2–120 characters; extra spaces are tidied automatically.
- Changing it does **not** change your sign-in address, organisation ID, or
  anything candidates use to sign in.
- The new name also appears on certificates you issue or view afterwards.
- Each change is recorded in the audit log.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.attempts.detail.release_button',
  'admin',
  'en',
  'Release this result to the candidate, who is emailed. Released results cannot be changed.',
  $$## Release to candidate

Shows the candidate their final result and emails them. A summary of the scores
opens first so you can check them before confirming.

- Available when the attempt is **Ready to release**.
- A certificate is issued if the candidate qualifies.
- Released results are final: scores can no longer be overridden.

With Automatic release turned on in Settings, results release themselves as soon
as AssessIQ sends the grading to you.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.invitations.resend_all',
  'admin',
  'en',
  'Email a new 7-day link to every candidate who has not started. Their old links stop working.',
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
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.attempts.release_confirm',
  'admin',
  'en',
  'Release this result to the candidate and email them. Released results cannot be changed.',
  $$## Confirm release

This window shows a summary of the scores so you can check them before you
release.

- **Release to candidate** shows the candidate their final result and emails
  them.
- A certificate is issued if the candidate qualifies.
- Released results are final. Scores can no longer be overridden.
- Questions that are flagged for review have no committed grade. The
  released result shows only the questions that have final grades.
- Choose **Cancel** to go back without releasing.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.integrity',
  'candidate',
  'en',
  'AssessIQ measures judgment and reasoning, not memory. Use any reference you would in a real workday.',
  $$## Integrity expectations

This assessment is not closed-book. AssessIQ is built to measure
how you think on the job, not what you can recall under pressure. Use:

- **Documentation** for the tools and languages you would normally
  reference at work.
- **Search engines** to find syntax or operators.
- **Notes** you would normally have open.

Do **not** ask another person to answer for you, share screens, or paste
answers from another candidate's attempt. AssessIQ records timing
signals, edit patterns, and behavioral fingerprints; identical or
near-identical answers across candidates are flagged for review.

Once you click **Begin Assessment**, the timer starts and cannot be
paused. If your network drops, your answers are saved every 5 seconds —
you can refresh and continue.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.system_check',
  'candidate',
  'en',
  'A quick automatic check that your connection, browser and storage are ready. Fix any item marked Fix needed.',
  $$## System check

Before you begin, AssessIQ runs a few quick checks in your browser:

- **Internet connection** and **connection to AssessIQ**: your answers save
  to our server as you work.
- **Cookies and storage**: needed to keep you signed in and keep a local
  backup of your answers. Private or incognito windows often block them.
- **Browser**: use the latest Chrome, Edge, Firefox or Safari.
- **Screen size**: a very small screen only shows a notice.

Nothing is sent about your device. If something needs fixing, follow the
hint, then choose **Check again**. You can begin once every item is OK.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.intro.consent',
  'candidate',
  'en',
  'Confirm it is you, taking the assessment alone, and agree to the Terms and Privacy Policy before you begin.',
  $$## Consent and AI-use notice

Before the timer starts, confirm that you are the person invited. Confirm that
you will take the assessment on your own. Agree to the Terms and Privacy Policy.
Your results may be shared with the organisation that invited you. We record
when you agreed.

**How answers are scored:** AssessIQ scores multiple-choice answers
automatically. AssessIQ graders grade written answers, if any, with AI
assistance. The organisation that invited you then releases the results.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.timer',
  'candidate',
  'en',
  'Time left for the whole assessment. It submits at zero. You cannot pause the timer.',
  $$## Timer

The countdown shows the time left for the entire assessment, not the
current question. When it reaches zero, AssessIQ submits the answers
you have entered.

**The timer keeps running even if you close the tab.** Network dropouts
do not pause it. If you cannot continue (for example a power outage or a
medical emergency), close the tab and contact your administrator
at once. Your administrator can grant a one-time extension before you submit.

Behavioral signals recorded by AssessIQ include time spent per question,
number of edits, and navigation pattern. None of these signals affect
your score directly; they inform the admin's review.
$$,
  2,
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

Use this when you want to come back to a question before you submit —
for instance, if you are not sure of your answer or want to verify a query.

Flagged questions appear with a star in the navigation panel. You can flag
multiple questions; the **Review** screen lists all flagged + unanswered
items together so you do not miss anything.

Flagging does not change your score. It is a personal bookmark.
$$,
  2,
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

The KQL question type expects you to write a structured query. Mobile
keyboards lack the punctuation, operators, and pipe character that KQL
uses frequently, and the small viewport makes it hard to see your full
query while you write it.

You can still answer here — the textarea works the same on phone and
desktop, and your autosave runs identically. But if the question is
syntax-heavy (multiple pipes, complex joins, regex), it is meaningfully
faster to open the link on a laptop and answer from there.

This tip only appears on phones. On desktop you see the same editor
without the notice.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.attempt.disconnect',
  'candidate',
  'en',
  'AssessIQ saves your answers every 5 seconds. Refresh the page and continue. The timer keeps running.',
  $$## If your connection drops

AssessIQ saves your in-progress answers to the server every 5 seconds and
shows a small green check next to "Saved" when the latest save completed.
A red dot means the last save attempt failed; AssessIQ will retry on the
next interval.

**If you lose connectivity:**

1. **The timer keeps running** — wall-clock time, not connected time.
2. **Reconnect and refresh** — your most recent autosaved state loads.
3. **Anything typed during the offline window is lost** — only saved
   state survives a refresh.

For a genuinely-blocking outage (power, hardware failure), close the tab
and contact your administrator. They can grant a one-time extension
before you submit, but cannot extend after auto-submit fires.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.results.list',
  'candidate',
  'en',
  'Every result your organisation has released to you, newest first, with a link to any certificate you earned.',
  $$## My results

This page lists the results your organisation has **released** to you,
newest first. Each one shows your score, the percentage, whether you
passed, and a link to your certificate when you earned one.

- A result appears here only when grading is finished and it has been
  released — never earlier, and never as a partial score.
- When a result is released we also email you, with a link back to this
  page.
- If an assessment you took is missing, its result is not released yet.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.auth.org_code',
  'candidate',
  'en',
  'Your organisation''s short code, for example acme-college. If you do not have it, ask your administrator.',
  $$## Organisation code

The code identifies the organisation (a school, college or business) that
registered you, so AssessIQ can find your account. It is made of lowercase
letters, digits and hyphens, for example `acme-college`.

- If you opened this page from a link in an email from us, the code is
  already included and this box is not shown.
- Otherwise, ask your administrator for the code.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.auth.link_sent',
  'candidate',
  'en',
  'A sign-in link is on its way. It expires in 15 minutes. If it does not arrive, wait one minute and try again.',
  $$## Check your email

A sign-in link has been sent to the address you entered. It will arrive
within a minute or two depending on your email provider.

**The link expires in 15 minutes.** If you do not click it in time, come
back to the sign-in page and request a new one.

**Did not receive anything?**

- Check your spam or junk folder.
- Make sure you entered the exact email address your administrator
  registered you with.
- Wait at least 60 seconds before requesting another link (too many
  requests in a short window are automatically rate-limited).

Each link is single-use — clicking it a second time will not work.
Request a fresh link if you need to sign in again.
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

One row per question set you have attempted. Shows your **best score** (the
highest auto-graded result across all your attempts) and your **rank**
among every candidate in this organisation who took the same question set. For example
"#3 of 24" means your best score places you third out of the 24 candidates
who have submitted that question set.

Ranks are computed live and update as other candidates submit new attempts.
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
