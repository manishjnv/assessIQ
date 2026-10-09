-- 0164_seed_evaluations_runtime_status_help.sql
--
-- RW-9 (2026-10-09): NEW admin.evaluations.queue.runtime_status (the AI runtime
-- status chip on the platform evaluation queue; data from GET /api/ready).
-- Mirrors content/en/admin.yml. Idempotent INSERT ... ON CONFLICT DO NOTHING;
-- 0011 is not regenerated.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(), NULL,
  'admin.evaluations.queue.runtime_status', 'admin', 'en',
  'Shows whether the AI runtime is ready: database, Redis and the Claude command.',
  $$## AI runtime status

This chip shows whether the server can run AI evaluation now. It runs
three checks:

- **db.** The database answers a test query.
- **redis.** Redis answers a ping.
- **claude.** The Claude command runs on the server.

**AI runtime ready** means all three pass. **Not ready** lists the checks
that failed. The chip checks once when the page loads. Reload the page to
check again.
$$,
  1, 'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
