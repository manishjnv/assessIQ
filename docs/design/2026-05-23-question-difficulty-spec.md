# Question Difficulty Spec — per-type intrinsic difficulty parameters (L1/L2/L3)

**Date:** 2026-05-23
**Status:** DRAFT — design decisions resolved (§9); awaiting approval to implement Phase A (§8)
**Prerequisite reading:** `docs/05-ai-pipeline.md`, `docs/design/2026-05-09-type-sharded-generation.md`, `prompts/skills/generate-*/SKILL.md`

---

## 1. Purpose & scope

Question difficulty has **two orthogonal axes**. Today the platform leans almost
entirely on the first and treats the second as one line of prose per type.

| Axis | What it controls | Where it lives today |
|---|---|---|
| **Composition** | *Which* types appear and in what mix | The level weight table in `generate-questions/SKILL.md:60-66` and `2026-05-09-type-sharded-generation.md §5` |
| **Intrinsic difficulty** | How hard *this individual item* is, holding type constant | One-line per-level hints (e.g. `generate-mcq/SKILL.md:62-67`); points/step-count proxies |

**This spec defines the intrinsic-difficulty axis** as structured, per-type
parameters with explicit L1/L2/L3 targets. It is the canonical source for:

1. what the generator is *told* to produce (skill input),
2. what each generated item is *tagged* with (data model),
3. what the post-generation validator *checks* (gate), and
4. what the empirical-calibration loop later *confirms* (response data).

### Non-goals

- **Does not change the composition weight table.** That axis is legitimate and stays.
- **Does not change scoring** (0/25/50/75/100 bands, points). Difficulty ≠ points.
- **Does not introduce IRT/CAT.** Empirical calibration here is classical item
  analysis (p-value, discrimination); IRT is a separate, later decision gated on volume.
- **Does not change the Phase-1 boundary.** Generation stays sync-on-admin-click;
  validation and calibration are deterministic (non-AI) and may run anywhere.

---

## 2. Design principles

1. **Construct-relevant difficulty only.** Difficulty must come from genuine skill
   and knowledge depth — never from construct-irrelevant sources (confusing wording,
   obscure trivia, double-negative "gotchas", excessive reading load). Those make an
   item *look* hard while measuring reading speed or luck, destroying validity.
2. **Difficulty is multi-dimensional.** A level target is a *vector* of parameters,
   not a single knob. An L3 item is harder along several named axes at once.
3. **Checkable where possible, human-reviewed otherwise.** Every parameter is
   classified as machine-checkable (hard gate or warn) or review-only.
4. **Asserted, then measured.** The spec sets the *intended* gradient; the
   empirical loop (§6) is what proves it real. A mislabeled item is a calibration bug.

---

## 3. Shared difficulty vocabulary (cross-cutting parameters)

These apply to every type; per-type sections add type-specific parameters.

| Parameter | Domain | Meaning |
|---|---|---|
| `cognitive_level` | `remember` \| `understand` \| `apply` \| `analyze` \| `evaluate` \| `create` | Revised Bloom level the *stem* demands. The single most important cross-cutting lever. **Layered with `nice_task_id` (§7)** per the 2026-05-23 decision — Bloom for cognitive demand, NICE for cyber-competency coverage. |
| `knowledge_granularity` | `concept` \| `procedure` \| `sub_technique_tool_specific` | How deep the required knowledge sits. |
| `stimulus` | `none` \| `short_artifact` \| `rich_multi_artifact` | Whether the candidate must interpret embedded evidence (a log line, command, timeline) *before* they can answer. |
| `inference_steps` | integer ≥ 1 | Minimum number of reasoning hops from stem to correct answer. |
| `kb_tier` | `L1` \| `L2` \| `L3` | The `level_fit` of the cited KB source(s) the item must draw on. |

---

## 4. Per-type difficulty specs

Each table gives the **target** per level. `Check` column: 🟢 machine-checkable
(hard or warn gate), 🟡 partially checkable (heuristic/warn), 🔴 human review only.

### 4.1 MCQ — content shape `{ question, options[4], correct, rationale }`

