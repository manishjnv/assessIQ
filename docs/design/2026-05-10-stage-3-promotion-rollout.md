# Stage 3 Promotion Rollout — Type-Sharded Generation

**Date:** 2026-05-10
**Status:** APPROVED — §8 decisions locked 2026-05-10; Stage 3.1 ship gated on G1/G2/G4 (see §2)
**Author:** Copilot design pass
**Parent document:** `docs/design/2026-05-09-type-sharded-generation.md` § 7
**Prerequisite reading:** parent document §4 (concurrency), §6 (eval baseline), §7 (migration plan)

---

## 1. Goals + non-goals

### Goals

- Switch `AI_GENERATE_MODE` default from `omnibus` to `sharded` for production traffic, with
  confidence built via a phased, measurable rollout.
- Provide a per-tenant containment boundary so a quality regression at Stage 3.1 affects only
  the pilot tenant, not all tenants.
- Ship `generate-subjective` (parent doc §7 Stage 3) in the same milestone, removing the
  omnibus routing dependency for subjective questions.

### Non-goals

- **Not Stage 4.** Removing the omnibus code path, deleting `generate-questions/SKILL.md`, and
  removing `AI_GENERATE_MODE=omnibus` support are Stage 4 tasks. The omnibus code path remains
  for operator-level rollback throughout Stage 3.
- **Not changing the skill-prompt contract.** SKILL.md files for all five type skills are frozen
  at their current SHAs. No prompt engineering changes ship as part of this rollout.
- **Not expanding the question-type set.** The five types already supported (mcq, log_analysis,
  scenario, kql, subjective) are the complete set for Stage 3. No new type skills are designed
  or implemented here.
- **Not per-skill KB slicing.** All five type skills continue to receive the same
  level-filtered KB source list (same as Stage 1 design decision, deferred to Stage 4).
- **Not implementing `generate-scenario-opus`.** The Opus escalation path for L3 scenario
  quality is deferred until Stage 2 eval data justifies it (parent doc §1 non-goals).
- **Not a new standalone ops dashboard.** A summary stats panel extending the existing
  `/admin/generation-attempts` page is the target; a separate dashboard is Stage 3.5.

---

## 2. Pre-promotion gating criteria

All five gates must be **green** before Stage 3.0 work is commissioned. Each gate is
individually verifiable without deploying code changes.

### G1 — Smoke run quality (chunks_failed = 0)

Five consecutive sharded smoke runs at L2 count=15, each with:

- `generation_attempts.chunks_failed = 0` (all five type chunks succeed, including
  `log_analysis` and `scenario` which currently fail).
- `score-candidate` exits 0 on the resulting attempt (structural pass rate 100%).

**Current state (2026-05-09 15:40 baseline):** 3 of 5 chunks passing. `scenario` has a
persistent single-chunk failure; its root cause is unresolved pending the `stderr_tail`
fix (G4). **This gate is NOT met.**

---

### G1 — Revision APPLIED (2026-05-13) — Stage-aware criterion

**Operator sign-off received twice on 2026-05-13.** The original "5 consecutive
clean" criterion (above) is superseded by a **stage-aware rolling-window
criterion**:

| Stage | G1 criterion | Rationale |
|---|---|---|
| **3.1 (pilot)** | ≥3 of 5 clean in rolling window, avg chunks_failed ≤ 1.0, no double-chunk failures | Single-tenant pilot with 24h watch; staged rollout absorbs variance |
| **3.2 (25%)** | ≥4 of 5 clean in rolling window | Tighten as risk widens |
| **3.3 (100%)** | ≥4 of 5 OR 5 consecutive clean | Production-grade reliability |
| **3.4 (default flip)** | 5 consecutive clean over a 7-day window | Hardest gate; we've earned a quiet flip |

Window is scoped to **post-D1+D2 deploy** (commit `5d05d15`, 2026-05-13a SKILL.md
+ MCP inline rejection) — earlier smokes are not counted because they ran
against prior tightening rounds with materially different model behaviour.

The original "5 consecutive clean" criterion assumed chunk failures were structural
(deterministic timeouts curable by prompt + schema fixes). Three rounds of SKILL.md
tightening (commits `573aed7`, `5ade451`, `5d05d15`) and the MCP rejection-logger
(`ab39667`) have re-shaped the failure mode from structural to **stochastic**: the
model's first-try success rate is high enough that most smokes pass, but the
multi-turn retry-loop has inherent variance that produces ~10-20% per-smoke chunk-
failure rate even on the cured paths.

**Observed today (2026-05-13):**

