# Implementation Plan — Question Difficulty Spec, Phase A (structural gates)

**Source spec:** `docs/design/2026-05-23-question-difficulty-spec.md` (§4 parameter tables, §5 gate, §7 data model, §8 roll-out)
**Scope:** Phase A only — spec module + difficulty tagging + HARD structural gates. Phase B (warn heuristics, local embedder) and Phase C (empirical drift report) are out of scope.
**Resolved decisions:** Bloom + NICE layered taxonomy; structural-gates-first; **forward-only** (tag new items only, no backfill); zero AI-risk (no new `claude` spawn site, no `lint-no-ambient-claude` change).
**Status:** Ready to execute. Each phase below is self-contained for a fresh chat context.

---

## Phase 0 — Documentation Discovery (consolidated, ALREADY DONE)

This section is the authoritative fact base. Later phases cite it. All facts read from source 2026-05-23.

### Allowed APIs / exact signatures (verified, do NOT invent)

| Symbol | Location | Signature / shape |
|---|---|---|
| `questions` table | `modules/04-question-bank/migrations/0012_questions.sql:27-64` | `type TEXT CHECK IN (mcq,subjective,kql,scenario,log_analysis)`; `status TEXT CHECK IN (draft,active,archived,ai_draft)` (ai_draft added 0016); `content JSONB`, `rubric JSONB`, `knowledge_base_sources JSONB DEFAULT '[]'` (0016); `source_question_id UUID` (0084). **No `tenant_id`** — RLS is JOIN-derived via `pack_id → question_packs.tenant_id`. |
| Migration runner | `tools/migrate.ts:132-173` | Auto-discovers `modules/*/migrations/*.sql`, sorts lexically by basename, tracks in `schema_migrations`. **Next number = `0086`.** Drop file → `pnpm tsx tools/migrate.ts`; gate check `--check`. |
| Column-add pattern | `modules/04-question-bank/migrations/0016_questions_ai_draft_kb.sql:40-51` | `ALTER TABLE questions ADD COLUMN ...`; CHECK extends via `DROP CONSTRAINT` + `ADD CONSTRAINT`. **0016 adds the column to BOTH `questions` AND `question_versions`** — follow that precedent. |
| `Question` interface | `modules/04-question-bank/src/types.ts:242-262` | adds `domain_id`/`category_id` (nullable). |
| Content Zod schemas | `modules/04-question-bank/src/types.ts` | `McqContentSchema:27-41` (`options: array(string).min(2).max(8)`, `correct: int`, `rationale`); `KqlContentSchema:54-61` (`tables: array(string).min(1)`, `expected_keywords`); `ScenarioContentSchema:89-96` (`steps: array.min(1)`, `step_dependency: enum["linear","parallel"]`); `SubjectiveContentSchema:47-49` (`{question}` only); `LogAnalysisContentSchema:101-108`. Dispatcher `validateQuestionContent:134-145`. |
| `LevelRubricDefaults` | `modules/04-question-bank/src/types.ts:171-177` | `{profile, anchorComplexity, bandStrictness}` — existing precedent for level→calibration mapping. |
| `generateQuestions` (orchestrator) | `modules/04-question-bank/src/service.ts:1431-1537` | resolves `socLevel` (1460-1466), selects `sources` (1469-1474), builds `existingTopics` (1477-1483), calls `handleAdminGenerate({...})` (1524-1536) via dynamic import. |
| `handleAdminGenerate` | `modules/07-ai-grading/src/handlers/admin-generate.ts:304` | input `HandleAdminGenerateInput:72-114`. Sharded path 403-633; omnibus single 635-727; omnibus chunked 729-893. |
| `filterByCitation` | `modules/07-ai-grading/src/handlers/admin-generate.ts:143-159` | `<T extends {knowledge_base_source_ids?}>(questions, validSourceIds:Set, onDrop) → T[]`. **This is the exact pattern the structural validator copies.** Called in all 3 paths (sharded 526, omnibus 660, chunked 797). |
| `insertDrafts` | `modules/07-ai-grading/src/handlers/admin-generate.ts:171-224` | INSERT at 184-206; columns + params列. **This is where new columns get persisted.** |
| `GenerateByTypeInput` | `modules/07-ai-grading/src/types.ts:254-274` | `{level, type, count, topicFocus?, existingTopics, sources, packId, levelId}`. **Add `difficulty` here.** |
| `GenerateQuestionsInput` | `modules/07-ai-grading/src/types.ts:160-188` | omnibus input. |
| `GeneratedQuestionDraft` | `modules/07-ai-grading/src/types.ts:194-217` | the parsed return shape (`type, topic, points, content, rubric, knowledge_base_source_ids, knowledgeBaseSources`). |
| `promptVars` (skill input built) | `modules/07-ai-grading/src/runtimes/claude-code-vps.ts:358-364` (omnibus) & `505-511` (per-type) | `{level, count, topic_focus, existing_topics, sources}`. **Add `difficulty` to BOTH promptVars objects.** This is the only place skill input is assembled. |
| `SubmitQuestionsInputSchema` | imported in `claude-code-vps.ts` (validates model output 398, 545) | the model-output contract. **NOT changed in Phase A** (difficulty is stamped by the handler, not emitted by the model — see design note D-1). |
| `runSkill` | `modules/07-ai-grading/src/runtimes/claude-code-vps.ts:786` | the ONLY spawn site. Phase A does not touch it → no `lint-no-ambient-claude` change. |
| Test runner | root `package.json:13` `vitest run`; configs `vitest.config.ts` | `pnpm vitest run modules/04-question-bank` (or `…/07-ai-grading`). |
| Pure-function test template | `modules/04-question-bank/src/__tests__/generate-body-validation.test.ts:1-207` | copy: `describe`/`it`, `expectValidationCode` helper, imports `from "../routes.js"` + `ValidationError from "@assessiq/core"`. |
| Citation-filter test template | `modules/07-ai-grading/src/__tests__/admin-generate-citation.test.ts` | mocks `generateQuestionsByType` via `vi.mock`; template for testing the validator inside the handler. |
| API contract | `docs/03-api-contract.md:190` | request `{count?, topic_focus?}`, response `{questionIds, generated, skillSha}`. Endpoint re-gated to `super_admin` (line 1999). |
| Data-model doc | `docs/02-data-model.md:329-344` | the `questions` CREATE block to update (also missing `source_question_id` — fix in same PR). |
| Skill INPUT blocks | `prompts/skills/generate-{mcq,scenario,kql,log-analysis,subjective}/SKILL.md` (Inputs ~19-39) + omnibus `generate-questions` | 5 fields today: `level/count/topic_focus/existing_topics/sources`. Per-level prose to replace: generate-mcq `62-67`, scenario `62`, kql `82-87`, log-analysis `60-62`, subjective `65-72`. Skill version frontmatter `version: "2026-05-13a"` (omnibus `2026-05-08`). |