| Parameter | L1 | L2 | L3 | Check |
|---|---|---|---|---|
| `cognitive_level` | remember / understand | apply / analyze | analyze / evaluate | 🟡 (verb heuristic) |
| `answer_model` | one clearly-correct answer | best-of-plausible | **best-of-valid** (all 4 are technically valid in *some* context; one is best for *this* artifact) | 🔴 |
| `distractor_homogeneity` | low | medium | high | 🟢 (option embedding similarity) |
| `option_semantic_similarity` (proxy) | cosine ≈ 0.2-0.4 | ≈ 0.4-0.6 | ≈ 0.6-0.8 | 🟢 |
| `stimulus` | none | short_artifact (optional) | **rich_multi_artifact (required)** — stem embeds a log/command/event | 🟡 (code/log block present in stem) |
| `inference_steps` | 1 | 2 | ≥ 3 | 🔴 |
| `knowledge_granularity` | concept (event IDs, framework names) | procedure (correlation, common mistakes) | sub_technique_tool_specific (flags, versions, sub-techniques) | 🔴 |

**The #1 lever is `distractor_homogeneity`.** An L1 item has one obviously-right
answer among plausible-ish wrongs; an L3 item makes all four options *real, valid*
concepts and forces discrimination of the *best* one. (The existing 4104-vs-4103-vs-4688-vs-Sysmon-1
example in `generate-mcq/SKILL.md` already does this — the spec just names it as the mechanism and makes it mandatory at L3.)

> **L1 vs L3, same topic (PowerShell logging):**
> - **L1:** "Which Windows event ID records PowerShell script block content?" Options: 4104 / 4624 / 7045 / 1102 — only one is even a PowerShell log. (recall, homogeneity low, no stimulus)
> - **L3:** Stem embeds `powershell -enc <b64>` + a note that 4103 is absent but 4104 present. "Which log source yields the *decoded* payload, and what does the 4103 gap imply?" Options: four *real* log sources, each correct for a different sub-question. (analyze/evaluate, homogeneity high, rich stimulus, ≥3 inference steps)

### 4.2 log_analysis — `{ question, log_excerpt, log_format, expected_findings[], hint?, sample_solution? }`

| Parameter | L1 | L2 | L3 | Check |
|---|---|---|---|---|
| `cognitive_level` | understand / apply | analyze | analyze / evaluate | 🟡 |
| `log_lines` | ≤ 8 | 10-20 | 20-30 | 🟢 (count newlines in `log_excerpt`) |
| `decoy_ratio` (benign/noise lines ÷ total) | ~0% | ~30% | ≥ 50% | 🔴 |
| `findings_count` | 1 | 2-3 | 3-5 | 🟢 (`expected_findings.length`) |
| `cross_event_correlation` | false (single-line tell) | sometimes | **true** (finding only emerges across lines) | 🔴 |
| `obfuscation` | none | encoding (optional) | encoding / timestomp / deliberate log gap (≥1 present) | 🟡 (regex for base64/`-enc`) |

> **L1:** 6 clean syslog lines, one obvious failed-auth burst → one finding.
> **L3:** 28 lines mixing benign admin activity with a slow brute-force + a single
> success + a timestomp gap; 4 interdependent findings requiring correlation.

### 4.3 kql — `{ question, tables[], hint?, expected_keywords[], sample_solution }`

| Parameter | L1 | L2 | L3 | Check |
|---|---|---|---|---|
| `cognitive_level` | apply | apply / analyze | analyze / create | 🟡 |
| `query_constructs` (in `sample_solution`) | `where` / filter | `where` + (`summarize` **or** time-window) | multi-table `join` + `summarize` + `parse`/`extend` + time-window correlation | 🟢 (regex: `join`,`summarize`,`parse`,`extend`,`bin`,`ago`) |
| `tables_count` | 1 | 1-2 | 2-3 | 🟢 (`tables.length`) |
| `table_given` | true (table named in stem) | partial | **false** — candidate must know which table holds the signal | 🟡 (generation-input flag) |
| `detection_logic` | exact match | conditional | behavioral/statistical (beaconing interval, rare-process) | 🔴 |

> **L1:** "In `SigninLogs`, filter failed sign-ins from one IP." → single `where`.
> **L3:** "Detect low-byte fixed-interval HTTPS beaconing." → candidate must pick
> `DeviceNetworkEvents`, `summarize` by interval, compute regularity. (create-level)

### 4.4 scenario — `{ title, intro, step_dependency, steps[{prompt, expected}] }`

