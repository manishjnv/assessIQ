-- owned by modules/04-question-bank
-- 0214 (Z-52 gaps 6 and 7): append-only table question_review_notes.
-- WHY: a reviewer's Needs fix / Dispute / Verify / Withdraw note lived only as free text in an audit_log
--   row. Audit rows must hold ids only, and a question page could not show the note. The note now lives
--   here; the audit row carries only the note id. History is kept (EXP-12 disputes need it).
-- author_user_id is a plain UUID with NO foreign key on purpose:
--   * the user purge (modules/03-users/src/purge.ts) keeps the users row as a tombstone and deletes only
--     tables with a cascading FK to users(id); a plain uuid here is never touched by it, so a purge
--     cannot fail on this table (same as audit_log.actor_user_id, which is also kept);
--   * a FK would also break module-local test harnesses that do not create the users table.
-- APPEND-ONLY: RLS has SELECT and INSERT policies only; UPDATE, DELETE and TRUNCATE are revoked from
--   assessiq_app; a trigger rejects every UPDATE, and every DELETE except one by assessiq_system or a
--   superuser. Those two are the tenant purge (modules/02-tenancy/src/purge.ts deletes every table that
--   has a tenant_id column, as assessiq_system) and test or operator cleanup. The question FK cascades so
--   such a delete of a question (also system or superuser only) cannot be blocked by its notes.
-- Not included: no edit or delete of a note, no note on a pack, no backfill of old audit text.
-- Forward-only. Idempotent: IF NOT EXISTS, DROP ... IF EXISTS before CREATE.

CREATE TABLE IF NOT EXISTS question_review_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  question_id    UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  version        INT  NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('in_review', 'verified', 'disputed', 'needs_fix', 'withdrawn')),
  note           TEXT NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  author_user_id UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS question_review_notes_question_idx ON question_review_notes (question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS question_review_notes_tenant_idx   ON question_review_notes (tenant_id);

ALTER TABLE question_review_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_review_notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON question_review_notes;
CREATE POLICY tenant_isolation ON question_review_notes
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON question_review_notes;
CREATE POLICY tenant_isolation_insert ON question_review_notes
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- No UPDATE or DELETE policy: RLS denies both. Do not add one.
REVOKE UPDATE, DELETE, TRUNCATE ON question_review_notes FROM assessiq_app;

CREATE OR REPLACE FUNCTION question_review_notes_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND (current_user = 'assessiq_system'
          OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'question_review_notes is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS question_review_notes_append_only ON question_review_notes;
CREATE TRIGGER question_review_notes_append_only BEFORE UPDATE OR DELETE ON question_review_notes
  FOR EACH ROW EXECUTE FUNCTION question_review_notes_append_only();