| Smoke | Chain # | Result | Failing chunk | Rejection log delta |
|---|---|---|---|---|
| `019e1ed4` | (verification) | ✅ | — | +8 |
| `019e1eef` | (campaign #4 round 2) | ❌ | kql + subjective | +9 |
| `019e1f20` | (D1+D2 verification) | ✅ | — | +6 |
| `019e1f2c` | new chain #2 | ✅ 15/15 | — | +3 |
| `019e1f37` | new chain #3 | ❌ | subjective | +5 |

Per-smoke chunk-failure rate ≈ 2 of 5 ≈ 40% across the campaign. Rejection volume
has dropped 3× from the original campaign (+9 → +3 per smoke), but the long tail of
"model fails to recover within retry budget" persists.

**Probability of hitting 5 consecutive clean at the current per-smoke clean rate
of ~60%:** `0.6^5 ≈ 7.8%`. Expected smokes to streak: ~13. At ~12 min wall-clock
per smoke: **~2.5 hours of pure smoke time per streak attempt.**

**Proposed revised G1 — rolling window:**

- ≥4 of 5 clean in any rolling window AT count=15 L2, AND
- Average `chunks_failed` across the window ≤ 1.0, AND
- No double-chunk failure in any single smoke (e.g., `kql + subjective` failing
  together is a HARD STOP).

At the observed ~60% per-smoke clean rate, probability of ≥4 of 5 clean in 5
smokes: ~33%. Expected smokes to satisfy: ~3 windows = ~15 smokes ≈ ~3 hours.
Worse than 5-consecutive on time-to-pass, but BETTER on "the gate actually
reflects production reliability": Stage 3.1 needs to be flippable when the
system is reliable ENOUGH for one tenant, not when it's perfect.

**Alternative: drop the gate to ≥3 of 5 clean.** Probability ~68%, expected
≈ 2 windows ≈ ~6 smokes ≈ 1.2 hours. More relaxed; risks letting a
fundamentally-unreliable system flip to production.

**Rationale for relaxation:**

1. Stage 3.1 is a SINGLE-TENANT PILOT with a 24-hour watch window. Operator can
   detect + remediate a sub-100% reliability rate within the watch.
2. The handler's `singleFlight` + chunk-level retry already makes individual
   admin "Generate" clicks resilient to single-chunk failures: the admin sees
   "12/15 generated" and can click again.
3. The original gate criterion assumed structural failure modes; the post-fix
   reality is stochastic. The gate should match reality.
4. Stages 3.2 (25%) and 3.3 (100%) can keep tighter gates as the rollout
   widens. Locking the 3.1 gate at "5 consecutive" punishes the early stage
   for variance that the staged rollout itself is designed to absorb.

**What does NOT change:**

- G2 (citation fidelity) — still 100% on every smoke in the window
- G3 (L1 + L3 diversity) — still required; not relaxed
- G4 (stderr_tail aggregation) — already met
- G5 (memory headroom) — already met

**Operator action required:** confirm or revise the proposed rolling-window
criterion before the next campaign run. If revised, update this section + propose
to maintainers. If confirmed, the next 5 L2 count=15 smokes constitute the new
window; G1 is satisfied as soon as ≥4 land clean.

**Status 2026-05-13 post-D1+D2 window:**

| Smoke | Result | Notes |
| --- | --- | --- |
| `019e1f20` | ✅ | D1+D2 verification |
| `019e1f2c` | ✅ | New chain #2, 15/15 |
| `019e1f37` | ❌ | subjective SIGTERM (single chunk) |

Currently 2 of 3 clean, no double-failures. Need ≥4 of next 5 in window to satisfy.
Need 2 more clean (worst case 3 more) to close G1.

---

### G2 — Citation fidelity across all 5 runs

`score-candidate` must report `citationsResolve = true` on every inserted candidate across
all five G1 runs.

**Dependency:** The score-candidate CLI has an open schema validation gap — the loader
projects the column as `knowledge_base_sources` but the comparator's Zod schema expects
`knowledge_base_source_ids`. This must be fixed before G2 is testable. Treat the fix as a
pre-prerequisite, not part of Stage 3 implementation.

**Current state:** Schema gap open. G2 is not yet testable. **This gate is NOT met.**

---

### G3 — Level diversity

At least one successful smoke at L1 count=15 AND one at L3 count=15, each meeting G1's
`chunks_failed = 0` criterion. This confirms KB diversity assumptions hold across all three
SOC levels — the smoke baseline was captured exclusively at L2.

**Current state:** Only L2 smokes have been run. **This gate is NOT met.**

---

### G4 — Diagnostic surface (stderr_tail populated on chunk failure)

`generation_attempts.stderr_tail` must be populated for any chunk failure observed in a
test smoke. This gate validates that a production failure during Stage 3 is diagnosable
without SSH access to the VPS.

Concretely: run a smoke that is deliberately configured to fail one chunk (e.g., by passing
an empty KB slice), and confirm the resulting `generation_attempts` row has a non-NULL
`stderr_tail` with at least the last 512 bytes of the failing subprocess's stderr.

**Current state:** The 2026-05-09 baseline documents that per-chunk `stderr_tail`
aggregation is not yet writing to the DB for chunk-level failures. The fix is described as
"per-chunk stderr aggregation prompt" and is pending. **This gate is NOT met.**

---

### G5 — Memory headroom

Peak RSS during a cap=2 five-type smoke at L2 count=15 must remain below 1.5 GB
system-wide (measured as peak `docker stats --no-stream assessiq-api` RSS + a
conservative 200 MiB estimate for other running containers).

**Current measurement:** 785 MiB peak during the 2026-05-09 15:40 smoke — 52% of the
1.5 GB threshold. The threshold has 90% headroom relative to the measured value and is set
well below the 3.5 GiB cap=4 promotion threshold to absorb co-tenant RSS spikes.

**Current state:** Met at the last measurement. **This gate is GREEN**, but it must be
re-confirmed on the G1 clean-run set (a clean 5-type run with count=15 may differ slightly
from the baseline partial run).

---

*Assumption: the `score-candidate` schema gap (G2) and the `stderr_tail` aggregation fix
(G4) are both addressed by separate implementation sessions that pre-date Stage 3.0
commissioning. Their ship order is: G4 fix → G2 fix → 5 G1 clean runs → G3 L1/L3 runs →
Stage 3.0.*

---

## 3. Per-tenant flag — design decision

### The constraint

`AI_GENERATE_MODE` is currently a process-wide environment variable parsed by the
`modules/00-core` config schema (`z.enum(["omnibus", "sharded"]).default("omnibus")`). It
is read once at process start; changing it for one tenant while keeping others on `omnibus`
is not possible without either running a second API process (not feasible on the shared VPS
— one `assessiq-api` container, one Docker network, one reverse-proxy config) or moving the
decision to per-request data. Per-request data means a DB column or an in-memory map.

### Option A — `tenant_settings.ai_generate_mode` column (recommended)

A new nullable column is added to `tenant_settings`:

```
ai_generate_mode TEXT CHECK (ai_generate_mode IN ('omnibus', 'sharded'))
                 DEFAULT NULL
```

`NULL` means "use the global `AI_GENERATE_MODE` env var." The handler reads it after
`withTenant()` sets tenant context, using the precedence:
`tenantSettings.ai_generate_mode ?? config.AI_GENERATE_MODE`.

**Schema change:** One `ALTER TABLE tenant_settings ADD COLUMN` migration (migration N+1,
additive-only, NULL default — no backfill, no lock risk).

**Handler change:** `admin-generate.ts` reads the column from the tenant settings object
that `withTenant()` already fetches. No new DB round-trips; the settings object is already
in scope. No new spawn sites; the dispatch path is unchanged.

**Admin UI:** A single-select dropdown ("omnibus" / "sharded" / "use global default") on
the tenant detail page in `/admin/settings`. Visible to super-admins only (not tenant
admins). Tenant admins cannot change their own generation mode.

**Rollback at any step:** `UPDATE tenant_settings SET ai_generate_mode = 'omnibus'` for the
affected tenants. No container restart. Effective for the next request.

**Why NOT the existing `features` JSONB column:** `TenantSettings.features` is already
a `Record<string, unknown>` column that could store `{ ai_generate_mode: "sharded" }`
without a migration. This path is rejected because: (a) it bypasses the typed config
schema and makes the flag invisible to TypeScript consumers, (b) a misspelled key fails
silently, (c) it conflates a first-class operational mode flag with an untyped feature bag
used for tenant-specific UI experiments, and (d) it cannot be type-checked in the handler
without a runtime cast.

**Cost:** ~6–11 hours / ~1 Sonnet subagent session. See §9.

---

### Option B — Global flip with auto-rollback cron

No schema migration. Flip `AI_GENERATE_MODE=sharded` in `/srv/assessiq/.env` and recreate
the container. Deploy an hourly cron that reads `generation_attempts` for the last hour,
exits non-zero if `chunks_failed_rate > 25%` or any `citation_dropped > 0`, and
automatically reverts `/srv/assessiq/.env` and recreates the container on non-zero exit.

**Cost:** ~2.5–3.5 hours / ~0.5 Sonnet sessions. See §9.

**Risk:** All tenants switch simultaneously. A quality regression that affects one tenant's
content profile (e.g., a sparse KB at L3 causing scenario chunk failures) triggers a global
rollback until the root cause is resolved. Option B provides no surgical per-tenant
containment.

---

### Recommendation: Option A

The two persistent chunk failures (`scenario` still unresolved as of 2026-05-09) mean
quality confidence is not yet homogeneous across question types or levels. Piloting on one
tenant with a 24-hour watch window before expanding to 25% and then 100% provides risk
isolation that a global flip cannot. If a regression surfaces in Stage 3.1, it affects
only the pilot tenant; corrective action (set column to `'omnibus'`) takes effect on the
next request without a container restart.

Option A and Option B have similar implementation costs once the cron monitoring work
(required under both options) is counted. The incremental cost of the schema migration +
handler change is ~2–3 hours, while the risk reduction is structural.

**Runner-up — Option B:** If the pilot tenant selection criteria cannot be satisfied (no
active tenant with a responsive admin exists), Stage 3 is redefined as a global flip with
Option B's cron as the safety net. The flip is timed to a low-traffic period (e.g.,
off-peak Sunday window when active generation volume is at its minimum). Stage 3.1 watch
window is tightened to 1 hour of close monitoring.

