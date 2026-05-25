-- owned by modules/04-question-bank
-- 0095_backfill_clone_question_versions.sql
--
-- Backfills question_versions for CLONED questions that have none, and restores
-- the version invariant on them.
--
-- BACKGROUND: clonePackToTenant historically inserted each cloned question with
-- version=1 and NO question_versions snapshot. The attempt-start question pool
-- (modules/06-attempt-engine listActiveQuestionPoolForPick) INNER JOINs
-- question_versions, so cloned questions were silently EXCLUDED — a candidate
-- could not start an attempt on a cloned-pack assessment. This never surfaced in
-- prod because cloned-pack assessments had not run end-to-end (licensed pickers
-- empty / platform packs draft). clone.ts is fixed forward (now writes a v1
-- snapshot + version=2, mirroring publishPack's end-state); this migration
-- repairs pre-existing clones.
--
-- INVARIANT restored: questions.version = MAX(question_versions.version) + 1.
-- publishPack/updateQuestion snapshot-then-bump rely on it; without it a later
-- updateQuestion on a cloned question would collide on UNIQUE(question_id,version).
--
-- Idempotent: the INSERT is guarded by NOT EXISTS; the UPDATE only touches clone
-- questions still at version=1 whose max snapshot is 1. A second run is a no-op.
-- Scoped to CLONE packs (question_packs.source_pack_id IS NOT NULL) so it never
-- touches platform-authored or tenant-authored version histories.

-- 1) v1 content snapshot for every clone-pack question lacking any snapshot.
INSERT INTO question_versions (id, question_id, version, content, rubric, saved_by)
SELECT gen_random_uuid(), q.id, 1, q.content, q.rubric, q.created_by
  FROM questions q
  JOIN question_packs p ON p.id = q.pack_id
 WHERE p.source_pack_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM question_versions qv WHERE qv.question_id = q.id);

-- 2) Restore version = MAX(qv)+1 = 2 for the repaired clone questions.
UPDATE questions q
   SET version = 2, updated_at = now()
  FROM question_packs p
 WHERE p.id = q.pack_id
   AND p.source_pack_id IS NOT NULL
   AND q.version = 1
   AND (SELECT MAX(qv.version) FROM question_versions qv WHERE qv.question_id = q.id) = 1;
