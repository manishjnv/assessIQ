-- 0089_seed_gen_score_help.sql
--
-- Forward seed for the four `admin.gen_score.*` help keys that back the
-- generation scorecard tooltips on the Generation History page
-- (modules/10-admin-dashboard/src/pages/generation-attempts.tsx).
--
-- WHY a separate migration instead of relying on 0011:
--   0011_seed_help_content.sql is already applied in production and the
--   migration runner never re-runs an applied migration by content, so new
--   help rows authored after 0011 must ship as a forward migration to reach
--   prod. The canonical 0011 seed has ALSO been regenerated in this PR so the
--   generator output stays in sync with content/en/admin.yml (RCA 2026-05-18);
--   these INSERTs are byte-identical to the gen_score rows it emits.
--
-- Idempotent: ON CONFLICT (tenant_id, key, locale, version) DO NOTHING — safe
-- to apply more than once. Global rows (tenant_id IS NULL) must be inserted as
-- the postgres superuser, which BYPASSes the help_content INSERT RLS policy.

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.score_button',
  'admin',
  'en',
  'Runs the server-side scorer on this run — structural quality plus runtime metrics — and records an overall verdict.',
  $$## Score this attempt

Runs the generation **scorer** server-side for this attempt — no CLI or SSH
required. It re-evaluates the run on two axes and shows the result inline:

- **Structural quality** — re-checks every generated draft against the
  per-type content schema and the difficulty structural gates.
- **Runtime metrics** — compares the run's timing/resource figures against
  their thresholds.

The combined **overall verdict** (pass / warning / regression) appears above
the tables. Scoring is read-only — it never edits or deletes any drafts.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.verdict',
  'admin',
  'en',
  'Roll-up call for this run — pass, warning, or regression — from the structural and runtime checks below.',
  $$## Overall verdict

A single roll-up of the structural-quality and runtime checks for this run:

- **pass** — structural checks pass and no runtime metric failed.
- **warning** — minor issues worth a look (e.g. a soft metric miss), but not
  a regression.
- **regression** — a structural baseline regressed, or a runtime metric
  failed its threshold.
- **n/a** — not enough data to score (e.g. the run produced no questions).

The verdict is derived from the tables below; it does not change any drafts.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.structural',
  'admin',
  'en',
  'Per-type counts of drafts that passed or failed the schema and difficulty structural gates, with top failure reasons.',
  $$## Structural quality

Per question-type, how many generated drafts **passed** or **failed** the
structural gates — the per-type content schema plus the difficulty
structural validator (Bloom/NICE tagging, required fields, distractor and
step shape). The **reasons** column lists the most common failure causes.

The footer line shows total passed / total and how many results regressed
against the stored baseline — a non-zero regression count is the usual
trigger for a `warning` or `regression` verdict.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;

INSERT INTO help_content (id, tenant_id, key, audience, locale, short_text, long_md, version, status)
VALUES (
  gen_random_uuid(),
  NULL,
  'admin.gen_score.runtime',
  'admin',
  'en',
  'Run timing and resource metrics measured against thresholds; pass or fail is shown per metric.',
  $$## Runtime metrics

Operational metrics for the run, each compared against a threshold and marked
**pass** or **fail**. These capture *how the run executed*, not the quality
of individual questions. Typical metrics:

- **Run duration** — wall-clock time for the run; a high value usually means
  the model hit its max-turns budget or was rate-limited.
- **Failed chunks** — per-type generation chunks that errored; more than one
  is the usual cause of a `partial` result.
- **Dropped drafts** — near-duplicate or ungrounded drafts discarded before
  insert.

The table only appears when thresholds are available for the run.
$$,
  1,
  'active'
) ON CONFLICT (tenant_id, key, locale, version) DO NOTHING;
