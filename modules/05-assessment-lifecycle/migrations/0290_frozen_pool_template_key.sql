-- owned by modules/05-assessment-lifecycle
-- 0290 - EXP-24: freeze the generator template key with the frozen pool row.
-- WHY  a generated test may hold at most ONE item per template. The key is the part of
--      question_source.seed_ref before '@' (format '<template_id>@<version>:seed=..'), so v1 and v2 of one
--      template share a key. Frozen draws read it here, with no join (pattern of 0242 and 0267).
-- NULL = no key (human, AI verbal, legacy): such items are not limited.
-- Backfill: existing frozen rows get the key the question has now (best information left, as in 0267).
-- Not included: any change to the draw itself (module 06) or to scoring. Column on an existing table; RLS unchanged. Forward-only.
ALTER TABLE assessment_frozen_pool ADD COLUMN IF NOT EXISTS template_key text NULL;

UPDATE assessment_frozen_pool fp
   SET template_key = NULLIF(split_part(qs.seed_ref, '@', 1), '')
  FROM question_source qs
 WHERE qs.question_id = fp.question_id AND fp.template_key IS NULL AND qs.seed_ref IS NOT NULL;
