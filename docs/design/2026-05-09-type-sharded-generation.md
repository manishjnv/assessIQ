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
wall-clock from ~3 min (30 mixed questions, cold) to ≤90 s. Assign models per skill based on
output complexity: Haiku-4-5 for MCQ, Sonnet-4-6 for the rest. Allow per-type tuning of count,
model, and KB scope independently of one another. Maintain the no-ambient-AI invariant: all calls
remain sync-on-admin-click, inside the existing `singleFlight` mutex, never in a worker or cron.
Deliver an eval baseline that lets per-type quality be compared against the omnibus before
promotion to default.

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

---

## 2. Skill inventory

### Model justification

| Skill | Model | Justification |
|---|---|---|
| `generate-mcq` | claude-haiku-4-5 | MCQ content is structurally simple: one question + 4 options + rationale. Haiku reliably handles this format at L1–L2 depth. L3 MCQs have denser distractors; risk is medium — see §8. |
| `generate-log-analysis` | claude-sonnet-4-6 | Requires constructing synthetic multi-line log excerpts with exact field names (Sysmon EventID 1, Windows Event 4625 fields, JSON syslog schemas). Haiku produces plausible-looking but field-incorrect log snippets at non-trivial rates. |
| `generate-scenario` | claude-sonnet-4-6 | Multi-step narrative coherence and DAG branching require reasoning beyond Haiku's reliable range. Opus would be stronger but is the wall-clock bottleneck (see §4); Sonnet is the pragmatic choice. |
| `generate-kql` | claude-sonnet-4-6 | KQL questions require syntactically valid queries against real Microsoft Sentinel/Defender table schemas (`SecurityEvent`, `DeviceProcessEvents`, `SigninLogs`). Haiku's KQL reliability is insufficient for exam-grade content. |

