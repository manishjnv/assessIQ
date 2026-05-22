-- owned by modules/04-question-bank
-- Step 2 hardening (adversarial review finding #10) — prevent duplicate clones
-- of the same platform source pack within a tenant under concurrent clone-on-use.
-- See docs/design/question-set-sharing-clone-on-grant.md.
--
-- WHY:
--   materializeSetForTenant has an idempotency SELECT ("does this tenant already
--   have a clone of source S?") but, without serialization, a concurrent burst
--   of POST /api/admin/assessments/from-set for the same (tenant, source) could
--   have two transactions both observe "no clone" and both INSERT — duplicating
--   the cloned pack. Blast radius is the tenant's OWN data (no cross-tenant leak),
--   but duplicates are a correctness/accounting defect.
--
--   This partial UNIQUE index makes at most one clone of a given source per
--   tenant a STRUCTURAL guarantee. Paired with the pg_advisory_xact_lock in
--   materializeSetForTenant (clone.ts) — which serializes per (tenant, source) so
--   the second caller sees the first's committed clone via the idempotency SELECT
--   and returns early — the index is the backstop against any unlocked path.
--
--   Replaces the non-unique question_packs_source_idx from 0084 (the unique index
--   serves the same lookups, so we drop the redundant one).
--
-- SAFE TO APPLY: source_pack_id is NULL on all originals and there are no clones
--   yet, so the partial index builds with zero rows in its predicate set.
-- Idempotent: DROP IF EXISTS + CREATE ... IF NOT EXISTS.

DROP INDEX IF EXISTS question_packs_source_idx;

CREATE UNIQUE INDEX IF NOT EXISTS question_packs_tenant_source_uniq
  ON question_packs (tenant_id, source_pack_id)
  WHERE source_pack_id IS NOT NULL;
