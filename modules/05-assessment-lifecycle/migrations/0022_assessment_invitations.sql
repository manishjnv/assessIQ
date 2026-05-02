-- owned by modules/05-assessment-lifecycle
-- Phase 1 G1.B Session 3 — assessment_invitations table.
--
-- One row per (assessment, user) pairing. Plaintext invitation token is
-- generated at issuance time, sha256-hashed into `token_hash`, and the
-- plaintext goes only into the candidate email body — never logged, never
-- stored. Status drives the candidate-side flow (pending → viewed → started
-- → submitted) and admin revocation (→ expired).
--
-- WHY current_setting(..., true): see 0021_assessments.sql header.
--
-- WHY JOIN-based RLS (no tenant_id column):
--   `assessment_invitations` is a child of `assessments` and carries no
--   `tenant_id` column of its own — tenancy is fully derived through the
--   `assessment_id` foreign key. A direct `tenant_id = current_setting(...)`
--   predicate is therefore impossible. Both RLS policies use an EXISTS
--   sub-select that joins back to `assessments` and checks `a.tenant_id`,
--   giving the same fail-closed guarantee: if `app.current_tenant` is unset,
--   `a.tenant_id = NULL` is FALSE and zero rows are visible or insertable.
--   The linter (`tools/lint-rls-policies.ts`) protects this contract:
--   `assessment_invitations` is now in `JOIN_RLS_TABLES`.
--
-- WHY token_hash is UNIQUE (and not just indexed):
--   The candidate-accept flow looks up an invitation by sha256(plaintext) at
--   request time. UNIQUE collapses two concerns into one constraint: (a)
--   collision detection during issuance (vanishingly improbable with 32 bytes
--   of CSPRNG output, but cheap to assert), and (b) a covering index for the
--   accept lookup.
--
-- WHY (assessment_id, user_id) UNIQUE:
--   v1 caps to one invitation per user per assessment per docs/05-pipeline-
--   not-yet-written. Re-inviting a user whose previous invitation was revoked
--   produces a UNIQUE violation that the service layer translates to a
--   friendly INVITATION_EXISTS error (re-issuance is a separate flow that
--   can rotate the token_hash on the existing row).

CREATE TABLE assessment_invitations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','viewed','started','submitted','expired')),
  invited_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id)
);

-- listInvitations(assessmentId, { status? }) — common admin query.
CREATE INDEX assessment_invitations_assessment_status_idx
  ON assessment_invitations (assessment_id, status);

-- Candidate-side query: "what assessments have I been invited to?"
CREATE INDEX assessment_invitations_user_idx
  ON assessment_invitations (user_id, status);

ALTER TABLE assessment_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON assessment_invitations
  USING (
    EXISTS (
      SELECT 1 FROM assessments a
      WHERE a.id = assessment_invitations.assessment_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );

CREATE POLICY tenant_isolation_insert ON assessment_invitations
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM assessments a
      WHERE a.id = assessment_invitations.assessment_id
        AND a.tenant_id = current_setting('app.current_tenant', true)::uuid
    )
  );
