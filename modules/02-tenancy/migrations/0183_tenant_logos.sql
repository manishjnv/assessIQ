-- owned by modules/02-tenancy
-- Logo phase L1 (2026-10-16): one PNG/JPEG logo per tenant, stored as BYTEA.
--
-- WHY BYTEA in Postgres: max 512 KB, one row per tenant, no object store to run or back up
--   separately; the public GET serves it with an immutable cache keyed by sha256.
-- WHY CHECKs on mime/size/dimensions: the API validates first; the DB is the last line.
-- WHY PK = tenant_id: exactly one logo per tenant; replace is an upsert.
-- Not included: UI, emails, PDF, certificates (logo phases L2-L4); SVG/GIF/WebP are refused.
-- Standard tenant_id-bearing RLS variant (mirrors 0174 question_imports).

CREATE TABLE tenant_logos (
  tenant_id  UUID        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mime       TEXT        NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes      BYTEA       NOT NULL,
  sha256     TEXT        NOT NULL,
  width      INT         NOT NULL CHECK (width BETWEEN 32 AND 2048),
  height     INT         NOT NULL CHECK (height BETWEEN 32 AND 2048),
  byte_size  INT         NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  updated_by UUID        NULL,  -- actor user id; no FK on purpose: 02 migrations must not depend on 03 (module-local test harnesses apply 02 before 020_users). The audit row holds the actor too.
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenant_logos ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_logos
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_logos
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

COMMENT ON TABLE tenant_logos IS 'One PNG/JPEG logo per tenant (max 512 KB). Served publicly by GET /api/public/tenant-logo/:tenantId.';
