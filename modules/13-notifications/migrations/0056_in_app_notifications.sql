-- modules/13-notifications/migrations/0056_in_app_notifications.sql
-- Phase 3 G3.B — in-app notification store.
--
-- Written by the in-app service (modules/13-notifications/src/in-app/service.ts).
-- Read via short-poll GET /api/admin/notifications?since=<cursor> (P3.D13).
-- NO WebSocket / SSE — deferred to Phase 4 per P3.D13.
--
-- Audience model (P3.D13):
--   'user'  — targeted at a specific user_id.
--   'role'  — broadcast to all users matching 'role' column within the tenant.
--   'all'   — broadcast to every user in the tenant.
--
-- WHY short-poll not WebSocket:
--   Phase 3 is a single VPS with a single Fastify process. SSE/WS would require
--   sticky sessions or a Redis pub-sub fan-out layer; the short-poll cursor
--   pattern scales horizontally with zero infra changes and is simpler to test.
--   Phase 4 can swap in SSE on the same DB shape without a migration.
--
-- WHAT is NOT included:
--   - Per-user notification preferences (Phase 4).
--   - Push notifications (Phase 4).
--   - Expiry / TTL cleanup (Phase 4 — manual or cron).
--   - Rich payload JSONB column (Phase 4 if needed).
--
-- RLS: standard tenant_id-direct variant.

CREATE TABLE in_app_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  audience    TEXT NOT NULL CHECK (audience IN ('user', 'role', 'all')),
  user_id     UUID REFERENCES users(id),
  role        TEXT CHECK (role IN ('admin', 'reviewer')),
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE in_app_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON in_app_notifications
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert
  ON in_app_notifications
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Partial index for the short-poll query: unread notifications per tenant+audience.
-- Filters to read_at IS NULL to keep the index small as notifications are read.
CREATE INDEX in_app_notifications_unread_idx
  ON in_app_notifications (tenant_id, audience, created_at DESC)
  WHERE read_at IS NULL;
