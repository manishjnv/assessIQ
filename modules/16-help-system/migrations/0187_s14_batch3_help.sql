-- 0187_s14_batch3_help.sql
--
-- S14 (2026-10-16): help rows for the P0-Z batch 3 UI.
--   RW-59  question import formats: admin.question_import.formats, .text_format
--   PT1/PT-4 billing plan limits: admin.settings.billing.limits, .limits.enforced
--   Logo L2/L3a tenant logo: admin.tenant_settings.logo, .logo.remove, admin.shell.tenant_logo,
--          candidate.take.{landing,attempt,submitted}.logo, candidate.shell.logo;
--          bump admin.tenant_settings.page v2 (logo bullet)
--   EX-1   negative marking: admin.question_editor.negative_marks,
--          admin.assessments.settings.negative_marks_default, candidate.result.negative_marking
--   EX-3   passage sets: admin.question.editor.structured_case.{step_marks,passage_preset},
--          candidate.take.structured_case.child_marks
--   P4     least-AI tiers: admin.platform.tenant.ai_grading_scope, admin.attempts.grading.tiers
-- Mirrors content/en/*.yml (rows copied from the regenerated seeds/help_content.sql).
-- Idempotent INSERT ... ON CONFLICT DO NOTHING. Production help rows come from forward
-- migrations, not from the seed (docs/06-deployment.md, Seeds).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.formats',
  'admin',
  'en',
  'Files you can upload: CSV, XLSX, GIFT, Aiken, or a QTI package.',
  $$## Accepted formats

- **CSV or XLSX.** Use a template from this page. All question types.
- **GIFT.** A Moodle text format. Multiple-choice questions only. One answer must start with `=`.
- **Aiken.** A plain text format. Multiple-choice questions only. Each question ends with an `ANSWER:` line.
- **QTI.** A QTI 2.1, 2.2 or 3.0 package (`.zip`) or one item file (`.xml`). Choice, order, numeric entry and extended text items are read. Other item kinds show as row errors.
- The limit is 4 MB and 2000 questions for each file.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_import.text_format',
  'admin',
  'en',
  'A .txt file can hold GIFT or Aiken questions. Pick the one that matches your file.',
  $$## Text format

AssessIQ cannot tell GIFT and Aiken apart from the file name. Choose the format that your file uses. A wrong choice gives row errors, not a broken import. Fix the choice and upload again.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.settings.billing.limits',
  'admin',
  'en',
  'The limits of your plan: question sets, candidates for each drive, the credit cap and AI-evaluated answers.',
  $$## Plan limits

- **Question sets.** How many question sets your plan includes.
- **Candidates per drive.** The most candidates one assessment can invite.
- **Overage cap.** What happens when you use more credits than your plan includes.
- **AI-evaluated answers.** Written answers that AssessIQ evaluates for you, used and included this month.
- "Unlimited" means your plan has no cap for that row. Contact AssessIQ to change your plan.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.settings.billing.limits.enforced',
  'admin',
  'en',
  'Plan limits are shown for information. AssessIQ does not block actions on them yet.',
  $$## Limits are not enforced yet

Your plan limits are visible so that you can plan. Nothing is blocked today. AssessIQ will tell you before limits start to apply.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.logo',
  'admin',
  'en',
  'Upload your organisation logo (PNG or JPEG, up to 512 KB). It shows next to your name with "via AssessIQ".',
  $$## Organisation logo

- **Format.** PNG or JPEG. SVG, GIF and WebP are refused.
- **Size.** Up to 512 KB. Each side between 32 and 2048 pixels.
- **Where it shows.** The admin top bar, the candidate assessment pages, candidate emails, the public certificate page, the social preview image and the certificate PDF.
- **Co-branding.** The logo always appears with "via AssessIQ". It never replaces the AssessIQ mark.
- **Replace.** Upload a new file. The new logo replaces the old one everywhere, also on certificates that were issued before.
- You may be asked for a fresh authenticator code.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.logo.remove',
  'admin',
  'en',
  'Remove the logo. Your organisation name shows alone until you upload a new one.',
  $$## Remove the logo

Removing the logo takes effect at once on every page, email and certificate. You can upload a new logo at any time. You may be asked for a fresh authenticator code.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.shell.tenant_logo',
  'admin',
  'en',
  'Your organisation logo, as uploaded in Settings. Candidates see the same logo.',
  $$## Organisation logo

This is the logo that an organisation admin uploaded in Settings. Change or remove it on the Settings page.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question_editor.negative_marks',
  'admin',
  'en',
  'Marks taken away for a wrong answer on an auto-scored question. Blank uses the assessment default.',
  $$## Negative marks

- **Applies to** auto-scored questions: multiple choice, multi-select, numeric, ordering and structured case.
- **A wrong, attempted answer** loses this many marks. A question with no answer loses nothing. A partly correct answer loses nothing.
- **Blank** means the default of the assessment applies. Enter `0` to switch negative marking off for this question only.
- The value is frozen for each attempt when the candidate starts. A later edit does not change attempts that already exist.
- A candidate total can go below zero. The score band and the certificate rule treat a total below zero as zero.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.assessments.settings.negative_marks_default',
  'admin',
  'en',
  'Default marks taken away for a wrong answer, for every question that has no value of its own.',
  $$## Default negative marks

- This value applies to every auto-scored question in the assessment that has no negative marks of its own.
- `0` means no negative marking (the default).
- Typical exam patterns use a quarter or a third of the question marks, for example `0.25` for a 1-mark question.
- You can change it only while the assessment is a draft. Attempts freeze the value when they start.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.structured_case.step_marks',
  'admin',
  'en',
  'Marks and negative marks for one step. Blank marks count as 1. Blank negative marks follow the question value.',
  $$## Step marks

- **Marks** is the weight of this step inside the question. The question total is still the question points: a step with marks 2 counts twice a step with marks 1.
- **Negative marks** is the penalty for a wrong, attempted answer on this step. Leave it blank to take the question's negative marks, split by the step weight.
- A blank step loses nothing. A partly right multi-select step loses nothing.
- With "all or nothing" scoring, the question gives full points only when every step is right.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.question.editor.structured_case.passage_preset',
  'admin',
  'en',
  'Fills the editor with a passage and five single-choice questions, ready to edit.',
  $$## Passage set preset

A passage set is a structured case whose context is the shared passage and whose steps are the questions that follow it. The preset gives you a title, a passage placeholder and five single-choice steps with four options each. Replace the placeholder text, set the correct options and adjust marks for each step.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.platform.tenant.ai_grading_scope',
  'admin',
  'en',
  'AI for written answers in this organisation: Written (default) or None (a person scores every written answer).',
  $$## AI grading scope

- **Written.** AssessIQ may evaluate written answers (subjective, scenario and log analysis) with AI. Auto-scored types never use AI. This is the default.
- **None.** No AI call runs for this organisation. Written answers wait for a manual score. Blank answers and answers identical to an accepted grade are still scored by rule and reuse, which use no AI.
- Only the platform admin can change this. Each change is recorded in the audit log.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.attempts.grading.tiers',
  'admin',
  'en',
  'How each question of this attempt was graded: answer key, reuse, rule, AI, or a person.',
  $$## Graded by

AssessIQ grades with the least AI that keeps accuracy, in this order:

1. **Answer key.** Multiple choice, multi-select, numeric, ordering and structured case questions are scored from the key.
2. **Reuse.** An answer identical to one that already has an accepted grade for the same question gets that grade.
3. **Rule.** A blank answer gets band 0.
4. **AI.** Written answers are evaluated with AI and reviewed by the platform admin.
5. **Human.** Flagged cases, overrides and manual scores.

The line counts the questions in each tier. Zero tiers are left out.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.result.negative_marking',
  'candidate',
  'en',
  'This assessment takes marks away for wrong answers. The line shows the total that was deducted.',
  $$## Negative marking

- A wrong answer on an auto-scored question takes marks away. A question you left blank takes nothing away.
- The score shown is your total after the deduction. It can be below zero.
- Your band and any certificate use zero as the lowest score.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.take.landing.logo',
  'candidate',
  'en',
  'The organisation that invited you. AssessIQ runs the assessment on its behalf.',
  $$## Organisation

This logo belongs to the organisation that invited you. AssessIQ provides the assessment platform. Your answers go to that organisation.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.take.attempt.logo',
  'candidate',
  'en',
  'The organisation that set this assessment.',
  $$## Organisation

The logo in the top bar shows which organisation set this assessment. AssessIQ runs it on their behalf.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.take.submitted.logo',
  'candidate',
  'en',
  'The organisation that will see your result.',
  $$## Organisation

Your submission went to this organisation. It decides when and how results are released.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.shell.logo',
  'candidate',
  'en',
  'The organisation your results belong to.',
  $$## Organisation

This logo shows the organisation that invited you to the assessments listed here. AssessIQ runs the platform on their behalf.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'candidate.take.structured_case.child_marks',
  'candidate',
  'en',
  'Marks for a right answer and marks taken away for a wrong one on this question.',
  $$## Marks for this question

The first number is what a right answer earns. The second number, with a minus sign, is what a wrong answer loses. A question you leave blank loses nothing.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.tenant_settings.page',
  'admin',
  'en',
  'Organisation name, how results reach candidates, and how long candidate personal data is kept.',
  $$## Settings

This page holds the settings for your organisation. Only organisation admins can open it.

- **Organisation name.** Change the name that your team and candidates see.
- **Result release.** Choose when candidates receive results. With Manual, you release each result yourself. With Automatic, a result goes out when it is ready.
- **Data retention.** Set the number of days that the organisation keeps personal data of candidates.
- **Erased candidates.** See the candidates whose personal data was removed. Their names and emails cannot be read.
- You may be asked for a fresh authenticator code when you change the release mode.
- **Organisation logo.** Upload a PNG or JPEG logo. It shows next to your organisation name for your team and your candidates, with "via AssessIQ".
$$,
  2,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
