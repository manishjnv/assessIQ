-- 0155_help_ids_page_prefix_n23.sql
--
-- N23: help ids outside their page prefix never load (the API returns keys
-- LIKE '<helpPage>.%'). 30 keys are renamed so each starts with its page id; three keys
-- are used on two pages, so one extra copy of the text is created for the second
-- page. Text is unchanged. Same pattern as 0149 (N20).
--
-- Idempotent and correct in both cases:
--   * production: rows exist only under the old key (all tenants/versions) ->
--     copy (3 shared keys), then UPDATE key.
--   * fresh DB: regenerated 0011 already inserted the new keys, older migrations
--     inserted the old keys -> copies hit ON CONFLICT DO NOTHING, and the old row
--     is deleted when the same (tenant_id, locale, version) exists under the new key.

-- 1. Copy shared-id rows to the key for the second page.
INSERT INTO help_content (tenant_id, key, audience, locale, short_text, long_md, version, status)
SELECT o.tenant_id, c.new_key, o.audience, o.locale, o.short_text, o.long_md, o.version, o.status
  FROM help_content o
  JOIN (VALUES
  ('admin.evaluations.sent_back', 'admin.evaluations.queue.sent_back'),
  ('admin.attempts.print_review', 'admin.evaluations.detail.print_review'),
  ('admin.assessment.high_stakes.edit', 'admin.evaluations.detail.high_stakes_edit')
  ) AS c(old_key, new_key) ON o.key = c.old_key
ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

-- 2. Drop old rows that already have the new key, then rename the rest.
DELETE FROM help_content o
 USING (VALUES
  ('admin.analytics.cohort_report', 'admin.reports.cohort.report'),
  ('admin.scoring.cohort.percentiles', 'admin.reports.cohort.percentiles'),
  ('admin.scoring.attempt.archetype', 'admin.reports.individual.archetype'),
  ('admin.assessment.results_csv.sort', 'admin.assessments.results_csv.sort'),
  ('admin.assessment.integrity.fullscreen', 'admin.assessments.integrity.fullscreen'),
  ('admin.assessment.integrity.block_copy_paste', 'admin.assessments.integrity.block_copy_paste'),
  ('admin.assessment.high_stakes', 'admin.assessments.high_stakes'),
  ('admin.assessment.high_stakes.edit', 'admin.assessments.high_stakes.edit'),
  ('admin.attempts.awaiting_evaluation', 'admin.attempts.detail.awaiting_evaluation'),
  ('admin.attempts.print_review', 'admin.attempts.detail.print_review'),
  ('admin.attempts.release_button', 'admin.attempts.detail.release_button'),
  ('admin.attempts.section_scores', 'admin.attempts.detail.section_scores'),
  ('admin.attempts.send_back', 'admin.attempts.detail.send_back'),
  ('admin.settings.ai_generate_mode', 'admin.settings.billing.ai_generate_mode'),
  ('admin.evaluations.release_to_company', 'admin.evaluations.detail.release_to_company'),
  ('admin.evaluations.sent_back', 'admin.evaluations.detail.sent_back'),
  ('admin.evaluations.age_badge', 'admin.evaluations.queue.age_badge'),
  ('admin.evaluations.eval_gate', 'admin.evaluations.queue.eval_gate'),
  ('admin.evaluations.evaluate_next', 'admin.evaluations.queue.evaluate_next'),
  ('admin.evaluations.grading_quality', 'admin.evaluations.queue.grading_quality'),
  ('admin.evaluations.queue', 'admin.evaluations.queue.overview'),
  ('admin.evaluations.release_selected', 'admin.evaluations.queue.release_selected'),
  ('admin.evaluations.tenant_filter', 'admin.evaluations.queue.tenant_filter'),
  ('admin.generation_attempts.history', 'admin.gen_score.history'),
  ('admin.packs.create.domain', 'admin.question_bank.list.create.domain'),
  ('admin.questions.attempt_status', 'admin.question_bank.pack.attempt_status'),
  ('admin.users.role', 'admin.users.list.role'),
  ('admin.users.candidate.fields', 'admin.users.list.candidate.fields'),
  ('admin.user.data_export', 'admin.users.list.data_export'),
  ('admin.user.erase', 'admin.users.list.erase')
 ) AS m(old_key, new_key)
 WHERE o.key = m.old_key
   AND EXISTS (
     SELECT 1 FROM help_content n
      WHERE n.key = m.new_key
        AND n.tenant_id IS NOT DISTINCT FROM o.tenant_id
        AND n.locale = o.locale
        AND n.version = o.version
   );

UPDATE help_content o
   SET key = m.new_key
  FROM (VALUES
  ('admin.analytics.cohort_report', 'admin.reports.cohort.report'),
  ('admin.scoring.cohort.percentiles', 'admin.reports.cohort.percentiles'),
  ('admin.scoring.attempt.archetype', 'admin.reports.individual.archetype'),
  ('admin.assessment.results_csv.sort', 'admin.assessments.results_csv.sort'),
  ('admin.assessment.integrity.fullscreen', 'admin.assessments.integrity.fullscreen'),
  ('admin.assessment.integrity.block_copy_paste', 'admin.assessments.integrity.block_copy_paste'),
  ('admin.assessment.high_stakes', 'admin.assessments.high_stakes'),
  ('admin.assessment.high_stakes.edit', 'admin.assessments.high_stakes.edit'),
  ('admin.attempts.awaiting_evaluation', 'admin.attempts.detail.awaiting_evaluation'),
  ('admin.attempts.print_review', 'admin.attempts.detail.print_review'),
  ('admin.attempts.release_button', 'admin.attempts.detail.release_button'),
  ('admin.attempts.section_scores', 'admin.attempts.detail.section_scores'),
  ('admin.attempts.send_back', 'admin.attempts.detail.send_back'),
  ('admin.settings.ai_generate_mode', 'admin.settings.billing.ai_generate_mode'),
  ('admin.evaluations.release_to_company', 'admin.evaluations.detail.release_to_company'),
  ('admin.evaluations.sent_back', 'admin.evaluations.detail.sent_back'),
  ('admin.evaluations.age_badge', 'admin.evaluations.queue.age_badge'),
  ('admin.evaluations.eval_gate', 'admin.evaluations.queue.eval_gate'),
  ('admin.evaluations.evaluate_next', 'admin.evaluations.queue.evaluate_next'),
  ('admin.evaluations.grading_quality', 'admin.evaluations.queue.grading_quality'),
  ('admin.evaluations.queue', 'admin.evaluations.queue.overview'),
  ('admin.evaluations.release_selected', 'admin.evaluations.queue.release_selected'),
  ('admin.evaluations.tenant_filter', 'admin.evaluations.queue.tenant_filter'),
  ('admin.generation_attempts.history', 'admin.gen_score.history'),
  ('admin.packs.create.domain', 'admin.question_bank.list.create.domain'),
  ('admin.questions.attempt_status', 'admin.question_bank.pack.attempt_status'),
  ('admin.users.role', 'admin.users.list.role'),
  ('admin.users.candidate.fields', 'admin.users.list.candidate.fields'),
  ('admin.user.data_export', 'admin.users.list.data_export'),
  ('admin.user.erase', 'admin.users.list.erase')
 ) AS m(old_key, new_key)
 WHERE o.key = m.old_key;