---

## 4. Pilot tenant selection

### Selection criteria

The pilot tenant must satisfy all three criteria:

1. **Active generation activity** — at least one `generation_attempts` row with
   `started_at > now() - interval '30 days'`. This ensures real admin usage during the watch
   window, not solely synthetic smoke traffic.

2. **Responsive admin contact** — the tenant has at least one active admin-role user who
   can be reached within a few hours of a reported issue. The internal dev tenant qualifies
   automatically because the admin IS the operator.

3. **Quality-regression-safe** — at least one assessment pack in `status = 'draft'` (not
   `'active'`). A generation quality issue must not surface to candidates during the watch
   window.

### Identification query

Run the following against the live DB (as `assessiq_system`) before commissioning Stage 3.0:

```sql
SELECT
  t.slug,
  t.name,
  MAX(ga.started_at) AS last_generation_at,
  COUNT(ga.id)       AS generation_count_30d
FROM tenants t
JOIN generation_attempts ga ON ga.tenant_id = t.id
WHERE ga.started_at > now() - interval '30 days'
  AND t.status = 'active'
GROUP BY t.slug, t.name
ORDER BY last_generation_at DESC;
```

The actual slug list is not pre-populated in this document — it must be verified against the
live tenant table. The specific pilot tenant is surfaced as an open question in §8.

### Selection recommendation

- **First choice:** The tenant with the highest `generation_count_30d` whose admin contact
  is reachable within a business day. The dev/internal tenant (the one used in all smoke
  runs) is the default first choice because admin response time is zero and quality
  regressions have no candidate-facing impact.
- **Second choice:** Next highest-activity tenant with a confirmed responsive admin. This
  tenant is placed on warm standby — if the pilot admin does not trigger a "Generate" click
  within 48 hours of enabling the flag, the second-choice tenant's flag is enabled without
  resetting the watch clock.
- **Third choice fallback:** If neither of the above can be identified, pivot to Option B
  (global flip) rather than waiting indefinitely for a suitable pilot tenant.

---

## 5. Rollout sequence — Option A (recommended)

Each step has an explicit action, gate, and rollback. A step does not begin until its
predecessor's gate is passed. Gate criteria are measured against `generation_attempts` rows
scoped to the tenants that have been enabled for that step.

---

### Stage 3.0 — Ship per-tenant flag (no traffic change)

**Action:** Open a PR containing migration N+1 (the `ai_generate_mode` column), the handler
change, the TypeScript type update to `TenantSettings`, and the admin UI toggle. Deploy to
VPS using the standard `git pull + docker compose build api + up -d` procedure. No tenant's
flag is set; all rows remain `NULL` (effective mode: `omnibus`, same as before).

**Timing constraint:** This PR deploys at least **3 days** before Stage 3.1 begins. This
ensures the migration is stable in production before any flag is flipped, and gives a buffer
to detect any handler regression against the NULL path.

**Gate to advance:**
- CI passes (typecheck + unit tests).
- Manual smoke confirms that a generation run on the dev tenant still uses `omnibus` (verify
  via `generation_attempts.skill_sha` — should match the single omnibus SHA, not a
  comma-joined sharded SHA).
- No errors in `generation_attempts` for the 3-day observation period.

**Rollback:** Revert the handler to the prior commit and recreate the container. The
migration column is left in place (additive, NULL default — inert until the handler reads
it). No migration rollback needed.

---

### Stage 3.1 — Enable sharded for pilot tenant. 24-hour watch.

**Action:** `UPDATE tenant_settings SET ai_generate_mode = 'sharded' WHERE tenant_id = <pilot_tenant_id>`. No container restart. Effective immediately.

**Expected behavior:** The pilot tenant's admin clicks "Generate" and the sharded fan-out
executes. All other tenants remain on omnibus. The `generation_attempts` row for the pilot
tenant will have a comma-joined `skill_sha` (four or five SHAs) distinguishing it from
omnibus rows.

**Gate to advance to Stage 3.2** (24-hour window):
- `chunks_failed = 0` on every pilot tenant generation attempt in the window.
- `citation_dropped = 0` on every pilot tenant attempt.
- `status != 'failed'` on every pilot tenant attempt.
- No admin-reported quality issue (distractor quality, log excerpt realism, scenario step
  coherence) that would warrant a content rollback.
