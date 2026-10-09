-- 0162_seed_evaluations_ai_paused_help.sql
--
-- FU-A11 (2026-10-09): NEW admin.evaluations.queue.ai_paused (the "AI paused"
-- chip on the platform evaluation queue). Mirrors content/en/admin.yml.
-- Idempotent INSERT ... ON CONFLICT DO NOTHING; 0011 regenerated in the same commit.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.queue.ai_paused', 'admin', 'en',
  'The company turned AI evaluation off. Its attempts stay here, but Grade and Re-run AI are refused.',
  $$## AI paused

A company can turn AI evaluation off in its settings (`ai_grading_enabled`).
Its attempts still appear in this list so nothing is lost, marked
**AI paused**. **Evaluate next** skips them.

On such an attempt, **Grade all** and **Re-run AI** answer an error. You can
still enter a manual score or override a grade. When the company turns the
flag on again, the marker goes away and AI evaluation works as usual.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
