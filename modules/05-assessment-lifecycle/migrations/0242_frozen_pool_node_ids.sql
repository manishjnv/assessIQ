-- FUT-8: record the taxonomy node ids of each question in the frozen pool, so draws and
-- reports can group by taxonomy_nodes (shared NULL-tenant rows) and not by tenant
-- domain_id / category_id. Column on an existing table; RLS is unchanged.
-- Old frozen rows get '{}' (= no node data): readers fall back to the old category/domain path.
-- Forward-only, idempotent. Not included: backfill, dropping domain_id / category_id.
ALTER TABLE assessment_frozen_pool
  ADD COLUMN IF NOT EXISTS node_ids uuid[] NOT NULL DEFAULT '{}';