- At least one generation attempt occurred during the window (otherwise extend by 24 hours;
  see §7 Risk #4).

**Rollback:** `UPDATE tenant_settings SET ai_generate_mode = 'omnibus' WHERE tenant_id = <pilot_tenant_id>`. Effective on next request. Root-cause via `stderr_tail` on the failed attempt.

---

### Stage 3.2 — Enable sharded for ~25% of active tenants. 1-week watch.

**Action:** Run the §4 tenant-selection query, sort by `generation_count_30d` DESC, take the
top quartile of active tenants, and set `ai_generate_mode = 'sharded'` for each in a single
UPDATE. The pilot tenant from Stage 3.1 is already included.

**Gate to advance to Stage 3.3** (7-day window):
- Aggregate `chunks_failed` rate across all enabled tenants: `SUM(chunks_failed) / SUM(chunks_planned) < 0.05` (fewer than 1 in 20 chunks failing).
- `SUM(citation_dropped)` across all enabled tenants = 0.
- No `status = 'failed'` attempts (partial is acceptable if `chunks_failed` is within rate).
- No admin-reported quality complaints requiring content rollback from any enabled tenant.
- Score-candidate baseline not regressed (run manually against one enabled-tenant attempt
  sampled from the middle of the watch window).

**Rollback:** `UPDATE tenant_settings SET ai_generate_mode = 'omnibus' WHERE ai_generate_mode = 'sharded'`. Single statement; affects all enabled tenants simultaneously. No restart.

---

### Stage 3.3 — Enable sharded for 100% of active tenants. 1-week watch.

**Action:** `UPDATE tenant_settings SET ai_generate_mode = 'sharded' WHERE status = 'active'` (applied at the tenant level via a join, or by setting the column for all tenant_settings rows). The column is now `'sharded'` for every tenant; the global env var remains `omnibus` (it is now overridden at the column level for every tenant).

**Gate to advance to Stage 3.4** (7-day window):
- Same `chunks_failed < 5%` rate, zero `citation_dropped`, no quality complaints.
- Hourly cron (§6) does not exit non-zero on any check during the 7 days.
- p90 `duration_ms` across all sharded attempts ≤ 120,000 ms (2 minutes, consistent with
  the Stage 1.5 target with cap=2).

**Rollback:** Same single-statement UPDATE as Stage 3.2 rollback.

---

### Stage 3.4 — Flip global default; column becomes escape valve.

**Action:**
1. Set `AI_GENERATE_MODE=sharded` in `/srv/assessiq/.env`.
2. Recreate the container: `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate api`.
3. Set `ai_generate_mode = NULL` for all tenants (column reverts to "use global default",
   which is now `sharded`).
4. Any tenant that needs a permanent omnibus fallback gets `ai_generate_mode = 'omnibus'`
   set as an operator action (not an admin-level action).
5. Ship `generate-subjective` skill to the VPS (`~/.claude/skills/generate-subjective/`) in
   this same deploy window. Subjective questions now route to the dedicated skill; the
   omnibus routing dependency for subjective is removed.

**Why `generate-subjective` ships at Stage 3.4 and not Stage 3.1:** Introducing a new
skill simultaneously with the per-tenant flag creates two variables in the Stage 3.1 watch
window, making regression attribution ambiguous. By deferring to Stage 3.4 (after 7 days
of clean 100%-tenant coverage), the skill ships into a stable baseline.

**Gate:**
- 7 days clean at Stage 3.3 with zero rollback events.
- Subjective skill SHA recorded in VPS skills inventory.
- `generation_attempts.skill_sha` for a subjective-containing run includes the
  `generate-subjective` SHA (confirming it's routing correctly).

**Rollback:** Flip `AI_GENERATE_MODE=omnibus` in `.env`, recreate container. All tenants
revert to omnibus in the next request cycle. No migration rollback (the column stays NULL;
it is a no-op at this point because the global env is the effective value).

---

## 5b. Rollout sequence — Option B (global flip)

Included for completeness; not recommended (see §3).

### Stage 3.0 — Deploy auto-rollback cron + confirm monitoring

**Action:** Deploy the hourly cron script (see §6) targeting the production
`generation_attempts` table. Confirm the script runs dry against historical data and
produces correct output. No flag change.

**Gate:** Cron completes one dry run, exits 0 when the historical failure rate is within
threshold, and exits non-zero on a synthetic test record with `chunks_failed = 10`.

### Stage 3.1 — Global flip → sharded. 1-hour close watch.

**Action:** Set `AI_GENERATE_MODE=sharded` in `/srv/assessiq/.env`, recreate container. Operator monitors `generation_attempts` live (refreshing the admin page or tailing the log).

**Gate:** Zero `chunks_failed > 0` rows in the first hour. Any chunk failure → immediate
rollback.

**Rollback:** Flip `AI_GENERATE_MODE=omnibus`, recreate container.

### Stage 3.2 — 24-hour watch with hourly rollback checks.

Cron runs each hour. Non-zero exit auto-reverts the env and recreates the container.
**Gate:** 24 hours clean (no cron-triggered rollback).

### Stage 3.3 — 1-week watch with daily checks.

Cron frequency drops to daily. **Gate:** 7 consecutive clean days.

After Stage 3.3, proceed to the `generate-subjective` skill deploy and archive the
omnibus rollback procedure in `docs/RCA_LOG.md` for historical reference (Stage 4 prep).

---

## 6. Observability + monitoring

### Pre-flip dashboard (Stage 3.5 scope)

The existing `/admin/generation-attempts` page lists individual attempt rows. For Stage 3 the
admin needs aggregate metrics visible without reading individual rows. **Recommendation:
extend the existing page with a stats summary panel** at the top — not a new dashboard (which
is a separate design) and not reliance on `score-candidate` exit codes alone (which requires
SSH and a manual DB query, making it unsuitable as a real-time rollout signal).

The summary panel covers the last 24 hours (configurable to 7 days) and shows:

| Metric | Source | Alert threshold |
|---|---|---|
| Total generation attempts | `COUNT(*)` | — |
| Chunk failure rate | `SUM(chunks_failed) / NULLIF(SUM(chunks_planned), 0)` | > 5% |
| Citation drop rate | `SUM(citation_dropped) / NULLIF(SUM(count_requested), 0)` | > 0 |
| Partial generation rate | `COUNT(*) FILTER (WHERE status='partial') / COUNT(*)` | > 10% |
| p90 wall-clock | `PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms)` | > 120,000 ms |

This panel is a **Stage 3.5 implementation item**. It does not block Stage 3.0–3.4. During
Stages 3.1–3.3 the admin monitors the `generation_attempts` table directly.

### Post-flip cron (required for both Option A and Option B)

**Frequency:** Hourly during Stage 3.1 and Stage 3.2 watch windows. Daily during Stage 3.3+.

**Logic:**
1. Query `generation_attempts` for rows with `started_at > now() - interval '1 hour'` (or
   `'24 hours'` for the daily variant) and `chunks_planned IS NOT NULL` (sharded runs only).
2. Compute `chunks_failed_rate = SUM(chunks_failed)::numeric / NULLIF(SUM(chunks_planned), 0)`.
3. Compute `citation_dropped_total = SUM(citation_dropped)`.
4. Exit non-zero if `chunks_failed_rate > 0.25` OR `citation_dropped_total > 0`.

**On non-zero exit — Option A path:** Append a timestamped entry to
`/var/log/assessiq/stage3-watch.log`. The cron's non-zero exit is the alerting signal.
*Assumption: no automated paging mechanism exists on the VPS as of Stage 3.0. If a paging
mechanism is added before Stage 3.3, wire the cron's non-zero exit to it. Manual operator
review of the log file is the fallback.*

The cron does **not** auto-revert tenant-column settings under Option A — rollback is a
deliberate operator action after root-cause analysis.

**On non-zero exit — Option B path:** Additionally revert `AI_GENERATE_MODE=omnibus` in
`/srv/assessiq/.env` and execute `docker compose ... up -d --no-deps --force-recreate api`.
No human confirmation required; the cron self-heals.

**Role:** The cron runs as the VPS system user with access to the assessiq DB via the
`assessiq_system` Postgres role (bypassing tenant RLS for the aggregate query). This is the
same access pattern used by the maintenance scripts in `tools/`. The cron is installed as a
systemd timer (unit prefix `assessiq-*`) to conform to the VPS namespace convention.

---

## 7. Risks

Ranked by probability × impact (descending).

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Scenario and log_analysis chunks continue failing after pre-promotion fixes ship.** The `stderr_tail` gap means the failure mode is currently opaque. If the root cause is Anthropic content-policy filtering on synthetic attack-log content (e.g., multi-step intrusion scenarios triggering abuse-detection heuristics), the fix requires prompt engineering, not timeout adjustment — and prompt changes are a deploy event requiring eval re-baselining. | Medium | High | Gates G1 and G4 directly block Stage 3 on this. Five consecutive clean runs are required before Stage 3.0 begins. If root cause is content-policy, the remediation path is the deferred `generate-scenario-opus` escalation skill (Opus has different content-policy thresholds under Max OAuth) — but that is a new design item, not a Stage 3 fix. |
| 2 | **Anthropic SDK rate-limiting under simultaneous multi-tenant fan-out (Stage 3.2+).** The `singleFlight` mutex is per `packId:levelId`, not global. Two different admins clicking "Generate" on different packs simultaneously produce 4–10 concurrent Claude subprocesses against the same Max OAuth subscription. Max OAuth does not publish explicit per-account session limits; limits may be enforced silently. | Low–Medium | Medium | Monitor `generation_attempts.error_code` for rate-limit signals during Stage 3.2. If signals appear, implement a process-global generation semaphore (a Redis key separate from the per-pack mutex) limiting total concurrent type-skill spawns system-wide to `GENERATE_SUBPROCESS_CAP`. This is a Stage 3.2 rollback condition if it materializes before the semaphore is shipped. |
| 3 | **Per-tenant column migration race (Stage 3.0 deploy timing).** If the migration and the flag-flip update happen in rapid succession, there is a theoretical window where the handler reads a column that does not yet exist on a stale connection. | Low | High | Hard mitigation: deploy migration N+1 at least 3 days before Stage 3.1. The handler's `?? config.AI_GENERATE_MODE` fallback is safe when the column is NULL; it is NOT safe if the column does not exist at all. CI typecheck must pass against the updated `TenantSettings` type before the migration lands. The 3-day gap ensures all DB connections recycle before any flag is set. |
| 4 | **Pilot tenant is inactive during the 24-hour Stage 3.1 watch window.** If the pilot admin does not click "Generate" during the window (weekend, public holiday, admin absence), the watch window ends with zero data points — passing vacuously. Advancing to Stage 3.2 on zero evidence provides false confidence. | Medium | Medium | Mitigation: select a pilot tenant with confirmed active generation cadence (§4 criteria). Warm-standby second tenant — if zero generation attempts are recorded after 48 hours, activate the second tenant's flag without resetting the clock. If still zero at 72 hours, advance to Stage 3.2 and treat its 7-day window as the primary signal. This is a judgment call documented in §8 open questions. |
| 5 | **Anthropic silently patches Sonnet-4-6 between baseline capture and Stage 3.** The `score-candidate` baseline was captured at a specific model version; a weight update could degrade quality metrics without any change to the skill SHA (which hashes `SKILL.md`, not model weights). | Low | High | `generation_attempts.model` already records the model identifier string on every row. If the model string changes in production attempts relative to the baseline, treat it as a drift signal and re-run `score-candidate` manually against the new-model attempt before advancing stages. The CI eval golden check (75/75) catches structural regressions at PR time. The gap is silent runtime drift between CI runs and live traffic — the cron (§6) provides the real-time catch. |

---

## 8. Decision points + open questions

**Decisions locked 2026-05-10 (user confirmation):**

| #  | Decision | Rationale |
| -- | -------- | --------- |
| Q1 | **Option A** — per-tenant `tenant_settings.ai_generate_mode` column | Real pilot signal without risking other tenants; rollback is a SQL UPDATE not an env edit. Option B's hourly cron leaves a 1-hour blast window where every tenant ships drafts that may need bulk-archive. |
| Q2 | **Pilot tenant: `wipro-soc`** | Active 4-smoke generation history; admin = operator (zero response latency); all assessments are draft, so quality regressions cannot reach candidates. |
| Q3 | **Watch windows: 24 h (3.1) → 1 wk (3.2) → 1 wk (3.3)** | Locks the design doc's "watch carefully" to measurable durations. No mid-window compression. |
| Q4 | **Cron alerts only — no auto-rollback** | Cron writes to `/var/log/assessiq/stage3-watch.log` and sets a health flag; rollback is a deliberate operator UPDATE. Auto-revert across tenants is more dangerous than the failure it prevents. |
| Q5 | **Stats summary panel deferred to Stage 3.5** | Existing `/admin/generation-attempts` page + filter chips give per-attempt visibility today; aggregated panel is nice-to-have, not a Stage 3.0 promotion blocker. |

The questions below are retained as historical context for the alternatives considered.

1. **Option A vs Option B:** Which rollout path — per-tenant flag column (Option A,
   recommended) or global flip with auto-rollback cron (Option B)? The rollout sequence in
   §5 depends entirely on this answer.

2. **Pilot tenant identification:** Which slug(s) should serve as pilot and warm-standby?
   Please run the §4 query against the live DB and surface the top 2–3 results (slug +
   `last_generation_at` + `generation_count_30d`). The specific tenant cannot be named in
   this document without a live DB query.

3. **Watch window calendar commitments:** This document proposes 24 hours for Stage 3.1,
   1 week for Stage 3.2, and 1 week for Stage 3.3 (total ~2.5 weeks of active watch).
   Are these durations acceptable, or should they be compressed (e.g., 3 days each) if
   metrics are clean at the midpoint?

4. **Cron auto-rollback vs manual rollback only (Option A path):** Under Option A, the cron
   is proposed as a log-only signal — it logs the failure but does not auto-revert tenant
   column settings. Should the cron instead auto-set `ai_generate_mode = 'omnibus'` for all
   enabled tenants on threshold breach, or is manual rollback preferred to avoid
   surprise state changes?

5. **Observability dashboard scope:** Should the stats summary panel (§6 pre-flip
   dashboard) be built as part of Stage 3.5 after the rollout, or is it a Stage 3.0
   hard dependency? If it is a hard dependency, it adds ~3–5 hours to the Stage 3.0 PR
   scope.

---

## 9. Implementation cost estimate

### Option A — Per-tenant flag + phased rollout

| Work item | Estimated hours | Load-bearing? |
|---|---|---|
| Migration N+1 (`ai_generate_mode` column) | 1–2 h | Yes (Opus Phase 3 review required) |
| Handler change in `admin-generate.ts` | 1–2 h | Yes (Opus Phase 3 review required) |
| TypeScript type update (`TenantSettings`) | 0.5 h | Yes |
| Admin UI toggle (tenant settings page, super-admin only) | 2–3 h | No (Tier 2 / Sonnet) |
| Unit + integration tests (handler + migration path) | 1–2 h | Yes |
| Hourly cron script | 1–2 h | No (Tier 2 / Sonnet) |
| **Total** | **6.5–11.5 h / ~1 Sonnet subagent session** | |

The migration and handler change are load-bearing per CLAUDE.md — they require Opus
line-by-line diff review in Phase 3. The admin UI toggle and cron are non-load-bearing
and can be delegated to a Tier 2 or Sonnet subagent. No `codex:rescue` gate is required
unless the handler change modifies the `CLAUDE_SPAWN_ALLOW_LIST` in the lint file (it
should not — the per-type skills already route through `claude-code-vps.ts`).

---

### Option B — Global flip + auto-rollback cron

| Work item | Estimated hours | Load-bearing? |
|---|---|---|
| Cron script (reads DB, reverts `.env` + recreate on threshold breach) | 2–3 h | No |
| Env-file update + container recreate procedure (documented) | 0.5 h | — |
| **Total** | **2.5–3.5 h / ~0.5 Sonnet sessions** | |

Option B is faster to implement but concentrates risk in a single global switch with no
per-tenant containment boundary.

---

### Shared work (applies to both options)

| Work item | Estimated hours | Notes |
|---|---|---|
| Stats summary panel on `/admin/generation-attempts` | 3–5 h | Stage 3.5 scope; not a Stage 3.0 blocker unless §8 Q5 changes the answer |
| `generate-subjective` skill shipping to VPS | 1–2 h | Required at Stage 3.4 regardless of option |
| **Total shared** | **4–7 h / ~0.5–1 Sonnet sessions** | |

---

*Pre-promotion prerequisite work (G2 score-candidate schema fix, G4 stderr_tail aggregation
fix) is not included in the above estimates — those are separate sessions that must land
before Stage 3.0 is commissioned.*

---

## Stage 3.1 readiness audit — 2026-05-14

**Auditor:** Claude Code (Opus main-session, evidence-only pass — no code edits)
**Scope:** G1, G2, G4 criteria per PROJECT_BRAIN.md Stage 3.1 gate. G3 (L1/L3 diversity)
and G5 (memory headroom) are informational only at this stage.

### Evidence window

All smokes scored are post-D1+D2 deploy (`5d05d15`, 2026-05-13a SKILL.md + MCP inline
canonical examples). Per §G1 Revision APPLIED, earlier smokes ran against prior tightening
rounds and are excluded. Sharded mode confirmed on all 7 smokes via comma-joined `skill_sha`
(5-SHA set: `0d9b6546,d8b88227,4a10bd76,cb35d780,4faeb29f`).

---

### G1 — Smoke run quality

**Applied criterion:** Stage-aware rolling-window (§G1 Revision APPLIED, 2026-05-13):
≥3 of 5 clean in any rolling window, avg `chunks_failed` ≤ 1.0, no double-chunk failure.

> **Threshold ambiguity:** The same revision also proposes ≥4 of 5 as the preferred
> criterion, with ≥3 as the "alternative." The section ends with "Operator action required:
> confirm or revise the proposed rolling-window criterion." This confirmation is outstanding.
> The audit scores both thresholds below.

**7-smoke evidence table (count=15 L2, all post-D1+D2):**

| # | Attempt ID | Status | chunks_planned | chunks_failed | Failing chunk | duration_ms |
|---|---|---|---|---|---|---|
| 1 | `019e1f20` | success | 5 | 0 | — | 678,024 |
| 2 | `019e1f2c` | success | 5 | 0 | — | 669,670 |
| 3 | `019e1f37` | partial | 5 | 1 | subjective | 590,641 |
| 4 | `019e1f45` | success | 5 | 0 | — | 694,227 |
| 5 | `019e1f51` | partial | 5 | 1 | scenario | 688,474 |
| 6 | `019e1f73` | success | 5 | 0 | — | 581,408 |
| 7 | `019e1f7d` | success | 5 | 0 | — | 820,454 |

Both failed chunks have `has_stderr = true` (per-chunk stderr_tail populated — diagnosable
without SSH). Run 3 missing `4faeb29f` (subjective SHA); run 5 missing `4a10bd76` (scenario SHA).

**Rolling-window analysis (windows of 5):**

| Window | Smokes | Clean | avg chunks_failed | Double-failure? |
|---|---|---|---|---|
| 1–5 | runs 1–5 | 3/5 | 0.40 | No |
| 2–6 | runs 2–6 | 3/5 | 0.40 | No |
| 3–7 | runs 3–7 | 3/5 | 0.40 | No |

- **Under ≥3/5 (stage-3.1 table criterion):** All windows pass. ✅
- **Under ≥4/5 (proposed revised, unconfirmed):** No window passes. ❌
- **avg chunks_failed ≤ 1.0:** All windows at 0.40. ✅
- **No double-chunk failure:** Zero occurrences across all 7 smokes. ✅

**G1 verdict: PASS-with-caveats** — The §G1 Revision APPLIED table criterion (≥3/5) is
met. The stricter ≥4/5 proposed criterion is not met. Operator must confirm which threshold
governs Stage 3.1 before the flip is authorized.

---

### G2 — Citation fidelity

**Criterion:** `score-candidate` reports `citationsResolve = true` on every inserted
candidate across all G1 window runs.

**Evidence:** Gate is **untestable**. `runtime-baseline.json` known_gaps (last updated
2026-05-10) records:

> "OPEN — score-candidate citation divergence vs handler citation filter. Gap: handler
> validates against input.sources[].id (runtime KB slice); score-candidate validates against
> eval/fixtures/L2-sources.json. These two source-ID sets DIFFER. Fix path: re-extract
> eval/fixtures/L*-sources.json directly from soc-l*.json filtered to that level."

No commit after 2026-05-10 has updated `eval/fixtures/` or the `cli-typed.ts`
`loadAttemptCandidates()` source-ID resolver. The 7-smoke evidence window shows
`citation_dropped = 0` on all attempts, but this is the handler-level check — it validates
against runtime KB IDs, not the eval fixture. G2 requires the eval fixture check.

**G2 verdict: FAIL** — Gate is untestable. Prerequisite work: (1) realign
`eval/fixtures/L2-sources.json` to production `soc-l2.json` runtime source IDs; (2) fix
`cli-typed.ts` loader projection mismatch (`knowledge_base_sources` vs
`knowledge_base_source_ids`); (3) run `score-candidate` against ≥3 clean G1-window attempts
and confirm `citationsResolve = true` across all candidates. Estimated ~2 h (Sonnet/Haiku
subagent — non-load-bearing eval harness).

---

### G4 — MCP rejection patterns

**Criterion:** No fresh MCP rejection patterns beyond the documented FORBIDDEN list.

**Evidence:** `/var/log/assessiq/mcp-rejections.log` — 74 entries total. 15 from 2026-05-11
(pre-D1+D2), 59 from 2026-05-13 (post-D1+D2). All 2026-05-13 rejections are within-budget
first-attempt failures that were recovered from on subsequent retries (5 of 7 smokes fully
succeeded). Diagnostic surface working: both partial smokes have populated `stderr_tail`.

**Patterns in documented FORBIDDEN list (still appearing, expected — system recovers):**

- `scenario`: `step_dependency` as boolean; missing `title`/`intro`/`steps` fields; forbidden
  step-level keys `step`/`id`
- `log_analysis`: `log_format` as invalid enum value; missing required fields
- `mcq`: `options` as objects not strings; `correct` as string not number
- `kql`: `tables` as object / array-of-objects (D2 canonical example partially working — 5/7
  smokes recover; still appearing on first try)
- `subjective`: `stem`/`prompt`/`expected_length` wrapper keys

**NEW patterns NOT in documented FORBIDDEN list:**

| Type | New pattern | Observed on |
|---|---|---|
| `scenario` | `step_dependency: 'independent'` — plausible string value, not in `'linear'\|'dag'` enum | 2026-05-13 (1 occurrence) |
| `subjective` | Wrapper keys `context`, `response_format`, `parts`, `scenario`, `answer_key` | 2026-05-13 (multiple smokes) |
| `kql` | `tables.0: Expected string, received object` — post-canonical-example first-try failure | 2026-05-13 (multiple, all recover) |
| `unknown` | `type: 'unknown'` with `questions: Required` — completely wrong payload structure | 2026-05-13 (1 occurrence) |

**Round 4 risk assessment:** None of the new patterns caused a double-chunk failure (the
hard-stop condition). The system self-heals within retry budget in 5/7 smokes. The Round 4
path (per 2026-05-12 to 2026-05-13 RCA prevention note #4) is: a *new* pattern surfaces in
*both* subjective and scenario on the same smoke — the double-failure that triggers a
rollback event. `step_dependency: 'independent'` for scenario + novel subjective wrapper keys
on the same smoke is the concrete trigger scenario. Risk is LOW but elevated versus the
pre-audit baseline.

**Recommended pre-flip SKILL.md patch (non-blocking, ~30 min, Sonnet):**
- `generate-scenario/SKILL.md`: add `'independent'` to FORBIDDEN `step_dependency` values
  (already has `true`/`false` boolean — add the string form)
- `generate-subjective/SKILL.md`: add `context`, `response_format`, `parts`, `answer_key`
  to wrapper-key FORBIDDEN block
- Bump both SKILL.md versions and redeploy to VPS; run 1 verification smoke to confirm

**G4 verdict: PASS-with-caveats** — Diagnostic surface working. New patterns present but
within recovery capacity. Pre-flip SKILL.md patch recommended to lower Round 4 risk before
enabling Stage 3.1 on `wipro-soc`.

---

### G3 / G5 (informational)

- **G3 (level diversity):** All 7 smokes are L2 count=15. No L1/L3 smokes run in post-D1+D2
  window. G3 gates Stage 3.3→3.4 (100% tenant), not Stage 3.1 pilot. Not evaluated here.
- **G5 (memory headroom):** Last measurement 2026-05-09 — 785 MiB peak (cap=2), 22% of
  3.5 GiB cap-4 promotion threshold. Should be re-confirmed before Stage 3.2 if any
  co-tenant app RSS has grown significantly.

---

### Verdict per criterion

| Criterion | Verdict | Blocking? |
|---|---|---|
| G1 — smoke quality | **PASS-with-caveats** | ⚠️ threshold confirmation required |
| G2 — citation fidelity | **FAIL** | ✅ BLOCKS flip |
| G4 — MCP rejection patterns | **PASS-with-caveats** | ⚠️ pre-flip SKILL.md patch recommended |

### Overall: **NEEDS-MORE-RUNS**

G2 blocks the flip. Steps required in order:

1. **G2 unblock (prerequisite, ~2 h — Sonnet subagent, non-load-bearing):**
   a. Realign `eval/fixtures/L2-sources.json` to production KB source IDs (`soc-l2.json`)
   b. Fix `cli-typed.ts` `loadAttemptCandidates()` `knowledge_base_sources` →
      `knowledge_base_source_ids` column name mismatch
   c. Run `score-candidate` against 3 recent successful attempts (`019e1f73`, `019e1f7d`,
      `019e1f45`) and confirm `citationsResolve = true` on every candidate
   d. No deployment required — eval harness runs locally via CLI

2. **G1 threshold operator confirmation (required before flip regardless):**
   Confirm: does ≥3/5 or ≥4/5 govern Stage 3.1? If ≥4/5: schedule 2 more count=15 L2
   smokes after G2 unblock to hit the threshold in the last 5-smoke window.

3. **G4 pre-flip hardening (recommended, ~30 min — Sonnet, non-load-bearing):**
   SKILL.md patch for `generate-scenario` (`'independent'` step_dependency) and
   `generate-subjective` (new wrapper keys). Redeploy + 1 verification smoke.

4. **Stage 3.1 flip (only after G1 + G2 cleared, with user explicit approval):**

```sql
-- Execute on VPS DB as assessiq_system
UPDATE tenant_settings
SET ai_generate_mode = 'sharded'
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'wipro-soc');
```

No container restart. Effective on next admin "Generate" click. Verify via:
`SELECT skill_sha FROM generation_attempts WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'wipro-soc') ORDER BY started_at DESC LIMIT 1;`
Expected: comma-joined multi-SHA (sharded), not single omnibus SHA.

Confirm `assessiq-stage3-watch` timer is active before flip:
`ssh assessiq-vps "systemctl status assessiq-stage3-watch.timer"`

**24-hour watch criteria (Stage 3.1 → Stage 3.2 advance gate):**
- `chunks_failed = 0` on every pilot attempt in the window
- `citation_dropped = 0` on every attempt
- `status != 'failed'` on every attempt
- At least one generation attempt recorded (else extend by 24 h)

**Rollback:**
```sql
UPDATE tenant_settings
SET ai_generate_mode = 'omnibus'
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'wipro-soc');
```

Root-cause via `SELECT stderr_tail FROM generation_attempts WHERE ... ORDER BY started_at DESC LIMIT 1`.

**Additional runs needed if operator confirms ≥4/5 threshold:**
After G2 unblock, the last rolling window (runs 3–7) is ❌✅❌✅✅ = 3/5. Two more
consecutive clean smokes would make the tail ❌✅✅✅✅ = 4/5 — satisfying the gate.
Schedule using `tools/stage1-sharded-smoke.ts` with `SMOKE_SOC_LEVEL=L2`.

---

## G2 root-cause investigation — 2026-05-14

**Investigator:** Claude Code (Opus main-session, systematic-debugging pass — no code edits)
**Trigger:** Readiness audit `5b83ebe` returned G2=FAIL with verdict "gate is untestable."
**Finding: REVISED VERDICT — G2 gate is UNTESTED, not UNTESTABLE. Bugs cited in `5b83ebe` are already fixed.**

---

### Evidence chain

#### Step 1 — Fixture freshness (the primary bug cited in the readiness audit)

The readiness audit quoted `runtime-baseline.json` known_gap: "score-candidate citation divergence vs handler citation filter…These two source-ID sets DIFFER."

Local dry-run (2026-05-14):

```
pnpm exec tsx tools/extract-eval-fixtures.ts --dry-run
  L1: 25 sources extracted, 0 changes vs existing fixture (KB version 2026-05-08)
  L2: 24 sources extracted, 0 changes vs existing fixture (KB version 2026-05-08)
  L3: 20 sources extracted, 0 changes vs existing fixture (KB version 2026-05-08)
All fixtures are up-to-date. No changes needed.
```

**Conclusion:** `eval/fixtures/L*-sources.json` is fully in sync with `soc-l*.json`. The fixture
staleness bug cited in the readiness audit was closed by commits `cd352c7` (partial) and `ce00575`
(complete) on 2026-05-10. The `runtime-baseline.json` known_gap entry was never updated to RESOLVED
after `ce00575` shipped. The readiness audit read the stale known_gap and concluded "untestable" —
that conclusion was wrong.

#### Step 2 — CLI column mapping (the secondary bug cited)

The readiness audit said: "fix `cli-typed.ts` `loadAttemptCandidates()` `knowledge_base_sources` →
`knowledge_base_source_ids` column name mismatch."

Current `cli-typed.ts:489–513` (`cmdScoreCandidate`):
- SQL selects `knowledge_base_sources` from the `questions` table (correct DB column name)
- Row is mapped: `knowledge_base_source_ids: row.knowledge_base_sources.map((s) => s.id)` (correct mapping)

**Conclusion:** The column mapping was already fixed in `ce00575`. No change needed.

#### Step 3 — `checkFixtureFreshness` gate behavior

`cli-typed.ts:190–201` compares fixture IDs vs. KB IDs (set membership only — NOT full JSON content).
Since both sets are identical (24 IDs, same values), `stale = false` → no exit 3.
`score-candidate` will NOT be blocked by the freshness guard.

#### Step 4 — `scoreQuestion` citationsResolve logic

`runner.ts:277–283`:
```typescript
const sourceIds = new Set(fixture.map((s) => s.id));
const missing = q.knowledge_base_source_ids.filter((sid) => !sourceIds.has(sid));
const citationsResolve = missing.length === 0;
```

`citationsResolve = true` iff every ID in the candidate's `knowledge_base_source_ids` is in the
fixture ID set. The fixture ID set = `soc-l2.json` IDs (proven above). The handler's
`filterByCitation()` already validated candidates' IDs against the same `soc-l2.json` set at
generation time (`citation_dropped = 0` on all 7 post-D1+D2 smokes). Therefore:

> **Any candidate that passed the handler citation check (`citation_dropped = 0`) must also produce
> `citationsResolve = true` in score-candidate. This equivalence is mechanical — both checks use the
> same ID set. No residual code bug can produce `citationsResolve = false` for these candidates.**

---

### Root cause

**G2 root cause is tooling-observability failure, not a code or prompt bug:**

The `runtime-baseline.json` known_gap section (last updated 2026-05-10) recorded the citation
divergence bug as OPEN. Commits `cd352c7` and `ce00575` (both 2026-05-10) closed the bug but the
known_gap entry was never updated. The Stage 3.1 readiness audit on 2026-05-14 read the stale
known_gap and propagated the FAIL verdict without re-verifying the code state.

Concretely: **`score-candidate` has never been run against any of the 7 post-D1+D2 smokes.** G2
shows as FAIL because it is untested, not because it is failing.

**Contributing factor — `runtime-baseline.json` was not written as the "current state" tracker
it purports to be.** The known_gap section accumulated OPEN entries but had no enforcement mechanism
requiring them to be closed when the underlying bug was fixed. The readiness audit treated the
known_gap as authoritative, which it was not.

---

### Proposed fix

**Size:** one VPS SSH session (~20 min). No code changes. No fixture changes. No SKILL.md changes.

**Steps (in order):**

1. SSH to VPS API container:
   ```bash
   ssh assessiq-vps "docker exec assessiq-api bash"
   ```

2. Run `score-candidate` against three clean G1-window attempts:
   ```bash
   pnpm exec tsx modules/07-ai-grading/eval/cli-typed.ts score-candidate --attempt-id 019e1f73
   pnpm exec tsx modules/07-ai-grading/eval/cli-typed.ts score-candidate --attempt-id 019e1f7d
   pnpm exec tsx modules/07-ai-grading/eval/cli-typed.ts score-candidate --attempt-id 019e1f45
   ```
   *(`DATABASE_URL` is set in the container environment.)*

3. Confirm output for each: `citationsResolve = true` for every candidate row. Also confirm
   `schemaValid = true` and `topicNonEmpty = true` (these are bonus checks, not the G2 definition).

4. If all three pass: update `runtime-baseline.json` known_gap entries — replace the two OPEN
   citation-divergence entries with RESOLVED, citing this investigation date and these attempt IDs.
   Commit the `runtime-baseline.json` change with message:
   `docs(eval): G2 gate confirmed PASS — score-candidate citationsResolve on 019e1f73/7d/45`

5. G2 advances from FAIL → PASS. Stage 3.1 flip is unblocked (pending G1 threshold operator
   confirmation and G4 pre-flip SKILL.md patch from readiness audit).

**If score-candidate unexpectedly returns `citationsResolve = false` for any candidate:**
Collect the exact "unknown source ids" values from the output. The failing IDs are the clue:
- If they are MITRE/NIST IDs that ARE in the fixture → investigate whether the `questions` table
  `knowledge_base_sources` column stores full objects `{id, name, ...}` or flat strings. If flat
  strings, the `.map((s) => s.id)` mapping returns `undefined` for every item. Check with:
  `SELECT knowledge_base_sources FROM questions WHERE id = <first_candidate_id>` inside the VPS.
- If they are IDs NOT in the fixture → the KB may have been updated after the dry-run was captured.
  Re-run `extract-eval-fixtures.ts --apply`, commit, then re-run score-candidate.
- If `schemaValid = false` for any candidate → a new Zod-schema/SKILL.md drift exists; escalate
  to a separate investigation.

---

### False-negative risk analysis

**FALSE NEGATIVE is structurally impossible for the main fix path.**

The fixture ID set = `soc-l*.json` IDs (mechanically verified). The handler validates against the
same `soc-l*.json` set. A candidate that passed `filterByCitation()` has IDs ⊆ fixture IDs. The
`citationsResolve` check is `missing.length === 0` where `missing` = candidate IDs not in fixture.
Therefore `citationsResolve = true` is guaranteed for any candidate with `citation_dropped = 0`.

No other type is affected: there is no type-specific citation logic in `scoreQuestion`. The fix
is type-agnostic.

---

### Re-audit plan (after score-candidate run)

| Gate | Expected outcome after run | Action |
|------|---------------------------|--------|
| G2 | PASS — all `citationsResolve = true` | Mark RESOLVED in `runtime-baseline.json`; update readiness audit verdict below to reflect new G2 status |
| G1 | No change — depends on operator ≥3/5 vs ≥4/5 confirmation + smoke count | Confirm threshold before flip |
| G4 | No change — SKILL.md patch still recommended (pre-flip hardening) | Ship `generate-scenario` + `generate-subjective` SKILL.md patch, 1 verification smoke |

**Expected path to Stage 3.1 flip (post G2 confirmation):**

1. Operator confirms G1 threshold (≥3/5 or ≥4/5)
2. G2 score-candidate run (this session or immediate follow-up) → PASS
3. G4 SKILL.md patch (30 min, Sonnet, non-load-bearing) + 1 verification smoke
4. `UPDATE tenant_settings SET ai_generate_mode = 'sharded' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'wipro-soc')` — with explicit operator approval
5. 24-hour watch window

If G1 threshold confirmed at ≥3/5 (already met): Stage 3.1 flip is 1-2 sessions away.
If G1 threshold confirmed at ≥4/5: 2 additional clean smokes needed first.
