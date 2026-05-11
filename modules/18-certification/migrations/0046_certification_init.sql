-- modules/18-certification/migrations/0046_certification_init.sql
-- Phase 5 Session 1 — initial schema for the certificates table.
--
-- PURPOSE:
--   Stores tamper-evident course-completion credential records.
--   Each row is a point-in-time snapshot of what was true at issuance.
--   Profile or score changes after issuance do NOT retro-update certificates.
--   See docs/CERTIFICATION_PLAN_GENERIC.md §1.1 and modules/18-certification/SKILL.md.
--
-- DESIGN DECISIONS (adapted from the project-agnostic plan):
--
--   1. PK is UUID (gen_random_uuid()) — consistent with all other AssessIQ tables.
--      The plan's "int PK" is project-agnostic; AssessIQ uses UUIDs per
--      docs/02-data-model.md conventions.
--
--   2. `attempt_id` replaces the plan's `enrollment_id`.
--      An `attempt` is the concrete completed entity in AssessIQ (module 06).
--      There is no separate `enrollment` or `assessment_cycle` table.
--      UNIQUE(tenant_id, candidate_id, attempt_id) gives per-attempt idempotence.
--
--   3. `candidate_id` replaces the plan's `user_id`.
--      Matches 03-users naming convention (users.role = 'candidate').
--
--   4. tenant_id is NOT NULL + FK + RLS — multi-tenancy hard rule (CLAUDE.md #4).
--      RLS policy uses the standard AssessIQ pattern:
--        current_setting('app.current_tenant', true)::uuid
--
--   5. `credential_id` is globally UNIQUE (not tenant-scoped) — it is a public
--      slug used in QR codes and LinkedIn share URLs; it must be unique across
--      all tenants so a recruiter can look it up without knowing the tenant.
--
--   6. Counters (pdf_downloads, linkedin_shares, verification_views) are
--      non-critical analytics. UPDATE col = col + 1 (server-side arithmetic)
--      is the safe increment pattern; application code must NOT do
--      read-modify-write on these columns.
--
-- APPLY ORDER:
--   This migration depends on: tenants (0001), users (020_users).
--   It must run AFTER both of those migrations.
--   It must run BEFORE any session that references the certificates table.
--
-- DO NOT APPLY against any database in Phase 5 Session 1.
-- Migration application is a deploy step for Phase 5 Session 2 per
-- CLAUDE.md rule #8 (shared-VPS, additive-only, enumerate-before-touch).

-- ---------------------------------------------------------------------------
-- Main table
-- ---------------------------------------------------------------------------

CREATE TABLE certificates (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenancy (hard rule CLAUDE.md #4 — never nullable)
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- The attempt this cert is issued for (replaces plan's enrollment_id).
  -- CASCADE DELETE: if the attempt is purged (GDPR erasure), cert is too.
  attempt_id       UUID        NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,

  -- The candidate who earned this cert (replaces plan's user_id).
  -- SET NULL on user delete so the historical cert record is preserved even
  -- if the user account is removed (recruiter verify page still shows the cert
  -- with the snapshotted display_name).
  candidate_id     UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Denormalised template key (survives template renames).
  template_key     TEXT        NOT NULL,

  -- Public-facing slug (PREFIX-YYYY-MM-XXXXXX). Globally unique (not tenant-scoped).
  -- Generation: CSPRNG 6-char suffix, retry on IntegrityError (max 3 attempts).
  -- Stored and queried in UPPERCASE; verify page normalises input to upper.
  credential_id    TEXT        NOT NULL,

  -- Tier at last upgrade. Upgrades only (never downgrade).
  tier             TEXT        NOT NULL CHECK (tier IN ('completion', 'distinction', 'honors')),

  -- Snapshotted fields — frozen at issuance, not updated by profile changes.
  display_name     TEXT        NOT NULL,   -- from users.name at issuance time
  course_title     TEXT        NOT NULL,   -- from assessments.name at issuance time
  level            TEXT        NOT NULL,   -- level label (e.g. "L1", "Foundation")

  -- Tamper-evidence: HMAC-SHA256 over (credential_id | candidate_id | issued_at).
  -- Signed payload excludes mutable fields (tier, counters) so tier upgrades
  -- do not invalidate already-shared LinkedIn URLs. See plan §3.
  signed_hash      TEXT        NOT NULL,

  -- Preserved through tier upgrades — rotating these breaks HMAC + shared URLs.
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Revocation (soft — cert remains visible on verify page with red badge).
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT        CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 1000),

  -- Non-critical analytics counters. Use server-side arithmetic for increments.
  pdf_downloads      INT NOT NULL DEFAULT 0,
  linkedin_shares    INT NOT NULL DEFAULT 0,
  verification_views INT NOT NULL DEFAULT 0,

  -- Standard AssessIQ timestamps.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Unique constraints
-- ---------------------------------------------------------------------------

-- One cert per (tenant, candidate, attempt) — idempotent issuance hard guard.
-- The application-level check is a fast path; this constraint is the truth
-- for concurrent requests. (plan §13 "Database constraint > application check")
ALTER TABLE certificates
  ADD CONSTRAINT certificates_tenant_candidate_attempt_uniq
  UNIQUE (tenant_id, candidate_id, attempt_id);

-- Globally unique public slug (not tenant-scoped — recruiters look up without
-- knowing which tenant issued the cert).
ALTER TABLE certificates
  ADD CONSTRAINT certificates_credential_id_key
  UNIQUE (credential_id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Hot read: list certs for a candidate (My Certificates view).
-- Covers both admin list (tenant_id, candidate_id) and individual lookup.
CREATE INDEX certificates_candidate_idx
  ON certificates (tenant_id, candidate_id);

-- Hot read: verify page lookup by public slug (O(1) via UNIQUE index above,
-- but an explicit named index makes EXPLAIN output clearer).
CREATE INDEX certificates_credential_id_idx
  ON certificates (credential_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;

-- SELECT: each tenant sees only its own rows.
-- Standard AssessIQ RLS pattern (same as audit_log, attempts, etc.).
CREATE POLICY tenant_isolation ON certificates
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: new rows must belong to the current tenant.
CREATE POLICY tenant_isolation_insert ON certificates
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- UPDATE: tenant-scoped (tier upgrades, revocations, counter increments).
CREATE POLICY tenant_isolation_update ON certificates
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- NOTE: no DELETE policy — RLS denies DELETE by default.
-- Certificates are never hard-deleted by application code.
-- GDPR erasure (if needed) goes through assessiq_system role with explicit
-- written authorisation (same procedure as audit_log).

-- ---------------------------------------------------------------------------
-- NOTE: verify-page endpoint (GET /verify/:credentialId) is a PUBLIC lookup
-- that must bypass tenant RLS. Implementation in Phase 5 Session 3 will use
-- a dedicated DB query with assessiq_system role or a SECURITY DEFINER
-- function to fetch by credential_id without a tenant GUC set.
-- Do NOT add a permissive "all tenants can read" policy here — that would
-- break tenant isolation for the admin list and candidate views.
-- ---------------------------------------------------------------------------
