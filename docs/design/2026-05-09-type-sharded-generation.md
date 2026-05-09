# Type-Sharded Question Generation — Design Document

**Date:** 2026-05-09  
**Status:** DRAFT — awaiting approval before implementation  
**Author:** Copilot design pass  
**Prerequisite reading:** `docs/05-ai-pipeline.md`, `prompts/skills/generate-questions/SKILL.md`

---

## 1. Goals and non-goals

### Goals

Replace the single omnibus `generate-questions` skill (one Claude subprocess, all types, full-level KB)
with four type-specialist skills — `generate-mcq`, `generate-log-analysis`, `generate-scenario`,
`generate-kql` — each receiving a KB slice containing only sources relevant to its question type.
Fan the four skills out in parallel within a single admin-click handler invocation to reduce
wall-clock from ~3 min (30 mixed questions, cold). Stage 1 targets ~135–180 s with a concurrency
cap of 2 subprocesses (VPS shared-tenant RAM constraint; see §4). Stage 1.5 raises the cap to 4
after 1 week of clean operation and a peak-RSS measurement, targeting ≤90 s. Assign
claude-sonnet-4-6 to all four type skills (homogeneous model stack; see §2). Allow per-type count
allocation via auto-weighted defaults (from the existing omnibus weight table) with admin override;
set any type to 0 to skip it entirely. Maintain the no-ambient-AI invariant: all calls remain
sync-on-admin-click, inside the existing `singleFlight` mutex, never in a worker or cron. Deliver
an eval baseline that lets per-type quality be compared against the omnibus before promotion to
default.

### Non-goals

- **Not changing grading skills.** `grade-anchors`, `grade-band`, `grade-escalate` are untouched.
  This design is generation-only.
- **Not bypassing `ai_draft` review.** Generated questions still land with `status='ai_draft'`.
  The admin promotion step is unchanged.
- **Not auto-publishing.** No automated pipeline from generation to `status='active'`.
- **Not running parallel calls per individual question.** This is *type-sharding* — one skill call
  per type per admin request. Chunking within a single type (Option B from the chunking plan)
  is explicitly deferred to a post-eval follow-up; this design does not compose them.
- **Not changing the Phase 1 vs Phase 2 boundary.** All skills run through the
  `claude-code-vps` runtime (Max OAuth on VPS), never through the Anthropic API or BullMQ.
- **Not shipping `generate-scenario-opus` in Stage 1.** A future escalation skill for L3
  packs where eval data shows scenario quality regression versus the omnibus. Deferred until
  Stage 2 eval results are available to justify the Opus wall-clock cost.

---

## 2. Skill inventory

### Model justification

| Skill | Model | Justification |
|---|---|---|
| `generate-mcq` | claude-sonnet-4-6 | MCQ content is structurally simple, but L3 distractors require precise TTP sub-technique discrimination. A homogeneous Sonnet stack trades Haiku's cost advantage for consistent quality across all levels; see §8 Risk #1. |
| `generate-log-analysis` | claude-sonnet-4-6 | Requires constructing synthetic multi-line log excerpts with exact field names (Sysmon EventID 1, Windows Event 4625 fields, JSON syslog schemas). Haiku produces plausible-looking but field-incorrect log snippets at non-trivial rates. |
| `generate-scenario` | claude-sonnet-4-6 | Multi-step narrative coherence and DAG branching require reasoning beyond Haiku's reliable range. Opus would be stronger but is the wall-clock bottleneck (see §4); Sonnet is the pragmatic choice. |
| `generate-kql` | claude-sonnet-4-6 | KQL questions require syntactically valid queries against real Microsoft Sentinel/Defender table schemas (`SecurityEvent`, `DeviceProcessEvents`, `SigninLogs`). Haiku's KQL reliability is insufficient for exam-grade content. |

