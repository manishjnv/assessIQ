-- EXAM-STYLE: an exam pattern can carry one house style (neutral, ssc, bank, rrb, campus).
-- The style is a platform taxonomy node of framework 'exam-style' (seeded as data, src/frameworks/exam-style.json).
-- compilePatternSections copies it into every compiled section; the draw and the publish pre-flight then keep a
-- styled section to items of its own style or no style, and an unstyled section to items with no style.
-- Additive, nullable, no backfill: existing patterns stay unstyled. exam_blueprints has no tenant_id; RLS is unchanged
-- (platform_read, no tenant write policy). Forward-only, idempotent.
ALTER TABLE exam_blueprints
  ADD COLUMN IF NOT EXISTS style_node_id uuid REFERENCES taxonomy_nodes(id) ON DELETE SET NULL;
