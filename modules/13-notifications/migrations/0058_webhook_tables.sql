-- modules/13-notifications/migrations/0058_webhook_tables.sql
-- Phase 3 G3.B — webhook_endpoints + webhook_deliveries tables.
--
-- VERIFICATION RESULT: These tables are defined in docs/02-data-model.md
-- lines 636-658 but NO migration has been run yet (modules/13-notifications/
-- migrations/ directory was empty before this session). This migration creates
-- them now.
--
-- webhook_endpoints: one row per registered destination URL per tenant.
--   - secret_enc: AES-256-GCM ciphertext under ASSESSIQ_MASTER_KEY.
--     Plaintext returned ONCE at create-time; never stored in plaintext.
--   - events: TEXT[] of subscribed event names (e.g. ['attempt.graded']).
--   - requires_fresh_mfa: bool gate for audit.* subscriptions (P3.D16).
--   - name: human-readable label set by admin.
--
-- webhook_deliveries: append-only delivery log per endpoint per event.
--   NEVER UPDATE an existing row. Replays write a NEW row.
--   - status: 'pending' | 'delivered' | 'failed'
--   - http_status: HTTP response status code from the target host.
--   - attempts: incremented on each retry by the job processor.
--   - retry_at: next scheduled retry time (null once delivered or permanently failed).
--
-- WHY append-only deliveries:
--   Delivery history is compliance-adjacent — if an endpoint owner disputes
--   that a webhook was delivered, the original row is the evidence. Replays
--   create a separate row so the original record is never mutated.
--
-- RLS: webhook_endpoints — standard tenant_id-direct.
--       webhook_deliveries — JOIN-based via endpoint_id → webhook_endpoints.
--       The linter's JOIN_RLS_TABLES covers webhook_deliveries.
--
-- Additive: this migration only creates new tables. No existing data touched.

CREATE TABLE webhook_endpoints (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  name               TEXT NOT NULL DEFAULT '',
  url                TEXT NOT NULL,
  secret_enc         BYTEA NOT NULL,
  events             TEXT[] NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  requires_fresh_mfa BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON webhook_endpoints
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert
  ON webhook_endpoints
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------

CREATE TABLE webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id  UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  http_status  INT,
  attempts     INT NOT NULL DEFAULT 0,
  retry_at     TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- JOIN-based RLS: webhook_deliveries has no tenant_id column; tenancy flows
-- through endpoint_id → webhook_endpoints.tenant_id (one-hop EXISTS).
CREATE POLICY tenant_isolation
  ON webhook_deliveries
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM webhook_endpoints e
      WHERE e.id = webhook_deliveries.endpoint_id
        AND e.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert
  ON webhook_deliveries
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM webhook_endpoints e
      WHERE e.id = webhook_deliveries.endpoint_id
        AND e.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

-- Hot path: admin delivery history list by endpoint.
CREATE INDEX webhook_deliveries_endpoint_created_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);

-- Partial index for pending/failed (replay queue surface).
CREATE INDEX webhook_deliveries_pending_failed_idx
  ON webhook_deliveries (endpoint_id, status)
  WHERE status IN ('pending', 'failed');
