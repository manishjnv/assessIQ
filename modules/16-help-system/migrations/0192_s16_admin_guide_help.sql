-- 0192_s16_admin_guide_help.sql
--
-- S16 (2026-10-17): the admin guide moves from code (admin-guide.tsx) to help content.
--   admin.guide.page, admin.guide.step_01..step_12, admin.guide.tip_* (6), admin.guide.faq_* (6)
--   admin.activity.page (page help for /admin/activity)
--   The Audit log tip is rewritten: the page exists and supports CSV/JSONL export and an archive range.
--   admin.users.list.reset_totp already exists (0171); S16 only wires it to the Reset two-factor menu item.
-- Mirrors content/en/admin.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.
-- Production help rows come from forward migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.page',
  'admin',
  'en',
  'The admin guide: the 12 steps from a licensed question set to candidate results.',
  $$## Admin guide

This guide shows the full flow of an assessment, from a licensed question set to the candidate result. It has 12 steps, tips and answers to common questions.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.activity.page',
  'admin',
  'en',
  'A live view of what admins and candidates did in your organisation.',
  $$## Activity

This page shows what people did in your organisation. It is a view for daily use. It is not the audit record.

- The **feed** lists recent actions, newest first. Filter it by role.
- The **heatmap** and the **streak** show how often people were active.
- The **leaderboard** compares people over a period.
- For the full record of admin actions, with export and archive, open **Audit log** in the sidebar.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_01',
  'admin',
  'en',
  'Find your licensed sets',
  $$Click **Question bank** in the sidebar. The licensed sets section lists the sets your organisation can use. AssessIQ writes all question sets. Your organisation does not write them. To get more sets, contact your AssessIQ administrator.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_02',
  'admin',
  'en',
  'Copy a set',
  $$Import a licensed set to make your own copy (a clone). The copy appears in your question bank. When AssessIQ updates the original, an update option shows on the set.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_03',
  'admin',
  'en',
  'Know the question types',
  $$A set can contain these question types:

- **MCQ**, **Multi-select**, **Numeric** and **Ordering** — scored automatically when the candidate submits.
- **Subjective**, **KQL**, **Log analysis** and **Scenario** — graded by AssessIQ. You review and release the result.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_04',
  'admin',
  'en',
  'Build an assessment',
  $$Click **Assessments** → **+ New Assessment**. Pick a set, then set the name and the open and close window. Save the assessment as a draft.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_05',
  'admin',
  'en',
  'Add sections and timers',
  $$When you build from a set, you can split the assessment into sections. Each section has its own time limit. You can allow an on-screen calculator in a section.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_06',
  'admin',
  'en',
  'Set integrity options',
  $$Turn on the options you need: a fullscreen requirement for the candidate, and a block on copy and paste. You can change these on the assessment page. AssessIQ does not use webcam proctoring.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_07',
  'admin',
  'en',
  'Publish the assessment',
  $$Review the settings → **Publish**. The assessment is live and you can send invitations.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_08',
  'admin',
  'en',
  'Invite candidates',
  $$Open the assessment page. Invite candidates one by one, or use **Import from CSV** to add many at once (up to 1,000 rows in one file).

Each candidate receives an email with a link that is valid for 7 days. Track invitation status on the assessment page. If a candidate misses the window, press **Resend** on their row (or **Resend to everyone who hasn't started**) — they get a fresh 7-day link and the old one stops working.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_09',
  'admin',
  'en',
  'Candidates take the assessment',
  $$Candidates open the link and start the assessment. The timer starts when they begin. When a candidate submits, the attempt appears under **Attempts** in your sidebar.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_10',
  'admin',
  'en',
  'AssessIQ grades written answers',
  $$**You don't grade anything.** Multiple-choice answers are scored the moment a candidate submits. Written answers are graded by AssessIQ graders with AI assistance. When an attempt is graded it shows as **Ready to release** on the Attempts page; until then it shows **Awaiting grading** and no score is visible.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_11',
  'admin',
  'en',
  'Review and release',
  $$Open an attempt marked **Ready to release** and scroll through each question: the final score, the evidence and the reasoning behind it. Then:

- **Release to candidate** — the candidate sees the result. On the assessment page, **Release all ready** does this for every ready attempt at once. In Settings you choose the result release mode: **Manual** (the default) or **Automatic**. With Automatic, results are released when they are ready. Candidates see only complete scores.
- **Override** — record your own score with a reason; the grader's score is kept beside it (audit trail, never replaced).
- **Send back for re-grading** — return the attempt to AssessIQ with a note.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.step_12',
  'admin',
  'en',
  'Generate reports',
  $$**Reports** has a cohort report for each assessment and an individual report for each candidate. On the assessment page, **Download results (CSV)** exports the results. **Certificates** in the sidebar lists the certificates you have issued.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_score_bands',
  'admin',
  'en',
  'Score bands, not percentages',
  $$Written answers are scored in score bands: 0, 25, 50, 75 or 100. Each score band comes with evidence and reasoning.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_audit_log',
  'admin',
  'en',
  'Audit log',
  $$Admin actions are recorded. Open **Audit log** in the sidebar to filter the record by date and record type. You can export the filtered view as CSV or JSONL. You can also archive a date range: the system adds one entry to the trail and downloads the range. The system never deletes audit rows.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_regrading',
  'admin',
  'en',
  'Re-grading',
  $$Not happy with a score? Override it with a reason, or send the attempt back to AssessIQ for re-grading with a note. AssessIQ does the grading, not your organisation.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_organisations',
  'admin',
  'en',
  'Separate organisations',
  $$Every action is scoped to your organisation. You only see your organisation's data — question sets, users, grades, and reports are strictly isolated at the database row level.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_questions',
  'admin',
  'en',
  'Where your questions come from',
  $$AssessIQ writes all question sets. Your organisation works from the sets it is licensed to use. If you publish an assessment with a set you are not licensed for, publishing is refused and the assessment stays in draft. Contact your AssessIQ administrator to get more sets.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.tip_plan',
  'admin',
  'en',
  'Your plan & usage',
  $$One credit is used when a candidate attempt is graded. Re-grading the same attempt never charges again. The banner at the top of your dashboard turns amber when you reach 80% of your included credits and red when you go over — but grading never stops. Contact your AssessIQ administrator to discuss your plan.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_retake',
  'admin',
  'en',
  'Can a candidate retake?',
  $$Not by default. Admin manually creates a new invitation if needed.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_grading_fails',
  'admin',
  'en',
  'What if the grading of an attempt fails?',
  $$AssessIQ handles it. An attempt stays in the AssessIQ queue until every question has a final score, and nothing is shown to the candidate before that.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_set_change',
  'admin',
  'en',
  'Does a change to a licensed set change my assessments?',
  $$No. Existing assessments keep the questions they were published with.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_close_window',
  'admin',
  'en',
  'What happens at the close window?',
  $$The cycle closes automatically. In-progress attempts auto-submit at their per-attempt timer expiry, regardless of cycle status.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_write_questions',
  'admin',
  'en',
  'Why can''t I write questions?',
  $$AssessIQ writes all question sets. Organisation admins do not write them. You copy the sets your organisation is licensed for and build assessments from them. Contact your AssessIQ administrator to request more sets.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.guide.faq_usage_banner',
  'admin',
  'en',
  'What does the usage banner mean — will grading stop if I go over?',
  $$No — grading never stops. The banner is informational only. Green means you have used less than 80% of your included credits. Amber means 80–100% used. Red means you are over your included credits, but assigning, submitting, and grading all continue to work. Contact your AssessIQ administrator if you need to discuss your plan.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