**Note on Opus for scenario:** The user's hypothesis mentioned "scenario on Opus." Opus would
improve narrative quality but its lower output throughput (~5K t/min vs Sonnet's ~20K t/min)
makes it the wall-clock bottleneck. With Opus generating 10 scenario questions (≈4K output tokens),
wall-clock is 80–120 s for that skill alone, blowing the 90 s total budget. `generate-scenario`
uses Sonnet; a separate `generate-scenario-opus` escalation skill (similar to `grade-escalate`)
is proposed as a follow-up for L3 pack authoring where quality outweighs speed.

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
| `generate-mcq` | ~7 K (2.5 K system + 4.5 K KB slice) | ~2.5 K | ~7 K | 20–35 s | ~$0.016 |
| `generate-log-analysis` | ~7.5 K (2.5 K system + 5 K KB slice) | ~6.5 K (log excerpts are large) | ~7.5 K | 45–70 s | ~$0.120 |
| `generate-scenario` | ~7 K (2.5 K system + 4.5 K KB slice) | ~4 K | ~7 K | 30–50 s | ~$0.081 |
| `generate-kql` | ~6.5 K (2.5 K system + 4 K KB slice) | ~3.5 K | ~6.5 K | 25–40 s | ~$0.073 |

**Composite for 30 questions (MCQ:10, log_analysis:10, scenario:7, kql:3) in parallel:**  
Wall-clock = max(35, 70, 44, 32) + 15 s cold-start ≈ **85 s** — within 90 s target.

**Omnibus baseline (30 questions):**  
~25 K input + ~10 K output on Sonnet → $0.225 per request.  
Type-sharded: ~$0.290 per request — ~29% more expensive at Phase 2 due to per-skill overhead.  
With prompt caching (Phase 2), the KB-slice cache hits on repeat requests reduce this gap.

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
  │   (N concurrent claude subprocesses — one per active type)
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

With 4 active types, there are 4 concurrent claude subprocesses per generation run. Each VPS
claude process uses approximately 150–250 MB RSS during inference. At 4 concurrent:
~600 MB–1 GB additional RAM during the ~60–70 s peak window. This is on top of the API process
and Postgres. **VPS RAM must be verified before implementation** (see Q2, §9). If RAM is
constrained (<2 GB free), a lightweight semaphore (max concurrency = 2) can throttle the
type fan-out at the cost of ~15–30 s additional wall-clock.

The 15-concurrent-subprocess scenario (5 types × 3 chunks from Option B) is not proposed
for Phase 1 and requires separate capacity planning.

---

## 5. UI shape

### Per-type counts modal (proposed)

```
┌─────────────────────────────────────────────────────────────────┐
│  Generate Questions — SOC L2                                    │
├─────────────────────────────────────────────────────────────────┤
│  Type             Count     KB sources    Est. wall-clock       │
│  ─────────────────────────────────────────────────────────────  │
│  MCQ              [ 10 ]   (25 sources)   ~20 s                 │
│  Log Analysis     [ 10 ]   (12 sources)   ~55 s  ← bottleneck  │
│  Scenario         [  5 ]   ( 8 sources)   ~40 s                 │
│  KQL              [  5 ]   ( 7 sources)   ~30 s                 │
│  Subjective       [  0 ]   (omnibus)      —                     │
│  ─────────────────────────────────────────────────────────────  │
│  Total: 30 questions    Expected: ~70 s  (limited by Log A.)    │
│                                                                 │
│  [ Generate Any (30 balanced) ]         [ ▶ Generate (30) ]    │
└─────────────────────────────────────────────────────────────────┘
```

**"Generate Any (N balanced)"** button triggers the omnibus skill with the existing count slider.
This is the backward-compatible escape hatch (see §7).

**"KB sources (N sources)"** is a live preview: the count is computed client-side from the
slicing criteria applied against the pack's SOC level. It gives the admin immediate feedback
before committing the request. If a type slice shows "(< 3 sources)", the UI warns: "Not enough
KB sources — will fall back to full level KB."

**"Est. wall-clock"** is a static lookup from a table baked into the frontend:  
`[level][type][count] → seconds estimate`. The bottleneck type is flagged `← bottleneck`.
The composite estimate shown is `max(per-type-estimates) + 15 s overhead`.

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
- Finalize skills (version `2026-05-09` → `1.0.0`), deploy to VPS `~/.claude/skills/`.
- Wire the `AI_GENERATE_MODE=sharded` branch in the handler (no-op while flag is `omnibus`).
- Run eval harness against fixtures; establish `baseline.json`.

**Gate to Stage 2:** eval baseline recorded, CI schema checks pass, skill SHAs are stable.

### Stage 2 — Enable `AI_GENERATE_MODE=sharded` for one test tenant (two-week window)

- Set `AI_GENERATE_MODE=sharded` for one named tenant (e.g., the dev tenant).
- Keep all other tenants on `omnibus`.
- Admin runs parallel generation sessions on both modes for the same pack/level and
  compares `ai_draft` outputs.
- Metrics tracked: wall-clock (from `generation_attempts.duration_ms`), success rate,
  `chunks_failed` rate, `dedupe_dropped` rate, admin feedback (qualitative).

**Gate to Stage 3:**
- Mean wall-clock for 30 questions < 90 s (p90 < 120 s).
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
| 1 | **Model drift between Haiku and Sonnet.** MCQ questions (Haiku) are systematically easier or less technically precise than log_analysis questions (Sonnet). An L3 pack authored with MCQ:Haiku + scenario:Sonnet has uneven difficulty calibration. | Medium | High | Add `difficulty_fit` dimension to eval (dimension 5). Flag L3 MCQs for human review during Stage 2. Consider L3-only `generate-mcq-sonnet` variant behind a flag. |
| 2 | **Cross-skill citation mismatch.** KB slicing means MCQ and scenario questions in the same pack cite different sources; a pack about "Kerberoasting" might have scenario questions with no Kerberoasting reference if it sliced to incident-response sources. Topical coherence within a pack degrades. | Low–Medium | Medium | The omnibus's `topic_focus` param can still be passed to each type-skill; the KB slice is already narrowed by type. Add a `topic_coverage_check` to the eval runner: confirm that ≥1 source in the MCQ slice and ≥1 source in the scenario slice share a common tag cluster. |
| 3 | **Increased cost at Phase 2.** Four skill calls × ~28 K total input vs one call × 25 K input. Phase 2 cost per run: ~$0.29 vs ~$0.23 (omnibus), a 26% increase. With prompt caching, static skill content is cached across runs; only KB slice input is non-cacheable. | Medium | Low (Phase 1) / Medium (Phase 2) | Accept for Phase 1. Plan prompt-caching strategy before Phase 2 migration. Document the cost delta in Phase 2 budget planning. |
| 4 | **Eval baseline too thin to detect regressions.** 10 golden questions per type per level is the minimum viable set. Subtle shifts in distractor quality or log-excerpt realism may not surface at 10-sample granularity. | High | Medium | Grow golden set by 5 per type per level each quarter. Set CI alert: if eval set has not grown in 90 days, open a backlog ticket. |
| 5 | **Per-type UI confusing admins who liked the simple slider.** Some admins want "give me 30 varied questions" without thinking about type allocation. The new modal adds cognitive overhead. | Medium | Low | Preserve "Generate Any (N balanced)" omnibus shortcut permanently (§5). Add preset buttons: "Balanced L1 (50/30/10/5/5)", "Balanced L2", "Balanced L3" that auto-fill the per-type inputs from the existing weight table. |

---

## 9. Open questions for the user

Please answer these before implementation is commissioned. These are the decisions that
cannot be resolved from the existing codebase.

1. **Scenario model: Sonnet or Opus?** The 90 s wall-clock target requires Sonnet for scenario.
   If quality is more important than speed for scenario questions, Opus is viable but will
   make scenario the bottleneck at 80–120 s, pushing total wall-clock past 90 s. Should
   the `generate-scenario` skill use Sonnet with an optional `generate-scenario-opus` variant,
   or should it always use Opus (accepting slower generation)?

2. **Max account subprocess concurrency.** Is there a known hard limit on concurrent claude
   subprocesses under the Max subscription on the VPS? 4 concurrent is the Phase 1 default;
   if the Max account throttles parallel sessions, the type fan-out will serialize and the
   wall-clock wins disappear. Should a 2-subprocess concurrency cap be the safe default
   while this is measured?

3. **singleFlight mutex shared with grading.** Currently, generation and grading share the
   same `singleFlight` registry (different keys). With 4 concurrent generation subprocesses,
   can the admin still click "Grade next" on an unrelated attempt simultaneously? Or should
   generation and grading have separate mutex registries to avoid confusion?

4. **Per-type count allocation: manual or auto-weighted?** Should the modal default to manual
   (admin sets each count) or auto-weighted from the existing weight table
   (L1: MCQ 50%, log 30%, scenario 10%, kql 5%, subjective 5%)? If auto-weighted, the admin
   sets total count and the weights fill in; they can then override individual types. This is
   a UX decision, not an engineering constraint.

5. **Exact KB source counts per level.** The KB slice estimate table in §3 is based on
   partial file reads. Before implementing the KB-source-count preview in the UI, exact
   counts per level per slice criterion are needed. Can you confirm the counts from the
   full `soc-l1.json`, `soc-l2.json`, `soc-l3.json`, or should implementation derive them
   programmatically at request time?

6. **KQL scope: Microsoft Sentinel / Defender only, or also Splunk SPL / Sigma?** The KQL
   skill is named `generate-kql`. The L3 KB contains sources referencing Splunk SPL and
   Sigma rules alongside KQL. Should the skill generate KQL-only questions, or also support
   SPL/Sigma? If multi-platform, the skill name and quality standards need adjustment.

7. **Subjective exclusion permanent?** The task excludes `generate-subjective` because the
   omnibus handles it adequately. Should subjective remain in the omnibus path permanently,
   or is there a quality-improvement case for a separate `generate-subjective` skill later
   (e.g., to improve rubric pre-population)?

8. **`skillShas` in the response.** The current handler returns a single `skillSha`. With
   four skills, the handler would return `skillShas: { mcq, log_analysis, scenario, kql }`.
   The `generation_attempts` table's `skill_sha` column is a single varchar. Should this be
   JSON-stringified into the column, or should the table gain a `skill_shas` jsonb column?
   This is a schema decision that belongs in §7 Stage 1.

9. **"Generate Any" omnibus: is it shown to all admins or only super-admins?** If the omnibus
   is kept as an escape hatch, should it be hidden from tenant admins (to enforce quality via
   sharded only) and available only to platform super-admins for debugging?
