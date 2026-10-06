-- 0159_help_cohort_breakdown_behaviour_difficulty.sql
--
-- Wave 2 Batch 3 (2026-10-06): FU-C4 cohort breakdown + heatmap, FU-C8
-- behaviour and integrity card, FU-C13 difficulty chips.
-- 1. admin.attempt.integrity -> admin.attempts.detail.integrity (all tenants
--    and versions, 0155 pattern): the card sits on the attempt page whose
--    helpPage is admin.attempts.detail, so the old key could never load.
-- 2. NEW keys (idempotent INSERT ... ON CONFLICT DO NOTHING):
--    admin.attempts.detail.behaviour, admin.reports.individual.open_attempt,
--    admin.reports.cohort.{by_level,by_topic,heatmap,pack},
--    admin.question.editor.difficulty, admin.question_bank.pack.difficulty
-- Mirrors content/en/admin.yml; 0011 regenerated in the same commit.

DELETE FROM help_content o
 WHERE o.key = 'admin.attempt.integrity'
   AND EXISTS (SELECT 1 FROM help_content n
                WHERE n.key = 'admin.attempts.detail.integrity' AND n.locale = o.locale AND n.version = o.version
                  AND n.tenant_id IS NOT DISTINCT FROM o.tenant_id);

UPDATE help_content SET key = 'admin.attempts.detail.integrity' WHERE key = 'admin.attempt.integrity';


INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.attempts.detail.behaviour', 'admin', 'en',
  'Behaviour signals recorded during the attempt: pace, edits, flags, focus loss, full screen, copy and paste. Not a score.',
  $$## Behaviour at finalize

The radar shows the behaviour signals AssessIQ recorded while the candidate
took the test, as a snapshot taken when the result was finalized. Each axis
is scaled against a fixed ceiling, so a full axis means "a lot", not "wrong".

- **Pace** - median time per question.
- **Edits** - how often answers were changed.
- **Flags** - questions the candidate marked for review.
- **Focus loss / Fullscreen exits / Copy-paste / Multi-tab** - recorded events, the same ones counted on the left.

These signals are observational. They never change the score and are not a
proxy for integrity. The radar appears only after the result is released to
your company, like the score.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.individual.open_attempt', 'admin', 'en',
  'Opens the attempt page, where the behaviour and integrity card shows the recorded events and the radar.',
  $$## Open attempt

The attempt page shows the answers, the scores and the **Behaviour and
integrity** card: the recorded events (tab changes, copy and paste, full
screen exits) and, once the result is released, the behaviour radar.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.cohort.by_level', 'admin', 'en',
  'Attempt count and average score for each level of the assessment, released results only.',
  $$## By level

One row per level (L1, L2, L3) with the number of released attempts and
their average score. Results that are not yet released to your company are
not counted.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.cohort.by_topic', 'admin', 'en',
  'Average score and hit rate for each topic, across the released attempts of this assessment.',
  $$## By topic

One row per question topic. **Average** is the mean score across the
answers on that topic. **Hit rate** is the share of answers that earned
full marks. Low rows show where the cohort is weak. Released results only.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.cohort.heatmap', 'admin', 'en',
  'Topic by score heatmap for one question pack: answers, correct answers, hit rate and median band.',
  $$## Topic heatmap

For the selected question pack, each row is a topic with the number of
answers, the number that earned full marks, the hit rate, and the mean and
median score band for written answers. Choose another pack with the
selector to compare. Released results only.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.reports.cohort.pack', 'admin', 'en',
  'The question pack whose topics the heatmap shows. It starts on the pack of this assessment.',
  $$## Pack selector

The heatmap is computed per question pack. The selector starts on the pack
this assessment uses. Choose another pack to compare its topics across all
the released attempts that used it.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question.editor.difficulty', 'admin', 'en',
  'Bloom level and NICE task written by the generator. Human-authored questions have no tags.',
  $$## Difficulty tags

AssessIQ tags each generated question with a **Bloom** cognitive level
(remember, understand, apply, analyze, evaluate, create) and a **NICE**
task id from the NICE framework. The tags describe the intrinsic difficulty
of the item; they are not the L1/L2/L3 level. Questions written by hand and
questions generated before 2026-05-23 have no tags. The tags are read-only.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.question_bank.pack.difficulty', 'admin', 'en',
  'Bloom level and NICE task of a generated question. Absent on human-authored questions.',
  $$## Difficulty tags

Generated questions carry a **Bloom** cognitive level and a **NICE** task
id. They describe the intrinsic difficulty of the item and are read-only.
Questions written by hand have no tags.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