**Decision (2026-05-09, Q1): All four skills use claude-sonnet-4-6.** Opus would improve
scenario narrative quality but its lower throughput (~5K t/min vs Sonnet's ~20K t/min) makes
it a wall-clock bottleneck at any concurrency cap. A deferred `generate-scenario-opus`
escalation skill (analogous to `grade-escalate`) is planned for L3 packs where Stage 2 eval
shows scenario quality regression versus the omnibus. It is **not shipped in Stage 1** (see §1
Non-goals).

### Token and cost estimates

**Assumptions:**  
- Sonnet-4-6 price ratio: input $3/M, output $15/M (public card, 2026-05).  
- Haiku-4-5 ratio: ≈0.27× Sonnet → input $0.80/M, output $4/M.  
- Phase 1 cost is Max subscription (flat); estimates are for Phase 2 planning.  
- Sonnet output throughput: ~20K t/min. Haiku: ~50K t/min.  
- Cold-start overhead per claude subprocess: ~12–18 s (process fork + skill load).  
  With N skills launching simultaneously, cold-start is paid once, not N times.

| Skill | Input tokens | Output tokens (10 Qs) | Cache creation | Wall-clock target | Phase 2 cost / call |
|---|---|---|---|---|---|
| `generate-mcq` | ~7 K (2.5 K system + 4.5 K KB slice) | ~2.5 K | ~7 K | 25–40 s | ~$0.058 |
| `generate-log-analysis` | ~7.5 K (2.5 K system + 5 K KB slice) | ~6.5 K (log excerpts are large) | ~7.5 K | 45–70 s | ~$0.120 |
| `generate-scenario` | ~7 K (2.5 K system + 4.5 K KB slice) | ~4 K | ~7 K | 30–50 s | ~$0.081 |
| `generate-kql` | ~6.5 K (2.5 K system + 4 K KB slice) | ~3.5 K | ~6.5 K | 25–40 s | ~$0.073 |

**Composite for 30 questions (MCQ:10, log_analysis:10, scenario:7, kql:3), Stage 1 cap=2:**  
At full parallelism (cap=4): max(40, 70, 50, 40) + 15 s cold-start ≈ 85 s.  
At Stage 1 cap=2: two sequential batches. Batch 1 (log_analysis + MCQ): ~70 s + 15 s
cold-start = 85 s. Batch 2 (scenario + KQL): ~50 s. Total ≈ **135 s** — within Stage 1
target of ≤180 s. Stage 1.5 target after cap raised to 4: ≤90 s.

**Omnibus baseline (30 questions):**  
~25 K input + ~10 K output on Sonnet → $0.225 per request.  
Type-sharded (all four skills on Sonnet): ~$0.332 per request — ~48% more expensive at Phase 2.
MCQ moving from Haiku to Sonnet accounts for the majority of the delta (~$0.042). With prompt
caching (Phase 2), static skill content cached across runs reduces the gap.

---

## 3. KB slicing

### Source fields used for slicing

Every KB source has: `id`, `name`, `citation`, `url`, `level_fit`, `function`, `description`,
`tags[]`, `kb_version`. Slicing operates on `tags` and `function`.

### Per-skill slice criteria

| Skill | Include sources where… | Rationale |
|---|---|---|
| `generate-mcq` | All sources at the requested `level_fit` | MCQ can span any SOC concept; breadth is desirable to avoid topic repetition. |
| `generate-log-analysis` | `tags` contains any of: `windows-event`, `sysmon`, `eventlog`, `edr`, `SIEM`, `event-4625`, `event-4769`, `event-4104`, `4625`, `network-analysis`, `beacon`, `JA3` | Log analysis questions need concrete log-artifact evidence. Sources without log references produce artificially constrained excerpts. |
| `generate-scenario` | `function` is `response` OR `incident-response` OR `triage` OR `hunting`; OR `tags` contains any of: `incident-response`, `containment`, `lateral-movement`, `ransomware`, `triage` | Scenario questions require a narrative arc — an incident that unfolds across steps. Detection-only or governance sources don't give the analyst a "decision chain" to traverse. |
| `generate-kql` | `function` is `detection` OR `hunting`; OR `tags` contains any of: `SIEM`, `KQL`, `Sigma`, `hunting`, `C2`, `beacon`, `threat-hunting` | KQL questions must reference log tables that exist in Microsoft Sentinel/Defender. Detection-tagged sources describe events observable via KQL. |

### Fallback: fewer than 3 sources match

If a slice produces fewer than 3 sources, fall back to the full level KB for that skill —
same behavior as the current omnibus. Log `generation.kb_slice.fallback` with the slice size
and the triggering skill so the KB can be enriched over time. The fallback is silent to
the admin (no UI warning in Phase 1).

### Estimated slice sizes (based on partial KB reads; **treat as illustrative — verify against actual JSON**)

| Level | Total sources (est.) | `generate-mcq` | `generate-log-analysis` | `generate-scenario` | `generate-kql` |
|---|---|---|---|---|---|
| L1 | ~20 | ~20 | ~6–9 | ~5–7 | ~4–6 |
| L2 | ~25 | ~25 | ~10–14 | ~7–10 | ~6–9 |
| L3 | ~20 | ~20 | ~6–9 | ~6–8 | ~7–10 |

Open question Q5 asks for exact counts — implementation must verify these before wiring
the KB-source-count preview in the UI.

---

## 4. Handler / runtime shape

### Current architecture recap

`admin-generate.ts` has two paths:  
- **Single call** (count ≤ 10): one `generateQuestions()` call inside the `singleFlight` slot.  
- **Chunked parallel** (count 11–30): up to 3 `generateQuestions()` calls via `Promise.allSettled`,
  all using the same omnibus skill, sharing a topic-dedup set.

The `singleFlight` mutex is keyed `generation:${packId}:${levelId}` and is shared with grading.

### Proposed sharded architecture

In `AI_GENERATE_MODE=sharded`, the handler replaces the "chunked parallel" strategy with
a "type-fan-out" strategy. The mutex shape stays identical — one slot per pack+level, acquired
once, released after all type calls complete.

```
Admin clicks "Generate { mcq: 10, log_analysis: 10, scenario: 7, kql: 3 }"
  │
  ▼
POST /admin/packs/:packId/levels/:levelId/generate
  │  { mode: "sharded", counts: { mcq:10, log_analysis:10, scenario:7, kql:3 } }
  │
  ▼
handleAdminGenerate() — validates per-type counts (each 0–12, total 1–30)
  │
  ▼
singleFlight.acquire("generation:packId:levelId")   ← same mutex as today
  │  rejected → 409 Conflict (same as today)
  │
  ▼
sliceKbSources(allSources) → { mcqSources, logSources, scenarioSources, kqlSources }
  │
  ▼
Promise.allSettled([
  counts.mcq > 0      → generateMcqQuestions(mcqSources, counts.mcq),
  counts.log_analysis > 0 → generateLogAnalysisQuestions(logSources, counts.log_analysis),
  counts.scenario > 0 → generateScenarioQuestions(scenarioSources, counts.scenario),
  counts.kql > 0      → generateKqlQuestions(kqlSources, counts.kql),
])
  │   (capped at 2 concurrent via semaphore — Stage 1; raise to 4 after Stage 1.5 gate)
  │
  ▼
merge results → topic-dedupe against existingTopics + within this run
  │
  ▼
insertDrafts() — bulk INSERT with status='ai_draft' (unchanged)
  │
  ▼
singleFlight.release()
  │
  ▼
Return { questionIds, generated, skillShas: { mcq, log_analysis, scenario, kql } }
```

**Does this compose with Option B (intra-type chunking)?**  
Not in Phase 1. Option B chunking (3 chunks × 10 of the same skill) would add a second axis
of parallelism: up to 4 types × 3 chunks = 12 concurrent claude subprocesses. This is
deferred because: (1) the VPS RAM budget needs verification (§4 risks), (2) the eval harness
should be in place before compounding two experimental changes. In Phase 1.5, if a user requests
>12 questions of one type, each type can chunked internally using `Promise.allSettled` within
its own type branch.

### Single-flight shape

**Recommendation: per-pack:level mutex, N types within one slot (current shape, unchanged).**

Alternatives considered and rejected:

| Option | Shape | Rejected because |
|---|---|---|
| Per-pack:level:type (5 slots) | Allow concurrent generation requests across types from two admin clicks | Two simultaneous admin "Generate" clicks for the same pack/level would produce overlapping topics; the dedup set is not shared across requests. |
| Per-pack:level (current) — one slot, N types inside | One admin click fans out to N types atomically | ✓ Selected. Atomicity preserved. Topic dedup runs once on merged results. |
| Global single-flight | Only one generation in the entire API process at a time | Too restrictive; blocks one pack while another is generating. No need. |

**Interaction with grading mutex:** The generation mutex key is `generation:packId:levelId`.
The grading mutex key is different (attempt-based). They share the same `singleFlight` registry
but different keys, so generation and grading can run concurrently unless the grading handler
was explicitly wired to the same key (verify in implementation).

### Concurrent subprocess budget

**Decision (2026-05-09, Q2): Stage 1 concurrency cap = 2.** The VPS has ~4.4 GB available
headroom but shares the box with at least 4 other apps (A11yOS/AccessBridge umbrella). Two
concurrent claude processes at ~250 MB RSS peak = ~500 MB worst-case — well within headroom
even during co-tenant spikes. Four concurrent would peak at ~1 GB, which is acceptable
normally but risky if another app has a burst at the same moment.

At cap=2, the type fan-out runs two sequential batches. Implementation batches by estimated
duration: batch 1 (log_analysis + mcq — the two highest-count types) runs first; batch 2
(scenario + kql) runs immediately after. For a 30-question run:
~85 s (batch 1) + ~50 s (batch 2) ≈ **135 s** total — within the Stage 1 target of ≤180 s.

**Stage 1.5 promotion gate (after 1 week of clean Stage 2 operation):**  
Run a full 4-type generation on the dev tenant, sample `docker stats --no-stream assessiq-api`
at 5 s intervals during the run, record max container RSS.
- **Threshold to raise cap to 4:** max system-wide RSS across all containers during
  generation < 3.5 GB. At cap=4, all 4 types run in a single batch targeting ≤90 s.
- If threshold is not met, cap remains at 2; revisit when co-tenant apps have explicit
  Docker memory limits.

The 15-concurrent-subprocess scenario (5 types × 3 chunks from Option B) is not proposed
for Phase 1 and requires separate capacity planning.

---

## 5. UI shape

### Per-type counts modal (proposed)

**Default behavior (Q4 decision, 2026-05-09):** Admin sets a total count and level; the handler
auto-derives per-type counts from the weight table below. Each chip is editable; the total
updates live. Setting any type to 0 skips that skill entirely (clean per-type off-switch).

```
┌──────────────────────────────────────────────────────────────────┐
│  Generate Questions — SOC L2                                     │
├──────────────────────────────────────────────────────────────────┤
│  Total:  [ 30 ]   Level: ( L1 )  ( L2 ●)  ( L3 )               │
│                                                                  │
│  ── Auto-weighted from L2 defaults (35/30/20/10/5%) ──────────  │
│  [ MCQ: 11 ]  [ Log Analysis: 9 ]  [ Scenario: 6 ]  [ KQL: 4 ] │
│  [ Subjective: 0 ]  ← set to 0 skips skill entirely             │
│                                                                  │
│  Type           Count    KB sources     Est. wall-clock          │
│  ──────────────────────────────────────────────────────────────  │
│  MCQ            [ 11 ]   (25 sources)   ~35 s  (batch 1)        │
│  Log Analysis   [  9 ]   (12 sources)   ~55 s  ← bottleneck     │
│  Scenario       [  6 ]   ( 8 sources)   ~42 s  (batch 2)        │
│  KQL            [  4 ]   ( 7 sources)   ~30 s  (batch 2)        │
│  Subjective     [  0 ]   (omnibus)       —                      │
│  ──────────────────────────────────────────────────────────────  │
│  Total: 30 qs   Expected: ~150 s  (cap=2, 2 batches)            │
│                                                                  │
│  Presets: [ Balanced L1 ]  [ Balanced L2 ]  [ Balanced L3 ]     │
│  [ Generate Any — omnibus (30) ]        [ ▶ Generate (30) ]     │
└──────────────────────────────────────────────────────────────────┘
```

**Weight table by level** (auto-derived counts round to nearest integer, total enforced):

| Level | MCQ | Log Analysis | Scenario | KQL | Subjective |
|---|---|---|---|---|---|
| L1 | 50% | 30% | 10% | 5% | 5% |
| L2 | 35% | 30% | 20% | 10% | 5% |
| L3 | 20% | 20% | 25% | 20% | 15% |

Subjective always routes to the omnibus skill; if Subjective count > 0, one omnibus call is
added to the fan-out sequentially after the type-skill batches complete.

**"KB sources (N sources)"** is computed client-side from the slicing criteria applied against
the pack's SOC level, loaded eagerly when the modal opens. If any type slice shows
"(< 3 sources)", the UI warns inline: "Sparse KB — will fall back to full level KB."

**"Est. wall-clock"** labels each type with its batch (1 or 2) and flags the bottleneck.
The composite estimate is `batch1_max + batch2_max + 20 s overhead`. At Stage 1.5 cap=4,
both batches collapse to one and the estimate drops to `max(all_types) + 15 s`.

**Preset buttons** auto-fill per-type chips using the weight table; the admin can still
override individual values after selecting a preset.

**Decision: keep omnibus as "Generate Any" fallback — yes.**  
Remove it only after Stage 3 flip AND 30 days clean operation AND eval parity is confirmed
(§7 Stage 4 gate). Removing too early loses the admin's safety net and complicates rollback.

---

## 6. Eval baseline

### Directory layout (proposed additions to existing `eval/`)

The existing `eval/` directory serves grading quality evaluation (subjective/scenario answer
scoring). Generation quality is a different concern. Proposed additions:

```
eval/
├── golden-questions/              ← NEW: curated reference questions per type
│   ├── mcq/
│   │   └── <id>.json             # question + correct answer + per-distractor annotation
│   ├── log_analysis/
│   │   └── <id>.json             # question + log_excerpt + expected_findings + format
│   ├── scenario/
│   │   └── <id>.json             # title + steps + step_dependency annotation
│   └── kql/
│       └── <id>.json             # question + expected_keywords + sample_solution
├── fixtures/                      ← NEW: KB slices used in eval runs (not full JSON)
│   ├── l1/
│   │   ├── mcq-slice.json
│   │   ├── log-analysis-slice.json
│   │   ├── scenario-slice.json
│   │   └── kql-slice.json
│   ├── l2/  (same structure)
│   └── l3/  (same structure)
├── baseline.json                  ← NEW: omnibus scores on golden set (pre-sharding reference)
├── cli.ts                         ← EXISTING (grading eval — unchanged)
├── cases/                         ← EXISTING (grading eval — unchanged)
├── runs/                          ← EXISTING (grading eval — unchanged)
├── baselines/                     ← EXISTING (grading eval — unchanged)
└── README.md                      ← UPDATE to document generation eval section
```

**`runner.ts` is NOT created as part of this design deliverable.** The runner shape is
proposed here for review; it becomes a Phase 1.5 implementation item.

### Runner shape (proposal — not implemented yet)

The generation eval runner invokes each skill against a fixture KB slice and evaluates the
output on five dimensions:

1. **Schema validity** — does every question conform to the type's content schema?
   Mechanically checkable (Zod). Pass/fail.
2. **Citation fidelity** — does `knowledge_base_source_ids` reference only sources in the
   provided fixture? Mechanically checkable. Pass/fail.
3. **MITRE mapping correctness** — for log_analysis and scenario, does the question cite
   a MITRE technique that exists in the referenced source's tags?
   Fuzzy-checkable (tag substring match). Scored 0–1.
4. **Distractor plausibility (MCQ only)** — do the three wrong options appear technically
   plausible to a junior reader? Requires human annotation on golden set; auto-scored by
   comparing generated distractors against annotated "plausible distractor categories" in
   the golden file.
5. **Difficulty fit** — do question point values align with level expectations?
   Heuristic: L1 MCQ points should be 1–3, L3 scenario points 6–10. Mechanically checkable.

### Golden question counts

| Type | Recommended count | Reasoning |
|---|---|---|
| MCQ | 25 per level × 3 levels = 75 total | MCQ quality is easiest to annotate; high-volume set enables per-distractor plausibility stats. |
| Log analysis | 15 per level × 3 = 45 | Log excerpt realism is expensive to annotate — annotator must verify field names against format spec. |
| Scenario | 10 per level × 3 = 30 | Step-coherence annotation is the most time-intensive; 10 per level is the minimum defensible set. |
| KQL | 15 per level × 3 = 45 | KQL syntax can be auto-checked; annotation validates table/field correctness. |
| **Total** | **195 questions** | Spread across 3 levels × 4 types. Level-stratified so L3 regression is separately tracked. |

**Minimum viable baseline (MVP for Stage 1 gate):** 10 per type per level = 120 questions.
The 195-question target is the steady-state goal after the first eval cycle.

### When does the eval run?

- **Pre-merge (CI):** Schema validation (dimension 1) and citation fidelity (dimension 2)
  run in CI without calling Claude. The golden files + fixtures are static; these checks
  are pure JSON comparisons. Runtime: <5 s.
- **Manual (pre-promotion):** Dimensions 3–5 require a live skill call against fixtures.
  Run manually by the admin before each Stage promotion (§7). Produces a timestamped
  run report under `eval/runs/`. No CI Max OAuth available (per existing eval harness design).
- **Both:** The CI gate prevents broken schemas from being merged; the manual gate ensures
  quality before enabling `AI_GENERATE_MODE=sharded` for any tenant.

`baseline.json` records the omnibus skill's scores on the golden set (pre-sharding).
Per-type skills must meet or exceed the omnibus score on each dimension before Stage 2.

---

## 7. Migration plan

### Feature flag

`AI_GENERATE_MODE` env var (extends existing `AI_PIPELINE_MODE`).

| Value | Behavior |
|---|---|
| `omnibus` | Default. Current behavior: one `generate-questions` skill call. |
| `sharded` | New behavior: per-type skill fan-out. |

The flag is read in `admin-generate.ts` (or the runtime-selector). No other file changes.

### Stage 1 — Ship per-type skills behind default=omnibus

- Create the 4 SKILL.md files in `prompts/skills/` (this deliverable, as DRAFT).
- Finalize skills (version `DRAFT-2026-05-09` → `1.0.0`), deploy to VPS `~/.claude/skills/`.
- Wire the `AI_GENERATE_MODE=sharded` branch in the handler (no-op while flag is `omnibus`).
- Implement type fan-out with **concurrency cap = 2** via a lightweight semaphore, configurable
  via `GENERATE_SUBPROCESS_CAP` env var (default: `2`).
- Run eval harness against fixtures; establish `baseline.json`.

**Gate to Stage 2:** eval baseline recorded, CI schema checks pass, skill SHAs stable,
and cap=2 integration test completes in ≤180 s for 30 questions on the dev machine.

### Stage 1.5 — Measure peak RSS; decide cap=4 promotion

Run after at least 1 week of clean Stage 2 (test-tenant) operation:
- Trigger a full 4-type generation (30 questions) on the dev tenant while sampling
  `docker stats --no-stream assessiq-api` at 5 s intervals. Record peak system-wide RSS.
- **If peak RSS < 3.5 GB:** raise `GENERATE_SUBPROCESS_CAP` to 4. Expected wall-clock drops
  from ~135 s to ≤90 s. Update Stage 2 gate threshold accordingly (see gate below).
- **If peak RSS ≥ 3.5 GB:** cap remains at 2. Revisit when co-tenant apps gain explicit
  Docker memory limits. Stage 2 gate threshold stays at ≤180 s.

### Stage 2 — Enable `AI_GENERATE_MODE=sharded` for one test tenant (two-week window)

- Set `AI_GENERATE_MODE=sharded` for one named tenant (e.g., the dev tenant).
- Keep all other tenants on `omnibus`.
- Admin runs parallel generation sessions on both modes for the same pack/level and
  compares `ai_draft` outputs.
- Metrics tracked: wall-clock (from `generation_attempts.duration_ms`), success rate,
  `chunks_failed` rate, `dedupe_dropped` rate, admin feedback (qualitative).

**Gate to Stage 3:**
- Mean wall-clock for 30 questions: ≤180 s at cap=2, or ≤90 s if Stage 1.5 raised cap to 4.
  (p90 ≤ 1.4× the applicable mean threshold.)
- Success rate ≥ 95% (at most 1 failed type per 20 runs).
- Zero eval regressions on any dimension vs. `baseline.json`.
- No admin-reported quality complaint requiring rollback.

### Stage 3 — Flip default to `sharded`

- Set `AI_GENERATE_MODE=sharded` globally. `omnibus` remains available for explicit rollback.
- Monitor `generation_attempts` for 30 days: alert if p90 > 120 s or failure rate > 5%.

**Gate to Stage 4:** 30 days clean, zero rollback events.

### Stage 4 — Remove omnibus

- Delete `prompts/skills/generate-questions/SKILL.md`.
- Remove `omnibus` branch from handler.
- Archive skill SHA in `docs/RCA_LOG.md` for historical reference.

**Gate:** Only after Stage 3 is stable. No earlier.

---

## 8. Risks

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Homogeneous Sonnet stack lowers L3 scenario quality ceiling.** Moving all four skills to Sonnet eliminates cross-model quality variance but removes the Opus ceiling for scenario narrative depth and TTP precision. L3 scenario questions may be shallower than what the omnibus produced if it implicitly used a stronger model for complex requests. | Low–Medium | Medium | Monitor eval dimension 5 (difficulty fit) and scenario step-coherence in Stage 2. If regression is detected, `generate-scenario-opus` (§1 Non-goals, deferred) becomes the remediation path. |
| 2 | **Cross-skill citation mismatch.** KB slicing means MCQ and scenario questions in the same pack cite different sources; a pack about "Kerberoasting" might have scenario questions with no Kerberoasting reference if it sliced to incident-response sources. Topical coherence within a pack degrades. | Low–Medium | Medium | The omnibus's `topic_focus` param can still be passed to each type-skill; the KB slice is already narrowed by type. Add a `topic_coverage_check` to the eval runner: confirm that ≥1 source in the MCQ slice and ≥1 source in the scenario slice share a common tag cluster. |
| 3 | **Increased cost at Phase 2.** Four skill calls × ~28 K total input vs one call × 25 K input. Phase 2 cost per run: ~$0.29 vs ~$0.23 (omnibus), a 26% increase. With prompt caching, static skill content is cached across runs; only KB slice input is non-cacheable. | Medium | Low (Phase 1) / Medium (Phase 2) | Accept for Phase 1. Plan prompt-caching strategy before Phase 2 migration. Document the cost delta in Phase 2 budget planning. |
| 4 | **Eval baseline too thin to detect regressions.** 10 golden questions per type per level is the minimum viable set. Subtle shifts in distractor quality or log-excerpt realism may not surface at 10-sample granularity. | High | Medium | Grow golden set by 5 per type per level each quarter. Set CI alert: if eval set has not grown in 90 days, open a backlog ticket. |
| 5 | **Per-type UI confusing admins who liked the simple slider.** Some admins want "give me 30 varied questions" without thinking about type allocation. The new modal adds cognitive overhead. | Medium | Low | Auto-weighted defaults (§5) mean the modal opens pre-filled; the admin rarely needs to touch individual chips. Preset buttons ("Balanced L1/L2/L3") and the "Generate Any" omnibus shortcut are permanent escape hatches. |

### Constraint: codex:rescue gate scope

**The `CLAUDE_SPAWN_ALLOW_LIST` in `modules/07-ai-grading/ci/lint-no-ambient-claude.ts` is
FILE-level, not skill-level.** The two currently allowed files (`admin-generate.ts`,
`claude-code-vps.ts`) already cover all spawn sites. `runSkill()` in `claude-code-vps.ts`
parameterizes the skill name — adding 4 new type skills introduces zero new spawn sites
and therefore requires no lint allowlist change.

`codex:rescue` adversarial review is required for Stage 1 implementation **only if**:
- The lint file itself is modified (e.g., to add a new file to the allowlist), OR
- A new file is added under `modules/07-ai-grading/src/runtimes/` (which would bypass
  the parameterized `runSkill()` path).

The implementation plan MUST keep all 4 type skills routed through the existing
`claude-code-vps.ts` runtime to avoid triggering this gate.

---

## 9. Open questions for the user

Questions 1 (scenario model), 2 (concurrency cap), and 4 (per-type count allocation) are
**resolved** — see §1, §4, and §5 respectively. The following are still open and must be
answered before Stage 1 implementation begins.

1. **singleFlight mutex shared with grading.** Generation and grading currently share the
   same `singleFlight` registry (different keys). With 2–4 concurrent generation subprocesses,
   can the admin still click "Grade next" on an unrelated attempt simultaneously, or does the
   shared registry create any unexpected contention? Should generation and grading have
   separate mutex registries for clarity?

2. **Exact KB source counts per level.** The slice estimate table in §3 is based on partial
   file reads. Before wiring the KB-source-count preview in the UI, implementation needs
   exact per-level counts per slice criterion. Should implementation compute these
   programmatically at request time (always current) or derive them from a static lookup
   baked into the frontend (simpler but stale when KB is updated)?

3. **KQL scope: Microsoft Sentinel / Defender only, or also Splunk SPL / Sigma?** The
   `generate-kql` skill currently targets KQL only. The L3 KB contains sources referencing
   Splunk SPL and Sigma rules. Should the skill generate KQL-only questions, or also support
   SPL/Sigma? If multi-platform, the skill name and quality standards need adjustment.

4. **Subjective exclusion permanent?** Subjective is excluded from type-sharding (omnibus
   handles it). Should this be permanent, or is there a quality-improvement case for a
   `generate-subjective` skill later (e.g., to improve rubric pre-population for the
   generate-rubric downstream skill)?

5. **`skillShas` in the response.** The current handler returns a single `skillSha`. With
   four skills, the handler would return `skillShas: { mcq, log_analysis, scenario, kql }`.
   The `generation_attempts` table's `skill_sha` column is a single varchar. Should this be
   JSON-stringified into the existing column, or should the table gain a `skill_shas` jsonb
   column? This schema decision is a Stage 1 blocker.

6. **"Generate Any" omnibus: shown to all admins or super-admins only?** If the omnibus is
   kept as an escape hatch, should it be hidden from tenant admins (to enforce sharded-only
   quality path) and available only to platform super-admins for debugging?

**Residual from Q2 (cap=4 promotion):** The 3.5 GB peak-RSS threshold in §4 Stage 1.5 is
an estimate, not yet empirically measured. The threshold is the primary unknown that gates
raising the cap to 4 and hitting the ≤90 s wall-clock target. This is a Stage 1.5 action
item, not a pre-implementation blocker.