| Parameter | L1 | L2 | L3 | Check |
|---|---|---|---|---|
| `cognitive_level` | apply | analyze / evaluate | evaluate / create | 🟡 |
| `steps` | 2-3 | 3-4 | 4-5 | 🟢 (`steps.length`) — matches current skill |
| `step_dependency` | linear | linear | linear **or dag** | 🟢 (enum) |
| `inter_step_dependency` | independent | partial | **cascading** (a wrong early step changes later correct actions) | 🔴 |
| `evidence_ambiguity` | low (clear correct action) | medium | high (trade-offs: contain-now vs preserve-memory; incomplete info; business context) | 🔴 |
| `decoy_paths` | none | optional | **required** (a plausible-but-wrong action a mid-level analyst would take) | 🔴 |
| `mitre_required` | optional | true | true | 🟢 (regex `T\d{4}` in intro/steps) — matches current skill |

> **L1:** linear triage — classify alert → escalate. **L3:** branching ransomware
> incident where the first containment choice (isolate VLAN vs image memory) gates
> the recovery options two steps later, with a tempting wrong path.

### 4.5 subjective — `{ question }` + rubric (graded via the rubric DSL)

Difficulty is carried mostly by the **rubric calibration** (`LevelRubricDefaults`,
already implemented — `generate-rubric/SKILL.md:72-79`). This spec formalizes the targets.

| Parameter | L1 | L2 | L3 | Check |
|---|---|---|---|---|
| `cognitive_level` | understand | analyze / evaluate | evaluate / create | 🔴 |
| `profile` | foundational | practitioner | expert | 🟢 (input flag) |
| `anchor_count` | 2-3 | 3-4 | 4-6 | 🟢 (`rubric.anchors.length`) |
| `band_strictness` | lenient | standard | strict | 🟢 (input flag) |
| `competing_considerations` | single right framing | multiple valid approaches | multiple + explicit trade-offs | 🔴 |

> **L1:** "Explain what a SIEM correlation rule does." (Understand)
> **L3:** "Design a detection strategy for living-off-the-land lateral movement,
> and justify your false-positive trade-offs." (Create + Evaluate)

---

## 5. The validation gate — checkable vs review-only

The validator runs **after** generation, **before** the item is shown in the
`ai_draft` review queue — exactly where the citation filter (`filterByCitation`)
already sits. It is pure code (no AI call).

| Enforcement | Parameters | Behaviour |
|---|---|---|
| **Hard reject** | MCQ `options.length===4`; subjective `anchor_count` in band; scenario `steps` in band + `step_dependency` valid; kql `tables_count` in band | Drop item (as citation filter does today) |
| **Warn / flag for review** | MCQ `option_semantic_similarity` outside the level band; log `log_lines`/`findings_count` outside band; kql `query_constructs` missing for level; scenario `mitre_required`; cognitive-verb heuristic | Keep item, attach a `difficulty_warning` badge in the review UI |
| **Review-only (no machine signal)** | `answer_model`, `inference_steps`, `decoy_ratio`, `cross_event_correlation`, `inter_step_dependency`, `evidence_ambiguity`, `decoy_paths`, `competing_considerations` | Surfaced to the admin as the item's declared targets so the human can confirm |

Rationale: never *hard*-reject on a fuzzy heuristic (embedding similarity, verb
matching) — false negatives would silently discard good items. Hard gates are
reserved for structural facts; everything semantic is warn-or-review.

---

## 6. Empirical calibration target (closing the loop)

The spec sets *intended* difficulty; response data confirms it. Computed in
09-scoring / 15-analytics as plain SQL+stats (no AI — safe to run in a cron):

- **Within-type p-value gradient.** Mean success (proportion-correct for mcq/kql;
  mean `band/4` for graded types) must be **monotonic decreasing L1 > L2 > L3**,
  with a meaningful margin (target: ≥ 0.15 between adjacent levels).
- **Discrimination.** Item-rest point-biserial ≥ 0.2; items below that are noise.
- **Difficulty drift flag.** Any item whose empirical difficulty *inverts* its label
  (an "L3" everyone passes, an "L1" everyone fails) is flagged in the admin review
  queue as `miscalibrated` and is a candidate for re-leveling or retirement.

This requires no schema change beyond §7 plus item-attempt joins that already exist.

---

## 7. Data model addition

Add to the `questions` row (schema change → update `docs/02-data-model.md` same PR):

