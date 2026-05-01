-- owned by modules/04-question-bank
-- Defense-in-depth FK: enforce that questions.level_id belongs to a level
-- whose pack_id matches questions.pack_id, at the DB layer rather than only
-- at the service layer.
--
-- Threat model (codex/sonnet rescue 2026-05-01, seam 3 must-fix #1):
--   The single-column FK in 0012_questions.sql (`level_id UUID REFERENCES levels(id)`)
--   guarantees level_id refers to A level — but not THIS pack's level. A
--   malicious admin in tenant A could craft a createQuestion call with
--   pack_id = tenant-A-pack and level_id = tenant-B-pack-level. Today the
--   service-layer findLevelById is RLS-scoped and returns null for tenant B's
--   level under tenant A's GUC, so service.createQuestion throws
--   NotFoundError(LEVEL_NOT_FOUND) BEFORE the INSERT runs. The DB itself
--   would accept the row if the service guard were ever bypassed (direct
--   psql, future refactor that drops the guard, migration script). The
--   composite FK below makes the constraint structural, not procedural.
--
-- Approach:
--   1. Add UNIQUE (id, pack_id) on levels — required for the composite FK
--      target. id is already PRIMARY KEY so the constraint is logically
--      redundant but Postgres requires an exact unique-or-PK match.
--   2. Add composite FK questions(level_id, pack_id) → levels(id, pack_id).
--   3. Drop the old single-column FK questions.level_id → levels.id —
--      superseded by the composite which still guarantees level_id refers
--      to a real level (via the tuple).
--
-- Pre-flight integrity check via DO block: if any existing questions row
-- already violates the new constraint (shouldn't happen in Phase 1 fresh
-- bootstrap, but defensive against test-data residue), abort the migration
-- with a clear error rather than letting ALTER fail with a generic
-- "violates foreign key constraint" message.

DO $$
DECLARE
  inconsistent_count INT;
BEGIN
  SELECT count(*) INTO inconsistent_count
    FROM questions q
   WHERE NOT EXISTS (
     SELECT 1 FROM levels l
      WHERE l.id = q.level_id
        AND l.pack_id = q.pack_id
   );
  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add composite FK: % existing question rows have level_id not belonging to pack_id. Investigate before re-running the migration.',
      inconsistent_count;
  END IF;
END $$;

ALTER TABLE levels
  ADD CONSTRAINT levels_id_pack_unique UNIQUE (id, pack_id);

ALTER TABLE questions
  ADD CONSTRAINT questions_level_pack_fk
  FOREIGN KEY (level_id, pack_id) REFERENCES levels(id, pack_id);

-- Drop the old single-column FK — superseded. The constraint name is
-- Postgres' default for an inline column FK: <table>_<column>_fkey.
ALTER TABLE questions DROP CONSTRAINT questions_level_id_fkey;
