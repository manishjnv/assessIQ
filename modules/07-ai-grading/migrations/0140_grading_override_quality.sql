-- owned by modules/07-ai-grading
-- 0140 — grading_override_quality: each admin override paired with the AI grade it
-- replaced, so "how often and by how much do humans disagree with prompt version X"
-- is a plain query (E2 Part 2, 2026-10-02).
--
-- No new table and no new column: D8 already INSERTs an override row
-- (grader='admin_override', override_of = original AI row, override_reason) and keeps
-- the original, so this is only a join. security_invoker = true makes the view run
-- with the CALLER's privileges, so gradings' tenant_isolation RLS applies to a tenant
-- connection; the super-admin read uses the BYPASSRLS assessiq_system role (read-only
-- tx, see handlers/super-grading-quality.ts) for the cross-tenant aggregate.
--
-- Only overrides of an AI row are paired (orig.grader = 'ai'): that is the quality
-- signal for a prompt version. The override row inherits prompt_version_sha / model
-- from the original (D4), so the original's values are exposed under original_*.
-- No candidate answer text is exposed — only ids, bands and scores — and
-- override_reason is free text admin input, so consumers must not export it publicly.

CREATE OR REPLACE VIEW grading_override_quality
WITH (security_invoker = true) AS
SELECT
  o.tenant_id,
  o.attempt_id,
  o.question_id,
  orig.id                   AS original_grading_id,
  o.id                      AS override_grading_id,
  orig.prompt_version_sha   AS original_prompt_version_sha,
  orig.model                AS original_model,
  orig.reasoning_band       AS original_reasoning_band,
  orig.score_earned         AS original_score_earned,
  o.score_max               AS score_max,
  o.reasoning_band          AS override_reasoning_band,
  o.score_earned            AS override_score_earned,
  o.override_reason         AS override_reason,
  o.graded_at               AS override_created_at
FROM gradings o
JOIN gradings orig ON orig.id = o.override_of
WHERE o.grader = 'admin_override'
  AND orig.grader = 'ai';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_app') THEN
    GRANT SELECT ON grading_override_quality TO assessiq_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assessiq_system') THEN
    GRANT SELECT ON grading_override_quality TO assessiq_system;
  END IF;
END $$;
