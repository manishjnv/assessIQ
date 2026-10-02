-- owned by modules/06-attempt-engine
-- 0150 — N22: partial index for the tenant dashboard KPI count.
--
-- Reader: countGradingQueue (modules/07-ai-grading/src/repository.ts), polled
-- every 30 s by the tenant dashboard. It counts the attempts of one tenant
-- (RLS adds tenant_id = app.current_tenant) with a status that waits for
-- evaluation or for publishing.
--
-- The WHERE clause is the same status list as that query. Attempts that are
-- 'released' (published to the student) or still in progress leave the index,
-- so it stays small when a tenant has a long history. evaluation_released_at
-- is INCLUDEd so the three FILTER counts can use an index-only scan.
--
-- KEEP IN SYNC with the status list in countGradingQueue. If the list there
-- changes, the planner stops using this index (no wrong result, only a slower
-- count).
--
-- Plain CREATE INDEX (short lock): the attempts table is small today. For a
-- large table, build it by hand with CREATE INDEX CONCURRENTLY outside a
-- transaction instead.

CREATE INDEX IF NOT EXISTS attempts_dashboard_count_idx
  ON attempts (tenant_id, status) INCLUDE (evaluation_released_at)
  WHERE status IN ('submitted', 'auto_submitted', 'pending_admin_grading', 'graded');
