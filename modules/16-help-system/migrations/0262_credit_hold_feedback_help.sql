-- 0262_credit_hold_feedback_help.sql
--
-- Credit hold and per-question feedback level help (Z-145, Z-146, Z-158): eight new keys.
-- Five cover credit holds and credit cost. Four cover the Mock-only per-question feedback level
-- (group entry plus three options). Mirrors content/en/admin.yml. New keys only, version 1.
-- Idempotent: INSERT ... WHERE NOT EXISTS, as in 0261 (the guard compares the real key and text).

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.feedback_level', 'admin', 'en',
  'Choose what students see about each question after the result is released. Mock tests only.',
  $$## Per-question feedback

- **Mock tests only.** Real tests always show the score only.
- **When.** The choice applies after you release the result.
- **Options.** Pick one option below. The default is no question details.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level' AND locale = 'en'
    AND short_text = 'Choose what students see about each question after the result is released. Mock tests only.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.feedback_level.none', 'admin', 'en',
  'No question details. Students see only the score.',
  $$## No question details

- **Default.** Students see only the score.
- **Question list.** Students do not see any question details.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.none' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.none' AND locale = 'en'
    AND short_text = 'No question details. Students see only the score.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.feedback_level.right_wrong', 'admin', 'en',
  'Shows if each answer was right or wrong, with the student answer and what to study.',
  $$## Right or wrong

- **Result.** Students see if each answer was right or wrong.
- **Own answer.** Students see the answer they gave.
- **Study.** Students see what to study next.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.right_wrong' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.right_wrong' AND locale = 'en'
    AND short_text = 'Shows if each answer was right or wrong, with the student answer and what to study.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.feedback_level.with_expected_answer', 'admin', 'en',
  'Also shows the expected answer for questions with a fixed correct answer.',
  $$## Expected answer

- **Includes.** Everything in right or wrong.
- **Expected answer.** Shown for questions that have one fixed correct answer.
- **Written answers.** No expected answer shows for written questions.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.with_expected_answer' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.with_expected_answer' AND locale = 'en'
    AND short_text = 'Also shows the expected answer for questions with a fixed correct answer.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.test_type.feedback_level.with_ai_justification', 'admin', 'en',
  'Also shows a short, plain-words reason for written answers.',
  $$## AI reason

- **Includes.** Everything in expected answer.
- **Reason.** A short reason in plain words for each written answer.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.with_ai_justification' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.test_type.feedback_level.with_ai_justification' AND locale = 'en'
    AND short_text = 'Also shows a short, plain-words reason for written answers.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.invite.held', 'admin', 'en',
  'Credits are held for this student until they submit the test.',
  $$## Held credits

- **Held.** The credits for this invitation are reserved for this student.
- **Used on submit.** The credits are used when the student submits the test.
- **Released.** The hold ends if the student never takes the test, the link expires, or you revoke the invitation.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.held' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.held' AND locale = 'en'
    AND short_text = 'Credits are held for this student until they submit the test.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.assessments.invite.credit_cost', 'admin', 'en',
  'The credits these invitations need, and the credits you have available.',
  $$## Credit cost

- **Needed.** The credits these invitations need.
- **Available.** Your credits, minus credits held for open invitations.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.credit_cost' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.assessments.invite.credit_cost' AND locale = 'en'
    AND short_text = 'The credits these invitations need, and the credits you have available.'
);

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT gen_random_uuid(), NULL, 'admin.start_test.credit_cost', 'admin', 'en',
  'The credits this test needs, and the credits you have available.',
  $$## Credit cost

- **Needed.** The credits this test needs for the candidates you choose.
- **Available.** Your credits, minus credits held for open invitations.
- **Used on submit.** Credits are used when each candidate submits the test.
$$,
  (SELECT COALESCE(MAX(version), 0) + 1 FROM help_content WHERE tenant_id IS NULL AND key = 'admin.start_test.credit_cost' AND locale = 'en'), 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM help_content
  WHERE tenant_id IS NULL AND key = 'admin.start_test.credit_cost' AND locale = 'en'
    AND short_text = 'The credits this test needs, and the credits you have available.'
);
