-- 0224_z90_mock_results_help.sql
--
-- Z-90 mock results dashboard help (5 keys). Mirrors content/en/admin.yml.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING. New keys only, version 1.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.mock_results.page',
  'admin',
  'en',
  'Mock results show how your students do in mock tests and where they are weak.',
  $$## Mock results

- **Mock only.** This page counts mock tests only. Real exams stay in Reports.
- **Read only.** Nothing here changes marks or sends data out.
- **Filter.** Pick one assessment, or keep All to see every mock.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.mock_results.topics',
  'admin',
  'en',
  'Topics with the lowest share of correct answers are the weak spots. The highest are strong.',
  $$## Weak and strong topics

- **Correct share.** The share of graded answers in a topic that earned full marks.
- **Weakest and strongest.** The five lowest and the five highest topics.
- **No topic.** A question with no topic uses its section name. Otherwise it shows as General.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.mock_results.students',
  'admin',
  'en',
  'Each student''s mock count, average score and last score.',
  $$## Students

- **Average.** The mean score across the student's mock attempts.
- **Last score.** The score of the newest mock.
- **Sort.** Select the Average heading to change the order.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.mock_results.trend',
  'admin',
  'en',
  'Average mock score by day. A rising line means the group is improving.',
  $$## Trend

- **One point a day.** Each point is the average score of the mocks taken that day.
- **Few points.** The line needs at least two days of mocks.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.mock_results.not_taken',
  'admin',
  'en',
  'Students who were invited to this mock and have not started it.',
  $$## Not taken

- **Needs one assessment.** Pick an assessment in the filter to see this list.
- **Who.** Students invited to the mock with no attempt yet.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

