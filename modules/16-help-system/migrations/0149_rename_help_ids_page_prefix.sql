-- 0149_rename_help_ids_page_prefix.sql
--
-- N20: help ids outside their page prefix never load (the API returns keys
-- LIKE '<helpPage>.%'). Eight keys are renamed so each starts with its page id.
-- Text is unchanged. Keys used by one page only, so rename (no copy).
--
-- Idempotent and correct in both cases:
--   * production: rows exist only under the old key (all tenants/versions) -> UPDATE key.
--   * fresh DB: regenerated 0011 already inserted the new key, older migrations
--     (0108, 0115, 0131, 0145) inserted the old key -> delete the old row when the
--     same (tenant_id, locale, version) exists under the new key, else UPDATE.

DELETE FROM help_content o
 USING (VALUES
  ('admin.settings.company_name',            'admin.tenant_settings.company_name'),
  ('admin.settings.result_release_mode',     'admin.tenant_settings.result_release_mode'),
  ('admin.question.content.numeric',         'admin.question.editor.content.numeric'),
  ('admin.question.content.multi_select',    'admin.question.editor.content.multi_select'),
  ('admin.question.content.ordering',        'admin.question.editor.content.ordering'),
  ('admin.question.ordering.items',          'admin.question.editor.ordering.items'),
  ('admin.question.ordering.scoring',        'admin.question.editor.ordering.scoring'),
  ('admin.questions.type.subjective.rubric', 'admin.question.editor.subjective.rubric')
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
  ('admin.settings.company_name',            'admin.tenant_settings.company_name'),
  ('admin.settings.result_release_mode',     'admin.tenant_settings.result_release_mode'),
  ('admin.question.content.numeric',         'admin.question.editor.content.numeric'),
  ('admin.question.content.multi_select',    'admin.question.editor.content.multi_select'),
  ('admin.question.content.ordering',        'admin.question.editor.content.ordering'),
  ('admin.question.ordering.items',          'admin.question.editor.ordering.items'),
  ('admin.question.ordering.scoring',        'admin.question.editor.ordering.scoring'),
  ('admin.questions.type.subjective.rubric', 'admin.question.editor.subjective.rubric')
 ) AS m(old_key, new_key)
 WHERE o.key = m.old_key;
