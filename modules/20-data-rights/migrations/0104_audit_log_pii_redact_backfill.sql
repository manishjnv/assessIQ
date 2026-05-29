-- modules/20-data-rights/migrations/0104_audit_log_pii_redact_backfill.sql
-- Module 20 S1 — One-shot PII redaction of historical audit_log rows.
--
-- =========================================================================
-- LOAD-BEARING — APPEND-ONLY EXCEPTION — codex:rescue ADVERSARIAL SIGN-OFF
-- COMPLETE: codex:rescue verdict 2026-05-29 = REVISE -> applied (recursive
-- walker replacing targeted approach to cover nested JSONB shapes).
-- =========================================================================
--
-- PURPOSE:
--   Backfill-redact PII fields embedded in shipped audit_log rows that
--   pre-date the forward-protection extension to redact.ts (this S1).
--   D7 audit (Haiku, 2026-05-29) confirmed:
--     - HIGH: modules/01-auth/src/candidate-login.ts:246 wrote candidate
--             plaintext email to after.email on every
--             'auth.candidate.login_link_requested' action.
--     - MED:  modules/03-users/src/invitations.ts:135, :187, :308 wrote
--             admin/reviewer email to user.invited / user.invitation_cancelled.
--
-- WHY RECURSIVE (codex:rescue revision V1):
--   The initial draft used targeted-by-action UPDATEs with a top-level
--   `jsonb_set(after, '{email}', ...)` safety net. Codex:rescue flagged
--   that historical payloads may contain nested PII shapes such as
--   `after.metadata.email` or `after.filters.candidate_email` that the
--   top-level-only updates miss. This revision replaces the targeted
--   approach with a single recursive walker that redacts every PII key
--   at every JSONB depth, applied to every audit_log row's before+after.
--   Strictly more correct than the targeted approach; idempotence is
--   preserved (redacting an already-`[REDACTED]` value re-stamps the
--   same string; no observable change).
--
-- WHY THIS IS THE APPEND-ONLY EXCEPTION (the only one this module ever
-- introduces — pinned here so future sessions do not re-litigate):
--   audit_log is REVOKE'd UPDATE/DELETE/TRUNCATE from assessiq_app per
--   modules/14-audit-log/migrations/0050_audit_log.sql § 86–95. The
--   IRREVERSIBILITY NOTE in 0050 documents the lawful exception path:
--   connect as assessiq_system (BYPASSRLS) and act once. Migrations run
--   as the system role, which is NOT subject to the REVOKE; that is the
--   documented exception path. The corresponding RCA / SKILL.md
--   requirement is satisfied by:
--     - codex:rescue adversarial review verdict (REVISE -> revised, then
--       accepted via this file's recursive walker).
--     - SESSION_STATE handoff documenting verdict + revision.
--     - RCA_LOG entry recording symptom (D7 finding), cause, fix.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   It does NOT add an UPDATE policy to audit_log RLS. It does NOT grant
--   UPDATE to assessiq_app. The append-only posture for the application
--   role is preserved. Only the migration runner (system role) acts here,
--   exactly once, on historical rows.
--
-- IDEMPOTENCY:
--   The recursive walker re-redacts already-`[REDACTED]` strings to the
--   same value; running twice is a no-op. The function is created with
--   CREATE OR REPLACE and dropped at the end of the migration.
--
-- PERFORMANCE:
--   D7 estimated ~100-1500 historical rows across all tenants. Even at
--   100K rows, the recursive walker over JSONB completes in seconds.

-- -------------------------------------------------------------------------
-- Temporary recursive PII redactor.
-- -------------------------------------------------------------------------
-- Key list mirrors the redact.ts SENSITIVE_FIELD_PATTERNS PII subset
-- (lines added 2026-05-29). Keep in sync if either side changes.
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION redact_pii_jsonb_migration_0104(input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  k        TEXT;
  v        JSONB;
  result   JSONB;
  k_lower  TEXT;
  pii_keys TEXT[] := ARRAY[
    'email', 'name', 'display_name', 'displayname', 'full_name', 'fullname',
    'phone', 'phone_number', 'phonenumber', 'phone_number_e164',
    'mobile', 'whatsapp', 'whats_app',
    'linkedin_url', 'linkedinurl', 'resume_url', 'resumeurl',
    'answer_text', 'answertext', 'candidate_answer', 'candidateanswer',
    'candidate_answer_text', 'candidateanswertext',
    'feedback_text', 'feedbacktext', 'comment_text', 'commenttext',
    'notes_text', 'notestext',
    'ip', 'ip_address', 'ipaddress',
    'user_agent', 'useragent'
  ];
  pii_suffix_re TEXT := '(_email|_name|_phone|_ip|_user_agent|_useragent|_text)$';
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(input) = 'object' THEN
    result := input;
    FOR k, v IN SELECT key, value FROM jsonb_each(input) LOOP
      k_lower := lower(k);
      IF k_lower = ANY(pii_keys) OR k_lower ~ pii_suffix_re THEN
        result := jsonb_set(result, ARRAY[k], '"[REDACTED]"'::jsonb, false);
      ELSIF jsonb_typeof(v) IN ('object', 'array') THEN
        result := jsonb_set(result, ARRAY[k], redact_pii_jsonb_migration_0104(v), false);
      END IF;
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(input) = 'array' THEN
    RETURN (
      SELECT COALESCE(jsonb_agg(redact_pii_jsonb_migration_0104(elem)), '[]'::jsonb)
        FROM jsonb_array_elements(input) elem
    );
  ELSE
    -- primitive (string / number / bool / null) — return unchanged
    RETURN input;
  END IF;
END;
$$;

-- -------------------------------------------------------------------------
-- Apply the recursive walker over every audit_log row that has any
-- before/after content. Skipping rows where both are NULL is a small
-- optimization that does not affect correctness.
-- -------------------------------------------------------------------------

UPDATE audit_log
   SET before = redact_pii_jsonb_migration_0104(before),
       after  = redact_pii_jsonb_migration_0104(after)
 WHERE before IS NOT NULL OR after IS NOT NULL;

-- -------------------------------------------------------------------------
-- Drop the temporary function. It must not persist past this migration.
-- -------------------------------------------------------------------------

DROP FUNCTION redact_pii_jsonb_migration_0104(JSONB);

-- -------------------------------------------------------------------------
-- Verification (post-apply, manual):
--   The forward-protection in modules/14-audit-log/src/redact.ts ensures
--   every future write is redacted. Spot-check that no top-level PII
--   leaked through this backfill:
--
--     SELECT COUNT(*) FROM audit_log
--      WHERE after->>'email'        IS NOT NULL AND after->>'email'        != '[REDACTED]';
--     SELECT COUNT(*) FROM audit_log
--      WHERE before->>'email'       IS NOT NULL AND before->>'email'       != '[REDACTED]';
--     SELECT COUNT(*) FROM audit_log
--      WHERE after->>'name'         IS NOT NULL AND after->>'name'         != '[REDACTED]'
--        AND after->>'name' NOT LIKE 'deleted_user_%';
--
--   Expected: 0 across all three. If non-zero, investigate the leaked
--   row before treating S1 as complete. Re-running this migration is
--   safe (idempotent — see PERFORMANCE / IDEMPOTENCY notes above).
--
-- Note on event-record evidence: the codex:rescue revision chose to KEEP
-- the maintenance-event INSERT OUT of this migration. The lower-risk
-- path is runbook / deploy-log evidence + the SESSION_STATE handoff +
-- the RCA_LOG entry. Adding a one-off `system.maintenance` action to the
-- audit subsystem during a redaction migration is extra behavior in the
-- exact subsystem being modified.