### Anti-patterns to avoid (verified hazards)

1. **Do NOT use `CREATE TYPE ... AS ENUM`.** The codebase has zero Postgres enums; use `TEXT + CHECK (col IS NULL OR col IN (...))`. (Source: every migration read.)
2. **Do NOT add a `07-ai-grading → 04-question-bank` import.** The boundary is deliberate ([admin-generate.ts:85-88](modules/07-ai-grading/src/handlers/admin-generate.ts#L85-L88)). Difficulty data crosses as **plain data**, exactly like `sources`.
3. **Do NOT change `SubmitQuestionsInputSchema` or the model output contract** in Phase A. Difficulty is stamped deterministically by the handler (design note D-1).
4. **Do NOT add a new file under `modules/07-ai-grading/src/runtimes/` and do NOT touch `runSkill` / the lint.** Doing so trips the `codex:rescue` gate and breaks the zero-spawn-site invariant.
5. **Schema divergence — MCQ options:** `McqContentSchema` allows 2-8 but the difficulty gate requires **exactly 4** (per generate-mcq SKILL "Exactly 4 options"). The validator enforces `=== 4`; this is stricter than the content Zod and that is intentional.
6. **Schema divergence — scenario `step_dependency`:** content Zod enum is `["linear","parallel"]` ([types.ts:89-96](modules/04-question-bank/src/types.ts#L89-L96)) but the skill prose says `linear|dag`. The structural gate validates against the **actual Zod enum** (`linear|parallel`), not the prose. Flag this mismatch to the user; do not "fix" the Zod schema as part of Phase A.

### Design note D-1 — difficulty is HANDLER-STAMPED, not model-emitted

The intended difficulty vector for a `(type, level)` pair is fully known from the spec at generation time. So the handler **stamps** `cognitive_level` + `difficulty_params` (+ `nice_task_id`) onto the row deterministically — the model is only *told the targets* (via skill input) and the structural validator *catches violations*. This avoids changing the model-output schema (lower risk) and makes tagging deterministic and forward-only. Per-item Bloom precision (model-emitted) is a Phase B option.

### Design note D-2 — `nice_task_id` derivation (deterministic)

Map the **primary cited source's `function`** (one of triage/analysis/detection/forensics/hunting/response/intelligence/governance/architecture) to a NICE work-role/competency bucket via a static `functionToNice()` map in `difficulty-spec.ts`. 07 already has `sources[].function` and each question's `knowledge_base_source_ids`, so it resolves `nice_task_id` per question from plain data. `attack_technique` column is added but left NULL in Phase A (MITRE extraction is Phase B).

### Design note D-3 — subjective anchor gate is conditional

`anchor_count` lives in `rubric.anchors`. For type=subjective the draft `rubric` may be `null` at generation time (rubric is produced later by `generate-rubric`). The anchor-count hard gate therefore applies **only when `rubric` is non-null**; otherwise it is skipped (not a failure).

---

## Phase A1 — Spec module + pure structural validator (no DB, no AI)

**Goal:** Ship `difficulty-spec.ts` (single source of truth) and a pure `validateStructuralDifficulty` function with unit tests. Zero runtime risk — pure functions only.

### What to implement (COPY targets)

1. **New file `modules/04-question-bank/src/difficulty-spec.ts`** exporting:
   - `BLOOM_LEVELS = ["remember","understand","apply","analyze","evaluate","create"] as const` + `BloomLevel` type. (Pattern: copy `QUESTION_TYPES` const-array idiom from `types.ts:116-124`.)
   - `functionToNice(fn: string): string` — the static map from D-2.
   - `DIFFICULTY_SPEC: Record<QuestionType, Record<"L1"|"L2"|"L3", DifficultyTarget>>` encoding §4 of the design doc. Each `DifficultyTarget` carries the **structural-gate numeric bounds** plus the descriptive params:
     - mcq: `optionsExactly: 4`; `cognitiveLevel`, `distractorHomogeneity`, `stimulus`, `inferenceSteps`.
     - kql: `tablesCountMin/Max` (L1 1/1, L2 1/2, L3 2/3).
     - scenario: `stepsMin/Max` (L1 2/3, L2 3/4, L3 4/5); `allowedStepDependency: ["linear"]` for L1/L2, `["linear","parallel"]` for L3 (per the **actual Zod enum**, see anti-pattern 6).
     - subjective: `anchorMin/Max` (L1 2/3, L2 3/4, L3 4/6); plus `profile/anchorComplexity/bandStrictness` (reuse `LevelRubricDefaults` values, `types.ts:171-177`).
     - log_analysis: descriptive params only (its structural bounds — line count, findings count — are Phase B warn-level; no hard gate in A beyond schema).
   - `resolveDifficulty(type, level): DifficultyTarget` accessor.
2. **Pure validator `validateStructuralDifficulty(type, level, content, rubric)`** — returns `{ ok: true } | { ok: false; reason: string }`. Inspects raw JSON (`content.options?.length`, `content.tables?.length`, `content.steps?.length`, `content.step_dependency`, `rubric?.anchors?.length`) against `resolveDifficulty(...)` bounds. Implements D-3 (skip anchor gate when rubric null). **Place this in `difficulty-spec.ts`** so it ships with the bounds (no DB, importable by tests). It takes plain values, so 07 can call it without importing 04 only if exported via the plain-data path — see Phase A3 design (the numeric bounds cross as data; the *validator runs in 07*). For A1, ship the function + bounds in 04 and unit-test it in 04.

### Documentation references
- `docs/design/2026-05-23-question-difficulty-spec.md` §4 (targets), §5 (which gates are HARD).
- `modules/04-question-bank/src/types.ts:27-108` (content shapes the validator inspects).

### Verification checklist
- [ ] `pnpm vitest run modules/04-question-bank` green; new test file covers: mcq !==4 options → fail; kql tables out of band → fail; scenario steps out of band + bad step_dependency → fail; subjective anchors out of band → fail; subjective rubric=null → **pass** (D-3); each type at each level happy-path → pass.
- [ ] `pnpm tsc -b` (or repo typecheck) clean.
- [ ] Grep guard: `grep -r "CREATE TYPE" modules/04-question-bank/src` → no new enum (N/A for TS but confirms intent).

### Anti-pattern guards
- No DB calls, no `claude`, no imports beyond `types.js` + zod. Pure module.
- Encode scenario `step_dependency` allowed values from the **Zod enum**, not the skill prose.

---

## Phase A2 — Migration 0086 + data-model doc (no AI)

**Goal:** Add the 4 columns to `questions` AND `question_versions`; document them.

### What to implement (COPY target: `0016_questions_ai_draft_kb.sql:40-51`)

New file `modules/04-question-bank/migrations/0086_question_difficulty_tags.sql`:

```sql
-- cognitive_level: revised Bloom (nullable; legacy rows stay NULL — forward-only)
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS cognitive_level TEXT,
  ADD COLUMN IF NOT EXISTS nice_task_id    TEXT,
  ADD COLUMN IF NOT EXISTS difficulty_params JSONB,
  ADD COLUMN IF NOT EXISTS attack_technique TEXT[];
ALTER TABLE questions ADD CONSTRAINT questions_cognitive_level_check
  CHECK (cognitive_level IS NULL OR cognitive_level IN
    ('remember','understand','apply','analyze','evaluate','create'));

-- Mirror onto version snapshots (precedent: 0016 added knowledge_base_sources to both)
ALTER TABLE question_versions
  ADD COLUMN IF NOT EXISTS cognitive_level TEXT,
  ADD COLUMN IF NOT EXISTS nice_task_id    TEXT,
  ADD COLUMN IF NOT EXISTS difficulty_params JSONB,
  ADD COLUMN IF NOT EXISTS attack_technique TEXT[];
```

(No RLS change — JOIN-derived via `pack_id`. Confirmed by 0016/0084 precedent.)

### Documentation references
- `modules/04-question-bank/migrations/0016_questions_ai_draft_kb.sql` (copy idiom).
- `tools/migrate.ts:132-173` (how it runs).

### Verification checklist
- [ ] `DATABASE_URL=… pnpm tsx tools/migrate.ts` applies 0086 cleanly; `--check` returns no pending.
- [ ] `docs/02-data-model.md:329-344` updated: add the 4 new columns **and** the previously-missing `source_question_id UUID` to the CREATE block; add prose explaining each + the forward-only NULL semantics.
- [ ] RLS unchanged — confirm no new policy needed (note in PR).

### Anti-pattern guards
- `TEXT + CHECK`, never ENUM. Nullable (no `NOT NULL DEFAULT`) so legacy rows read as "untagged".
- Same-PR doc rule (CLAUDE.md #5) — migration without the data-model edit fails the gate.

---

## Phase A3 — Wire difficulty into generation (handler + skill input + persist) — LOAD-BEARING

**Goal:** Pass the difficulty target vector into the skills, stamp the new columns on insert, and run the structural validator as a filter. Touches `modules/07-ai-grading` (load-bearing) — **adversarial sign-off required before push** (see gate).

### What to implement (COPY targets cited)

1. **04 → 07 plain-data hand-off (no import added).** In `service.ts:generateQuestions` (after `socLevel` resolves, ~1466), build a serializable `difficultySpec` (the per-type `DifficultyTarget` map for this level, from `difficulty-spec.ts` + the `functionToNice` map) and add it to the `handleAdminGenerate({...})` call object (1524-1536). Add `difficultySpec` to `HandleAdminGenerateInput` ([admin-generate.ts:72-114](modules/07-ai-grading/src/handlers/admin-generate.ts#L72-L114)) as plain data — mirror the existing `sources` field exactly.
2. **Skill input.** In `admin-generate.ts`, add `difficulty` to each `GenerateByTypeInput` built at `431-439` (and the omnibus `GenerateQuestionsInput` at `646-653` and `749-756`) from `input.difficultySpec[type]`. Add the `difficulty?` field to `GenerateByTypeInput`/`GenerateQuestionsInput` (`07/types.ts:160-188, 254-274`). Then add `difficulty: input.difficulty ?? null` to **both** `promptVars` in `claude-code-vps.ts` (`358-364` and `505-511`).
3. **Structural validator wired as a filter.** Add `validateStructuralDifficulty` calls (the bounds carried in `input.difficultySpec`, so 07 needs only plain numbers — re-implement the tiny inspector in 07 or pass a closure; do **not** import 04). Run it right after `filterByCitation` in all three paths (sharded ~526-544, omnibus ~660-676, chunked ~797-815). Drop failing questions; count drops into a new `difficulty_dropped` tracked var; record it on the `generation_attempts` row (extend `AttemptFinalizeFields:231-245` + the UPDATE at `260-274` — needs a migration column `difficulty_dropped INT` on `generation_attempts`, OR fold into the existing log only; **recommend** adding the column for symmetry with `citation_dropped`).
4. **Stamp columns in `insertDrafts` (`184-206`).** Add `cognitive_level`, `nice_task_id`, `difficulty_params`, `attack_technique` to the INSERT column list + params: `cognitive_level` + `difficulty_params` from `input.difficultySpec[q.type]`; `nice_task_id` via `functionToNice(firstCitedSource.function)`; `attack_technique` = `null` (Phase B).
5. **SKILL.md updates.** In each `generate-*` skill, replace the per-level prose hints with a reference to the new `difficulty` input block (document the new field in the `# Inputs` section); keep the prose as fallback narrative but make the structured field authoritative. **Bump `version:` to `"2026-05-23a"`** on every edited skill (the sha is recorded on `generation_attempts`).
6. **API/contract docs.** Request body unchanged (difficulty is internal, derived from level) — but note in `docs/03-api-contract.md:190` that generated rows now carry difficulty tags. Update `docs/05-ai-pipeline.md` generation section + each edited `SKILL.md`'s module note.

### Documentation references
- All Phase 0 copy-targets above. Especially `filterByCitation:143-159` (validator pattern), `insertDrafts:184-206` (persist), `promptVars` `358-364`/`505-511` (skill input).
- `docs/design/2026-05-23-question-difficulty-spec.md` §5 (HARD gates), §8 (integration), D-1/D-2/D-3 above.

### Verification checklist
- [ ] `pnpm vitest run modules/07-ai-grading` green — existing `admin-generate-citation`, `admin-generate-tenant-mode`, `admin-generate-stderr`, `auto-weight` tests still pass (the validator is additive).
- [ ] New test: a generated question violating a structural bound is dropped and counted (copy `admin-generate-citation.test.ts` mock pattern).
- [ ] New test: inserted row carries `cognitive_level` + `difficulty_params` + `nice_task_id` (DB-level test or assert on the INSERT params).
- [ ] `pnpm tsc -b` clean across both modules.
- [ ] Grep guard: no new `spawn`/`child_process` and no `@anthropic-ai/claude-agent-sdk` import outside the allowed file (`grep -rn "child_process\|claude-agent-sdk" modules/07-ai-grading/src` unchanged from baseline). Confirms lint invariant intact.
- [ ] `lint:ambient-ai` CI step passes unchanged.

### Anti-pattern guards
- No 07→04 import (data crosses as `input.difficultySpec`).
- `SubmitQuestionsInputSchema` untouched (D-1).
- `runSkill` and `runtimes/` file set untouched → no `codex:rescue`-triggering change, but see gate below.
- Scenario `step_dependency` validated against Zod enum, not prose (anti-pattern 6).
- Subjective anchor gate skipped when `rubric === null` (D-3).

### ⚠ Gate before push (CLAUDE.md hard rule)
`modules/07-ai-grading/**` is load-bearing + classifier-adjacent. Even though no spawn site / lint changes, the diff modifies the generation pipeline → **adversarial sign-off required before push**: per `feedback-adversarial-reviewer-routing`, route Sonnet + GLM-5.1 (or `codex:rescue`) with the diff, the no-ambient-AI invariant, and "difficulty is handler-stamped, model output schema unchanged" as the pinned threat model. Log the verdict in `SESSION_STATE.md`.

---

## Phase A-Verify — Final verification + Definition of Done

1. **Full suite:** `pnpm vitest run modules/04-question-bank modules/07-ai-grading` green.
2. **Migration applied** on the target DB; `tools/migrate.ts --check` clean.
3. **Live smoke (sync-on-admin-click):** generate a small L1 set and an L3 set on the dev tenant; confirm rows carry `cognitive_level`/`difficulty_params`/`nice_task_id` and that any structurally-bad item was dropped (check `generation_attempts`).
4. **Anti-pattern grep sweep:** confirm (a) no ENUM types, (b) no 07→04 import, (c) `SubmitQuestionsInputSchema` unchanged, (d) lint-no-ambient-claude allow-list unchanged.
5. **Definition of Done (CLAUDE.md #9):** commit → deploy (additive, namespaced) → docs (`02-data-model.md`, `03-api-contract.md`, `05-ai-pipeline.md`, edited `SKILL.md`s, this plan's status) → handoff (`SESSION_STATE.md` + 5-line agent-utilization footer incl. the adversarial verdict).

---

## Sequencing & gates

```
A1 (pure spec + validator + tests)  ──► A2 (migration + data-model doc)  ──► A3 (wire + persist + validate)  ──► A-Verify
   zero risk, no gate                   zero AI risk, no gate                LOAD-BEARING: adversarial gate      DoD
```

- A1 and A2 are independent and could run in parallel (different files), but A3 depends on both.
- Only A3 carries the adversarial gate (07-ai-grading load-bearing).
- Phase B (warn heuristics + local embedder) and Phase C (empirical drift) are separate future plans — do not pull them into Phase A.

## Open items to confirm with the user before A3

1. **`generation_attempts.difficulty_dropped` column** — add it (symmetry with `citation_dropped`) or log-only? (Recommend: add — it's one nullable INT.)
2. **Scenario `step_dependency` divergence** (`linear|parallel` Zod vs `linear|dag` prose) — Phase A validates against Zod and flags it; a separate decision is whether to reconcile the schema/skill later.
