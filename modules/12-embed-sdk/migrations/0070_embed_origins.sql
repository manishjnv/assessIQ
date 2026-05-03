-- Phase 4: add embed_origins to tenants for postMessage origin verification (D2, D8).
-- Spec: modules/12-embed-sdk/SKILL.md § Decisions captured (2026-05-03) D2, D8.
-- docs/02-data-model.md § Tenancy (tenants table) needs a same-PR update.
--
-- RLS note: tenants uses special-cased RLS (id = current_setting('app.current_tenant')::uuid).
-- This migration adds only a column + index — no new RLS policy needed; the existing
-- tenant-row policy covers the new column automatically.

ALTER TABLE tenants
  ADD COLUMN embed_origins TEXT[] NOT NULL DEFAULT '{}';

-- GIN index for @> / <@ array containment operators (origin lookup).
CREATE INDEX tenants_embed_origins_gin_idx ON tenants USING GIN (embed_origins);
