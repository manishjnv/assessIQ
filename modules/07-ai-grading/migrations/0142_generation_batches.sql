-- owned by modules/07-ai-grading
-- E6: server-side durability for question-generation batches.
--
-- WHY: generate-wizard.tsx orchestrates a multi-category batch client-side and
--   kept the plan in localStorage, so a browser/device change lost it, and a tab
--   that died mid-category left the plan unaware of a category the server had
--   finished (resume would duplicate it). This table holds the plan per
--   (tenant, user); admin-generate.ts unions each successfully generated
--   category into completed_category_ids server-side.
--
-- id is the client-minted batchId (same value as generation_attempts.batch_id).
-- Not included: server-side orchestration — the browser still drives categories
--   one by one (single-flight AI mutex + Cloudflare 100 s timeout).
--
-- Standard tenant_id-bearing RLS variant (mirrors 0042_generation_attempts.sql);
-- USING doubles as the UPDATE check.

CREATE TABLE generation_batches (
  id                     UUID        NOT NULL PRIMARY KEY,
  tenant_id              UUID        NOT NULL REFERENCES tenants(id),
  user_id                UUID        NOT NULL REFERENCES users(id),
  domain_id              UUID,
  level                  TEXT,
  categories             JSONB       NOT NULL,
  completed_category_ids JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status                 TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'done', 'dismissed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX generation_batches_user_status_idx
  ON generation_batches (tenant_id, user_id, status, updated_at DESC);

ALTER TABLE generation_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON generation_batches
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON generation_batches
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