| Field | Type | Purpose |
|---|---|---|
| `cognitive_level` | enum (Bloom) | The declared Bloom level (cross-cutting difficulty param) |
| `nice_task_id` | `text` | NICE Framework (NIST SP 800-181) competency id — **standard tag** per the 2026-05-23 layered-taxonomy decision (pairs with `cognitive_level`: Bloom = how hard to think, NICE = which competency) |
| `difficulty_params` | `jsonb` | The full per-type parameter vector chosen at generation, for audit + validation + drift analysis |
| `attack_technique` | `text[]` (optional) | MITRE ATT&CK coverage tag (already implied by KB tags) |

Per the **forward-only** decision (2026-05-23 §9.4), these fields populate on
*newly generated* items only; existing `active` questions stay untagged until
regenerated or manually reviewed (no backfill job).

`difficulty_params` is the durable record of *intended* difficulty; the empirical
loop (§6) compares it against *measured* difficulty.

---

## 8. Integration

### Roll-out phases (decision 2026-05-23 §9.3 — structural gates first)

- **Phase A (zero AI risk):** `difficulty-spec.ts` + the `questions` columns (§7) +
  `difficulty_params`/`cognitive_level`/`nice_task_id` tagging + the **hard structural
  gates** only (§5 row 1: option count, anchor count, step count/dependency, table
  count). Skill inputs switch from prose hints to the structured vector.
- **Phase B:** the **warn-level heuristics** — including the local-embedder
  `option_semantic_similarity` check (decision §9.2), MITRE-presence, kql-construct
  and cognitive-verb heuristics. These attach `difficulty_warning` badges, never reject.
- **Phase C:** the **empirical drift report** (§6) once enough graded attempts exist
  to compute stable within-type p-value gradients.

### Components

1. **Canonical machine form.** This doc's targets become a typed module —
   `modules/04-question-bank/src/difficulty-spec.ts` — exporting per-type/level
   parameter targets. The doc is the spec; the TS module is its single executable
   embodiment, imported by both the skill-input builder and the validator (one source
   of truth, no drift).
1a. **Local embedder (Phase B).** `option_semantic_similarity` uses a small
   sentence-embedding model served locally on the VPS (MiniLM/bge-small class —
   deterministic, no external API, fits the $0-budget posture). Until it is wired,
   distractor homogeneity stays review-only; it does not block Phase A.
2. **Skill input.** `admin-generate.ts` passes the resolved parameter vector for the
   requested level into each `generate-*` skill as structured JSON (replacing the
   thin one-line `L1/L2/L3` prose hints). The skills are instructed to *meet the named
   targets* and to *emit the `difficulty_params` they used*.
3. **Validation.** The post-generation validator (sibling to `filterByCitation`)
   applies §5.
4. **Review queue.** The `ai_draft` admin UI shows each item's declared
   `difficulty_params` + any `difficulty_warning`, so the human gate is informed.
5. **No-ambient-AI invariant intact.** Steps 3-4 and §6 are deterministic (no `claude`
   spawn); only step 2 (generation) calls AI and stays sync-on-admin-click inside the
   existing `singleFlight` mutex. No new spawn site → no `lint-no-ambient-claude` change
   → no `codex:rescue` gate for the generation path (the SKILL.md edits themselves are
   prompt content, not spawn sites).

---

## 9. Decisions (resolved 2026-05-23)

1. **Taxonomy → Bloom + NICE, layered.** `cognitive_level` carries revised Bloom
   (cognitive demand); `nice_task_id` carries the NICE Framework competency
   (coverage). Webb's DOK rejected for now (Bloom is more recognized by authors;
   DOK can be added later as a third tag if needed). Reflected in §3 and §7.
2. **`option_semantic_similarity` → local embedder on the VPS.** Small
   sentence-embedding model (MiniLM/bge-small class), deterministic, no external API.
   Lands in Phase B; distractor homogeneity is review-only until it is wired (§8).
3. **Roll-out → structural gates first (A → B → C).** Phase A ships the spec module,
   tagging, and hard structural gates with zero AI risk; B adds warn heuristics
   (incl. the embedder check); C adds the empirical drift report. Phases defined in §8.
4. **Scope → forward-only.** `difficulty_params` populates newly generated items
   only; no backfill of existing `active` questions (§7).

All design decisions closed. Implementation of Phase A is the next gate (schema
migration + `difficulty-spec.ts` + structural validator + `docs/02-data-model.md`
update in the same PR).
