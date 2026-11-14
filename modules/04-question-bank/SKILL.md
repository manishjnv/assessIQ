# 04-question-bank — Packs, levels, questions

> **Status update 2026-05-04 (2):** `parsePagination()` upper bound raised from 100 → 500. Pack-detail page requests `pageSize=200` to render all questions grouped by level in one shot; the old cap produced a 400. `admin-users.ts` keeps its own 100 cap (user lists do not need full dumps). Frontend `pack-detail.tsx` now splits the pack fetch from the questions fetch so a questions-specific error shows a styled card with Retry instead of raw error text.

> **Status update 2026-05-04:** `createPack()` now auto-generates `slug` from `name` when the caller omits it. Algorithm: NFKD lowercase → strip non-`[a-z0-9\s-]` → hyphenate spaces → collapse → 64-char cap. Collision retry appends `-2`…`-10`; all-emoji names throw `INVALID_NAME_FOR_SLUG`. Explicit slugs still validated against `/^[a-z0-9-]{3,80}$/`. Root cause: UI was omitting slug → `undefined` matched the regex via JS coercion → Postgres NOT NULL 500. See `docs/RCA_LOG.md` 2026-05-04.

> **Status update 2026-05-02:** `activateAllQuestionsForPack(tenantId, packId)` shipped — admin "activate all" affordance closing the question-status workflow gap RCA'd earlier today. Surfaced as `POST /api/admin/packs/:id/activate-questions`. `publishPack` deliberately does NOT auto-flip questions to `active`; admins explicitly call activate-all to promote draft → active. See `docs/RCA_LOG.md` 2026-05-02 § "Question status workflow gap" prevention #1 for the rationale.

## Purpose
Author and version the content of assessments. Multi-domain by design: SOC ships first, every future domain (DevOps, Cloud, IAM, IR, Data) plugs in as a new pack with its own levels and question types. The engine is content-agnostic.

## Scope
- **In:** packs CRUD, levels CRUD per pack, questions CRUD with type-specific content shapes (mcq, subjective, kql, scenario, log_analysis), versioning (every edit creates a new version), tags + filtering, bulk import/export, AI-assisted question generation (admin tool).
- **Out:** taking the assessment (06), grading (07/08), assessment lifecycle (05).

## Dependencies
- `00-core`, `02-tenancy`
- `08-rubric-engine` — for the rubric structure embedded in subjective/scenario question content
- `07-ai-grading` — only for the AI question-generation admin tool (not runtime grading)
- `14-audit-log`

## Public surface
```ts
// packs
listPacks({ tenantId, domain?, status?, page, pageSize }): Promise<PaginatedPacks>
createPack(input): Promise<Pack>
publishPack(id): Promise<Pack>
archivePack(id): Promise<Pack>

// levels
addLevel(packId, input): Promise<Level>
updateLevel(id, patch): Promise<Level>

// questions
listQuestions({ packId?, levelId?, type?, tag?, search? }): Promise<PaginatedQuestions>
// EXP-5: also q (full-text + typo search), stage_id/subject_id/unit_id/outcome_id, difficulty_min/max,
// origin[], rights_status[], review_state[], language[], has_solution. questionFacets(tenantId, filters) returns counts.
// Migration 0196 keeps questions.search_text/search_tsv in sync by trigger; see docs/02-data-model.md (EXP-5).
createQuestion(input): Promise<Question>
updateQuestion(id, patch): Promise<Question>     // implicit new version
listVersions(questionId): Promise<QuestionVersion[]>
restoreVersion(questionId, version): Promise<Question>
bulkImport(file: Buffer, format: 'json'|'csv'): Promise<ImportReport>
generateDraft({ topic, type, level, count }): Promise<Question[]>   // AI-assisted
```

## Data model touchpoints
Owns: `question_packs`, `levels`, `questions`, `question_versions`, `tags`, `question_tags`.

`questions.content` JSONB shape varies by type — see `docs/02-data-model.md` § "questions.content shapes by type" for canonical schemas. Validation via Zod schemas keyed by `type`.

## Versioning rule
Every PATCH to `questions` snapshots the previous content into `question_versions` BEFORE the update. Attempts (06) freeze `question_version` at attempt-start time, so a candidate's experience is stable even if the admin edits the question mid-cycle.

## Help/tooltip surface
- `admin.packs.create.domain` — naming conventions, when to create a new pack vs new level
- `admin.question.editor.subjective.rubric` — how anchors and reasoning bands work
- `admin.questions.type.kql.expected_keywords` — pattern matching limits, escape characters
- `admin.questions.type.scenario.step_dependency` — linear vs parallel; what fails downstream
- `admin.questions.import.format` — JSON/CSV schema with examples
- `admin.questions.generate.draft` — what the AI generator does, why human review is mandatory

## Open questions
- Question marketplace / shared packs across tenants — Phase 4 if multi-client demand emerges
- Per-question prerequisites (must answer Q1 before Q2 unlocks) — defer to scenario-only flow

## Decisions captured (2026-05-01)

Pinned ahead of Phase 1 G1.A Session 1 per `docs/plans/archive/PHASE_1_KICKOFF.md` § Decisions captured. User confirmed all four user-blocking decisions resolve to orchestrator defaults.

### `log_analysis` content shape (decision #3)

`questions.content` for `type='log_analysis'` mirrors the `kql` shape with two field swaps: `log_excerpt` (raw log text) replaces `tables` and `expected_findings` (fuzzy concept list, anchor-style matching) replaces `expected_keywords`. Adds `log_format` enum (`syslog | json | csv | freeform`) so the candidate UI picks a syntax-aware viewer. Canonical schema lives at `docs/02-data-model.md` § "questions.content shapes by type" → "**Log_analysis**". Zod schema in `modules/04-question-bank/src/types.ts` (lands in G1.A Session 1).

### Bulk import file format (decisions #4 + #13)

> **FU-A19 (2026-10-06): parked.** FR19 review (2026-10-03): the only author is the super admin, and JSON-by-CLI (`tools/aiq-import-pack.ts`) works in production. CSV stays parked until the owner wants spreadsheet authoring or a customer tier needs it (decided 2026-10-03: no). `bulkImport` throws for `format: 'csv'` today (`service.ts:1244-1255`) — this is intentional, not a bug. Help text `admin.questions.import.format` ("CSV import is planned") stays as-is; it is acceptable forward-looking copy, not a false claim.

**Phase 1 ships JSON-only.** CSV deferred to Phase 2 once admin team has used JSON in practice. **Phase 1 ships a CLI helper, no browser UI.** Browser upload widget defers to Phase 2 admin-dashboard (module 10).

JSON schema: one file per pack. Top-level shape:

```json
{
  "$schema": "https://assessiq.automateedge.cloud/schemas/import-pack.v1.json",
  "pack": {
    "slug": "soc-skills-2026q2",
    "name": "SOC Skills 2026 Q2",
    "domain": "soc",
    "description": "L1 + L2 + L3 readiness check covering triage, investigation, detection engineering."
  },
  "levels": [
    {
      "position": 1,
      "label": "L1",
      "description": "Triage analyst: alert validation, basic enrichment, escalation criteria.",
      "duration_minutes": 30,
      "default_question_count": 12,
      "passing_score_pct": 60
    }
  ],
  "questions": [
    {
      "level_position": 1,
      "type": "mcq",
      "topic": "alert-triage",
      "points": 5,
      "content": { "...type-specific shape per docs/02-data-model.md..." },
      "rubric": null,
      "tags": ["mitre:T1078", "tactic:initial-access"]
    }
  ]
}
```

- Questions reference levels by `level_position` (not by id, since ids are minted at import time).
- `content` validates against the per-type Zod schema; mismatch fails the whole import (transactional all-or-nothing).
- `rubric` required for `subjective` and `scenario`; null for deterministic types.
- `tags` are upserted by `(tenant_id, name)`.
- Re-importing the same `pack.slug` UNIQUE-conflicts on `(tenant_id, slug, version)`; importer surfaces a friendly error and offers `--bump-version` to force a new pack version.

JSON schema file lives at `modules/04-question-bank/schemas/import.schema.json`; ships in G1.A Session 1 alongside the importer code.

CLI helper: `pnpm aiq:packs:import --tenant <slug> <path-to-pack.json>`. Wraps `bulkImport` in a one-off pg client using the `assessiq_system` BYPASSRLS role + a `withTenant` shim. Used by admins until the Phase 2 admin UI ships.

### `generateDraft()` deferred to Phase 2 (decision #11)

AI-assisted question generation is the only AI-touching surface in this module's public API. Phase 1 grading-free policy applies symmetrically per `CLAUDE.md` rule #1 — admins author by hand or import JSON. The function signature stays in `index.ts` with `throw new NotImplementedError("Phase 2: AI question generation lands with grading runtime")`. Re-evaluate at Phase 2 kickoff once `07-ai-grading` runtime is in place.

### Pack publish snapshot semantics (decision #21)

`publishPack(id)` flips `question_packs.status` to `published` AND writes a `question_versions` row for every question in the pack at the current `(content, rubric)`, **even if no edit happened since the last publish**. This guarantees a permanent immutable snapshot keyed by `(question_id, version)` for the published pack version. Subsequent question edits create new `question_versions` rows but do NOT alter the published snapshot — until `publishPack` is called again, which bumps `question_packs.version` and re-snapshots. Resolves the SKILL.md ambiguity about whether publish is a metadata-only flip or a content snapshot. (It is both.)

### Exam content is never committed (2026-10-01)

**What:** question text and answer keys never go into git. The repo is public; anything committed is readable by every candidate. The aptitude seed (`0109_seed_platform_aptitude_pack.sql`, already applied in prod) was moved to `docs/exam-content/Aptitude/` (gitignored, local only) and untracked; `.gitignore` also blocks its old path. `tools/gen-aptitude-migration.ts` now writes there by default, and the real-content block of `aptitude-seed-migration.test.ts` reads from there (skips in CI).
**Why:** the 60-question aptitude pack with answers was pushed to the public repo on 2026-10-01. Owner chose to keep the repo public, so content moves out of git instead.
**Rejected:** making the repo private (owner decision); rewriting git history (force-push breaks the VPS clone and parallel sessions, and the old commit stays viewable anyway).
**Not included:** the copy in git history is still public — those 60 items were **replaced in prod on 2026-10-01** (pack `campus-placement-aptitude` now holds 60 fresh `APT2-*` items; the leaked one is archived as `campus-placement-aptitude-v1-retired`). For a future replacement set, retire the old pack's slug first and generate with `--pack-key <vN>` (the pack id is deterministic). `prompts/skills/` was untracked + gitignored the same day (host copy on the VPS is the source of truth).
**Impact:** load new content with `POST /api/admin/questions/import` or by applying generated SQL on the VPS by hand. `tools/migrate.ts --check` only checks files present in the repo, so an applied migration with no file does not fail the deploy gate. Structural seeds (domains, categories) can still be migrations; content cannot.

---

## Status

**Implemented and live — 2026-05-01 (Phase 1 G1.A Session 1).**

- 6 migrations applied to `assessiq-postgres` on production: `0010_question_packs.sql` (standard RLS), `0011_levels.sql`, `0012_questions.sql`, `0013_question_versions.sql`, `0014_tags.sql` (+ `question_tags`), `0015_questions_level_pack_fk.sql` (defense-in-depth composite FK).
- 50/50 vitest cases passing against `postgres:16-alpine` testcontainer with full migration apply (tenancy 0001-0003 → users 020 → qb 0010-0015).
- Public surface (16 functions): `listPacks`, `createPack`, `getPack`, `getPackWithLevels`, `updatePack`, `publishPack`, `archivePack`, `addLevel`, `updateLevel`, `listQuestions`, `getQuestion`, `createQuestion`, `updateQuestion`, `listVersions`, `restoreVersion`, `bulkImport`, plus `generateDraft` 501-stub deferred to Phase 2 per decision #11.
- Route layer (15 admin endpoints) shipped at `modules/04-question-bank/src/routes.ts`, registered into `apps/api/src/server.ts` via `registerQuestionBankRoutes(app, { adminOnly: authChain({roles:['admin']}) })`. Smoke verified 2026-05-01 16:26 GMT+5:30: `GET /api/admin/packs` returns 401 AUTHN_FAILED without session (was 404 pre-deploy), confirming routes registered + auth chain firing.
- CLI helper `tools/aiq-import-pack.ts` shipped — `pnpm tsx tools/aiq-import-pack.ts --tenant <slug> <pack.json>`. BYPASSRLS used for slug→tenantId + first-active-admin lookup, then `bulkImport` runs through `withTenant` (RLS-on).
- RLS lint extended (`tools/lint-rls-policies.ts` `JOIN_RLS_TABLES`): `levels`, `questions`, `question_versions`, `question_tags` now structurally enforced; `attempt_questions` / `attempt_answers` / `attempt_events` forward-declared for G1.C.
- Sonnet-takeover adversarial review: REVISED → ACCEPTED after must-fix #1 (composite FK + 2 tests) and must-fix #2 (`fastify.d.ts` comment). codex:rescue subagent not used per user "sonnet takeover" directive.

### Why this design (decisions captured during the ship)

- **publishPack bumps q.version after snapshotting.** Original implementation snapshot-only would UNIQUE-violate on the next `updateQuestion` (which also snapshots at `q.version` before bumping). Bump-after-snapshot keeps the canonical history monotonic. Trade-off: a publish-then-immediate-edit produces two snapshot rows with identical content (v1 from publish, v2 from edit-before-bump). Acceptable — real-world publish-edit gaps are minutes/hours, not zero.
- **getPackWithLevels added to service surface** to match the API contract's "Pack with levels" response shape for `GET /admin/packs/:id`. Avoids two `withTenant` round-trips at the route layer.
- **Composite FK `(level_id, pack_id) → levels(id, pack_id)` (migration 0015) is defense-in-depth.** The service-layer `findLevelById` guard already rejects cross-pack `level_id` via RLS-scoped lookup. The composite FK adds DB-layer enforcement so a future direct-SQL caller, migration script, or service-layer regression cannot silently cross tenants. Cost: one redundant `UNIQUE (id, pack_id)` on `levels` (id is already PK, but Postgres requires the unique target match for the composite FK).
- **`archivePack` lazy assessments-table check** (`hasAssessmentsTable` + `countAssessmentsReferencingPack`) means archive is unconditionally allowed in Phase 1 (no `assessments` table yet). Once G1.B ships the table the gate auto-engages with no code change.
- **JSON-only bulk import (decision #4 + #13).** CSV deferred to Phase 2; browser upload UI deferred to Phase 2 admin-dashboard. Phase 1 ships CLI helper + endpoint that accepts JSON body or file.

### Considered and rejected

- **Adding fastify as a peer dep** (vs regular dep). Routes.ts uses type-only imports from fastify — runtime cost is zero. But the question-bank package imports fastify types, so calling it a "peer" misrepresents the dep relationship. Regular dep is honest.
- **Inline FastifyRequest augmentation in routes.ts** (vs separate `fastify.d.ts`). Co-locating the augmentation with the consumer is briefer but couples module-internal type plumbing to a route file. Separate `fastify.d.ts` matches the pattern 01-auth uses.
- **Generating routes from an OpenAPI schema.** Postponed — Phase 1's route count is small enough to hand-author. Phase 4+ (when 50+ endpoints across multiple modules) would benefit from contract-first generation.
- **Re-publishing a published pack** (transition published → published with re-snapshot). The current gate only allows draft → published. Re-publish would re-snapshot every question at its current version, useful when an admin wants to "freeze a new edition." Deferred to Phase 2 once authoring workflows mature; the SKILL.md decision #21 hints at this but explicit re-publish UX is not in Phase 1.

### Not included (Phase 1 boundary)

- `generateDraft()` — 501 stub (decision #11). Lands when 07-ai-grading runtime is in place.
- CSV bulk import — JSON only in Phase 1 (decision #4).
- Browser-based pack upload UI — Phase 2 admin-dashboard (decision #13).
- DELETE endpoints on packs/levels/questions — soft-delete via `status='archived'` is the only path. Hard delete is a Phase 3 admin tool.
- `attempt_questions`, `attempt_answers`, `attempt_events` migrations — those land in G1.C (`06-attempt-engine`). The RLS lint already forward-declares them.
- Cross-pack reuse of questions, question marketplace — Phase 4 if multi-client demand emerges.

### Downstream impact

- `05-assessment-lifecycle` (G1.B): consumes published packs + frozen `question_versions` snapshots when a candidate starts an attempt. The snapshot-at-publish guarantee is what makes this safe under concurrent admin edits.
- `06-attempt-engine` (G1.C): pulls a question set from `(pack_id, level_id, status='active')` at attempt-start. RLS scopes everything to the candidate's tenant.
- `07-ai-grading` (Phase 2): reads `questions.rubric` JSONB for subjective/scenario grading. Admin-triggered, never ambient.
- `08-rubric-engine` (Phase 2 G2.B Session 2): canonical home for `RubricSchema`, `AnchorSchema`, `Rubric`, `Anchor`. 04 re-exports them so existing `import { RubricSchema } from "@assessiq/question-bank"` callers stay unchanged. 04's internal `validateRubric` (returning `{ ok, data | errors: ZodIssue[] }`) is unchanged and continues to drive `createQuestion`/`updateQuestion` per-issue error mapping.
- `10-admin-dashboard` (Phase 2): replaces the CLI helper with a browser upload widget against `POST /api/admin/questions/import`.
- `tools/lint-rls-policies.ts`: now structurally protects 4 join-based child tables; extending it for `06-attempt-engine` is a one-line addition to `JOIN_RLS_TABLES`.

## Numeric and multi-select question types (2026-10-02)

**What.** Two new auto-scored types: `numeric` ("enter the value") and `multi_select` ("select all that apply"). Migration `0129_question_types_numeric_multi_select.sql` widens `questions_type_check`; nothing else in the schema changes.

**Why.** A university runs campus-placement aptitude tests. Aptitude papers need typed numeric answers and tick-all-that-apply items; both have one objectively right answer, so they are scored in the same deterministic path as MCQ (no AI, no admin evaluation queue).

**Content shapes** (`src/types.ts`, validated at create / update / JSON import via `validateQuestionContent`):
- `numeric`: `{ question, answer: number, tolerance?: number >= 0 (absolute, default 0), unit?: string, rationale? }`. `unit` is display-only.
- `multi_select`: `{ question, options: 2-10 strings, correct: unique in-range indexes (>= 1), scoring?: "all_or_nothing" | "partial" (default all_or_nothing), rationale? }`.

**Considered and rejected.** Relative / percentage tolerance (absolute is what aptitude keys use; one rule is easier to explain to an admin). Unit conversion (out of scope; the unit is a label). A separate scoring table (reuse `gradings`, `grader='deterministic'`). Per-option negative marks (partial scoring floors at 0, as the owner asked).

**Not included.** AI generation of these types (no skill or prompt change; `DIFFICULTY_SPEC` / generation wizard / auto-weight stay at the five generated types), numeric ranges, unit conversion, blueprint (`BLUEPRINT_QUESTION_TYPES`) support: assessments draw them from the pack pool as before.

**Impact.** 06 (answer shuffle, candidate sanitiser), 09 (scoring), 10 (renderers, editor), 16 (two help ids), apps/web runner. `modules/07-ai-grading` only had the "non-MCQ" queue predicates widened (see 07 SKILL.md). The AI allowlist (`AI_GRADEABLE_TYPES`) already excluded them. Docs: `docs/02-data-model.md`.

## Generation batches (E6, 2026-10-02)

`src/generation-batches.ts` registers three super-admin routes (`GET /api/admin/generation-batches/active`, `PUT/PATCH /api/admin/generation-batches/:id`) on the same guard as the generate routes, called from `routes.ts`. Table `generation_batches` is owned by 07 (migration 0142). PUT unions `completed_category_ids` (a stale tab cannot erase progress); a foreign id returns 409 without saying whose. `07 admin-generate.ts` also adds each finished category server-side, best-effort. Not included: server-side orchestration (the browser still drives categories; single-flight AI + CF 100 s timeout). Details: docs/03-api-contract.md "Batch 5 notes".

## Question type `structured_case` (SP7, 2026-10-03)

`StructuredCaseContentSchema` in `src/types.ts` (strict): `title`, `context`, optional `log_excerpt` (max 20000), 1-12 `steps` of `{ id, prompt, select: one|many, options (2-8), correct[] }`, optional `scoring` (`all_or_nothing` | `partial`, default partial), optional `explanation`. A `superRefine` enforces unique step ids, valid unique `correct` indexes, and one correct index for `select: one`. Migration `0152` widens `questions_type_check`. The type is in `QUESTION_TYPES` in the registry (`CONTENT_SCHEMA_MAP` was deleted in RW-68; use `getQuestionType(id).contentSchema`).
- **Why.** Several linked choices about one log or story, scored with no AI.
- **Rejected.** `scenario` with all-mcq steps (determinism would depend on content), extending `multi_select`.
- **Not included.** AI generation (`difficulty-spec.ts` excludes it), edit form for existing questions, `/try` demo.
- **Impact.** Scoring in 09, save check and candidate sanitizer in 06, editor in 10, help keys in 16. Hand-authored only.

## How to add a question type

RW-68 (2026-10-11) moved all per-type behaviour into the registry. Do these steps in order.

1. Create `packages/question-types/src/types/<id>/index.ts`. Export `definition` with the schemas, the flags (`aiGradeable`, `rubricRequired`, `rubricSynthesis`, `shuffleField`) and the hooks (`candidateView`, `coerceContent`, `guidanceText`, `rubricText`, `evalStructuralCheck`; plus `synthConcepts`, `deterministicScore` and `checkAnswer` when they apply).
2. Add the id to `QUESTION_TYPES` and the definition to `QUESTION_TYPE_REGISTRY` in `packages/question-types/src/registry.ts`.
3. Run `pnpm gen:question-type-check` and commit the generated migration. Do not edit it by hand.
4. Add an entry in each renderer map: `modules/10-admin-dashboard/src/question-types/renderers.tsx` and `apps/web/src/pages/take/renderers.tsx`.
5. Add help content for the `helpKey` in `modules/16-help-system`.
6. Run `pnpm lint:question-type-registry` and `pnpm typecheck`. Rule R6 and the `Record<QuestionType, ...>` maps fail until every part exists.

No `switch` in 04, 06, 07 or 09 needs a new case. Do not add `if (type === '<id>')` anywhere: the lint (R3) blocks it. See `docs/02-data-model.md` "Question type registry" and `packages/question-types/README.md`.

## Generation: `topic_focus` reaches the runtime (RV62, 2026-10-03)

`service.ts` passes `topicFocus` from the route body into the runtime input, so the skill variable `topic_focus` is the real string (it was always `null`). The route accepts at most 200 characters after trim and no control characters; else 400 `INVALID_PARAM`. The wizard has no field yet (API only). The generate skills must read `topic_focus` before it changes output; a prompt change is a deploy event with eval re-baseline. See 05, "Question generation: one shared plan".

## FR25 — rubric validation

`validateRubric` in `src/types.ts` is now a re-export of `parseRubric` from `@assessiq/rubric-engine` (same ok/data|errors shape). `saveRubric` (service/generation.ts) uses it too. Do not add a local rubric parser.

## FU-C13 (2026-10-06) - difficulty tags read back

`QUESTION_COLUMNS`, the list projection in `listQuestionRows`, `mapQuestionRow` and the `Question` type now carry `cognitive_level`, `nice_task_id`, `difficulty_params`, `attack_technique` (migration 0086). Read-only; the generator (`07 admin-generate.ts`) stays the only writer. The admin UI shows Bloom and NICE chips (question editor header, pack question rows).

## Curriculum frameworks (RW-55, 2026-10-11)

Migration `0169_curriculum_frameworks.sql`; read-only in this part.

- `frameworks` (slug, name, source, status), `taxonomy_nodes` (typed tree: board / stage / grade / subject / unit / outcome / criterion), `question_taxonomy` (question <-> node, JOIN RLS like `question_tags`).
- `tenant_id` NULL means platform-owned: visible to every tenant (SELECT policy), writable only by `assessiq_system`. Tenant-owned rows are writable by that tenant only.
- Framework 1 is `legacy-domains`: the old domains and categories tree. `domains.node_id` / `categories.node_id` point at a node. Blueprint draws resolve a node to `(domain_id, category_id)` inside the tenant through these columns, so the frozen pool keeps its shape.
- Mapping rule: domain = `subject` node (code = slug, position = display_order); category = `unit` node under its domain's node. A platform domain slug is ONE NULL-tenant node shared by all tenant copies; a category shared with the platform tenant is also one NULL-tenant node; tenant-local domains and categories get tenant-owned nodes.
- New rows stay linked (`src/taxonomy-nodes.ts`): `createDomain` / `createCategory` (tenant-owned nodes), `createPlatformDomain` / `setPlatformDomainStatus` (NULL-tenant node, status mirrored, `node_id` in the audit `after`), `seedTenantTaxonomy` and `clone.ts` provisioning (link to the existing platform node by code). A missing `legacy-domains` framework throws `FRAMEWORK_MISSING`.
- Routes (adminOnly, `taxonomy-routes.ts`): `GET /api/admin/frameworks` (`?status=all`), `GET /api/admin/frameworks/:id/nodes` (`?kind=`).
- Not included: node write routes and super-admin node CRUD (RW-61), CBSE / ICSE / IB seeds (RW-57), draws by outcome or criterion nodes, any UI.

## RW-68: registry dispatch (2026-10-11)

`answer-guidance-derive.ts` calls `guidanceText`. `service/generation.ts` calls `rubricText` and selects rubric-eligible types with `= ANY(AI_GRADEABLE_IDS)`. `difficulty-spec.ts` uses a `satisfies Record<QuestionType, ...>` map. `service/packs.ts` follows registry order for the default `supported_types` of a new category. Commit `d0b5bb8`. Not changed: `tools/assessiq-mcp` (standalone, parity-tested) and the `seed.ts` data list.

## RW-50: difficulty warn heuristics (Phase B, 2026-10-15)

`warnStructuralDifficulty(type, level, content)` in `difficulty-spec.ts` returns `{ code, message }[]`. It never rejects and never throws. Codes: `LOG_LINES_OUT_OF_RANGE`, `LOG_FINDINGS_OUT_OF_RANGE`, `MCQ_DISTRACTOR_LENGTH_SPREAD`, `MCQ_STEM_OVERLAP`, `SCENARIO_LENGTH_OUT_OF_RANGE`.

- Why: Phase A only gates hard structure. These catch drafts that pass the gate but miss the level's target.
- Thresholds live in the `DIFFICULTY_SPEC` rows (`logLines*`, `findings*`, `distractorSpreadMax`, `scenarioWords*`); the MCQ stem-overlap gap is a constant. Dispatch is a keyed `WARN_CHECKS` table.
- Lexical only (word match). Local embedder is out of scope. Thresholds are first guesses; tune from the Phase C drift report.
- Not included: wiring. Drafts are inserted inside `07 handleAdminGenerate`, which this task could not edit. `generateQuestions` returns only ids. Followup: 07 calls a `difficulty.warn` closure (like `validate`) and returns warnings in its result; 04 then passes them on.

## Framework seeds (RW-57)

Seeds are JSON files in `src/frameworks/<code>.json`. The contract is `schemas/framework-seed.schema.json`: `code`, `name`, `board`, `version`, `sourceUrls[]` and `nodes[]`. Each node has `code`, `title`, `kind`, `description`, `externalId` and `children`.

- `kind` is one of `board`, `stage`, `grade`, `subject`, `unit`, `outcome`, `criterion`. This is the `0169` CHECK list. Sibling codes are unique. Extra properties are rejected.
- The Zod schema in `src/framework-seeds.ts` is the runtime validator. There is no ajv. `import.schema.json` is validated the same way.
- To add a seed: drop the JSON file in `src/frameworks/` and add one static import to the `BUNDLED` map.
- Nodes are NULL-tenant platform rows. This matches `0169` and `platform-domains.ts`.
- `version` is stored in `taxonomy_nodes.syllabus_edition`. `externalId` is stored in `external_id`.
- `board`, `sourceUrls` and `description` are validated but NOT stored. Storing them needs a `meta jsonb` migration. The decision is deferred.
- `ensureNode` is not used. It is wired to `legacy-domains` and to the kinds `subject` and `unit`.
- Exports: `listBundledSeeds`, `loadFrameworkSeed`, `validateFrameworkSeed`.
- `sample.json` (board `SAMPLE`, 9 nodes) is for tests and is the example seed.
- Routes: see `docs/03-api-contract.md` section "Framework seeds". Board files CBSE, ICSE and IB shipped in part 2 (below).

## Framework seeds: board files and Platform page (RW-57 part 2, S10, 2026-10-16)

- **Bundled.** `src/frameworks/{cbse,icse,ib}.json` sit in the `BUNDLED` map of `src/framework-seeds.ts` next to `sample`. Node counts: CBSE 335, ICSE 340, IB 89.
- **Content.** CBSE: grades 6 to 12, core NCERT subjects. ICSE and ISC: by stage. IB: PYP, MYP (criteria A to D for each subject group) and DP.
- **Accuracy.** Chapter titles were written from memory. Subjects that are not verified have the description "partial: verify". Owner step: check one board against the official syllabus.
- **UI.** The Platform page section `PlatformFrameworksSection` (super admin only) lists the seeds and loads or reloads one. See `docs/08-ui-system.md` § "Platform page: Curriculum frameworks". Help key `admin.platform.frameworks` (migration 0173).
- **Not included.** Storing `board`, `sourceUrls` and `description` (still validated only).

## Question import pipeline (RW-58, S10, 2026-10-16)

- **What.** A super admin stages a CSV or XLSX file, fixes rows, then commits one draft pack. Tables: `question_imports` and `question_import_rows` (migration 0174, `docs/02-data-model.md` § "Question import"). Pack columns: `question_packs.source` (`authored`, `generated`, `import`) and `import_file_sha256`.
- **Files.** `src/import-routes.ts` (six routes, `superAdminOnly`) and `src/import/`:
  - `types.ts`: shared types.
  - `parse.ts`: CSV (RFC 4180) in the file itself. XLSX through `exceljs` 4.4 (pure JS, new dependency in this package). Limits: 2 MB, 2000 data rows, a `type` header column.
  - `templates.ts`: builds the template of one type from the registry (`getQuestionType(type).importColumns`). There is no per-type switch.
  - `staging.ts`: validates each row with `coerceContent` and `contentSchema`. Sets `content_hash` = sha256(type + canonical content). Marks a row `duplicate` when the hash matches a non-archived question in the domain or an earlier row. Lets the admin fix or skip a row. Discards an import.
  - `commit.ts`: creates one draft pack with `source = 'import'`, levels `L<position>` and draft questions for the `ok` rows. Writes one audit row.
- **Audit actions.** `question_import.staged`, `question_import.committed`, `question_import.discarded`.
- **Rules.** The same file (same sha256) while one is staged returns that import. The code calls no AI. The code adds no type switch: a new question type gets import support from its registry entry.
- **Errors.** `IMPORT_*` codes, listed in `docs/03-api-contract.md` § "Question import".
- **UI.** Page `/admin/question-import` (module 10). Help keys `admin.question_import.*` (migration 0175).
- **Rejected.** Parse and insert in one step. A hash column on `questions`.
- **Not included.** Category linking, a stored hash column.
- **Multipart upload (RW-97, S11, 2026-10-16).** The upload route accepts `multipart/form-data` as well as the JSON base64 body. The plugin `@fastify/multipart` is registered once in `apps/api` (this module only imports its types). Text fields come BEFORE the `file` part. A file over 4 MB gives `413 FILE_TOO_LARGE`. Why: base64 grows the file by one third and the UI had to encode it. Rejected: removing the JSON body (existing callers). The UI then offers "Draft rubrics" after a commit (module 10 page; it uses `generate-rubric` and `save-rubric`, no new route here). Contract: `docs/03-api-contract.md` § "Question import".

## Import v2 for exam files (EXP-4, 2026-10-17)

- **What.** The import (RW-58) now carries exam tags, rights and provenance. New files: `src/import/v2.ts` (column parsing, normalised-text hash, taxonomy lookup), `src/import/difficulty.ts` (scales `words`, `1-3`, `1-5`). Changed: `templates.ts` (12 new columns after `negative_marks`), `staging.ts` (`validateRowV2`, three duplicate classes), `commit.ts` (writes `question_source`, difficulty, language, taxonomy links), `repository.ts` (`insertQuestion` takes `sourceExtra`, `difficultyEst`, `languagePrimary`).
- **Why.** Plan `docs/design/2026-10-17-exam-pack-source-and-taxonomy-plan.md` section 0 (D1, D4): thousands of tagged items must go through the existing staging flow, with rights known at the first insert.
- **Rules.** `rights_status` is required for CSV and XLSX (v1 files give a row error per row; GIFT, Aiken and QTI default to `original`). `withdrawn` is never importable. An unknown stage, subject, difficulty label or scale is a row error. `scraped_raw` rows import; the EXP-2 publish gate blocks them from a published pack and must not be weakened here. Super admin only; caps stay 4 MB and 2000 rows.
- **Duplicates.** `exact` (content hash) and `normalised` (text hash) make a row `duplicate`. `similar` (pg_trgm, 0.8) only flags a row that stays `ok`. The report lists `checksRun`; `similar` is skipped when the extension is absent. Do not add `CREATE EXTENSION` to a migration.
- **Considered and rejected.** A wider hash column set on `questions`; a database table for difficulty scales; trigram inside one file; making `similar` a hard duplicate.
- **Not included.** PDF or Word extraction, embeddings, image upload, organisation-admin upload (EXP-17), hash backfill of old rows.
- **Downstream.** `docs/03-api-contract.md` section "Question import" (import v2), `docs/02-data-model.md` (Import v2 writes), help ids `admin.question_import.{columns,rights_status,difficulty,duplicates}` (migration `0195`), UI page `/admin/question-import` (duplicate chips, rights note).

## `clone.ts` is a barrel over `src/clone/` (RW-53, S10, 2026-10-16)

- **What.** `src/clone.ts` went from 1299 to 38 lines. It re-exports from `src/clone/`, so import paths do not change.
- **Layout.**
  - `helpers.ts`: shared row types, `uniqueNonNull`, `getPlatformTenantId`, `deriveCloneSlug`.
  - `clone-on-grant.ts`: `clonePackToTenant`, `materializeSetForTenant`.
  - `resync.ts`: `resyncClonedPack`, `resyncSetForTenant`, `listCloneTenantIdsForSource`.
  - `resync-types.ts`: `CloneQuestionRow`, `ResyncResult`.
  - `taxonomy.ts`: `provisionPlatformTaxonomyForQuestions`, `buildTaxonomyResolver`, `stableJson`.
- **Not included.** Any behaviour change. Tests and callers are unchanged.

## Taxonomy writes and pack filter (RW-61, S13, 2026-10-16)

**What changed.** `src/taxonomy-routes.ts` has three new routes (facts in `docs/03-api-contract.md` § "Question and pack taxonomy routes (RW-61)").
- `GET /api/admin/questions/:id/taxonomy` returns `{ node_ids, nodes }`. Any admin.
- `PUT /api/admin/questions/:id/taxonomy` takes `{ node_ids }` (at most 50, deduplicated). Super admin only. It checks that the question exists (404) and that every node is visible to the tenant (400). Foreign-key checks skip row-level security, so this check is the guard. Then it runs `DELETE` and `INSERT` on `question_taxonomy`, and `auditInTx` writes one `question.updated` row with `before` and `after` = `{ kind: 'taxonomy', node_ids }`.
- `GET /api/admin/packs/:id/taxonomy?node_id=` returns `{ items: [{ question_id, node_id }] }`. A recursive query adds all descendants of `node_id`.
- `handleAdminListDomains` now selects `node_id` (`handlers/admin-domains.ts`; type `DomainRow.node_id`).

**Why.** The picker (`docs/08-ui-system.md` § "Framework tree picker (RW-61, S13)") needs to read and write links. Question authoring is platform-only, so only a super admin writes.

**Considered and rejected.** A new audit action `question.taxonomy.updated`: the catalog has none, so the code reuses `question.updated` with `kind: 'taxonomy'` (the `save_rubric` pattern). Add the action when the catalog next changes. A merge-style write (the picker always sends the full set). Tenant writes (owner decision: tenants never author taxonomy).

**Not included.** Tenant node authoring. Links per level. Bulk edits. New generation parameters. Any change to clone and resync behaviour: they keep their own taxonomy code.

**Downstream impact.** The `PUT` route does not change question versions or pack snapshots. Clients of the domain list get an extra `node_id` field. Audit readers see `question.updated` rows with `kind: 'taxonomy'`.

## Import adapters, QTI export and negative marks (RW-59 and EX-1, S14, 2026-10-16)

### Import adapters (RW-59)

- **What.** The import pipeline accepts three more formats: `gift`, `aiken` and `qti`. The adapters are `src/import/adapters/{gift,aiken,qti,common}.ts`. Limits are in `src/import/limits.ts`: 4 MB (it was 2 MB) and 2000 rows. The row limit also applies to each unzipped QTI entry. The unzipped total is at most 16 MB.
- **Formats.** `gift` and `aiken` are UTF-8 text with MCQ questions only. `qti` is a QTI 2.1, 2.2 or 3.0 content package (`.zip`) or one `assessmentItem` `.xml` file. An item that the importer cannot map becomes a row error.
- **Mapping.** The QTI adapter maps through the registry field `qtiInteraction`: `choice` becomes `mcq` or `multi_select` (by `maxChoices`), `textEntry` becomes `numeric`, `order` becomes `ordering` and `extendedText` becomes `subjective`. There is no type switch in the adapter.
- **Parsers.** XML through `saxes` (no entity expansion). Zip through `jszip`. Both were already dependencies of `exceljs`. They are direct dependencies of this module now (`package.json`).
- **Templates.** The template route still serves `csv` and `xlsx` only.
- **UI and help.** The import page lists the accepted formats. A `.txt` file asks the user to choose GIFT or Aiken. Help ids: `admin.question_import.formats` and `admin.question_import.text_format`.

### QTI export (RW-59)

- **What.** `src/import/export.ts` builds a QTI 3.0 zip (`imsmanifest.xml` and `items/<id>.xml`) of the non-archived questions of one question set. The answer key is included. Route: `GET /api/admin/super/packs/:id/export?format=qti3` (super admin). Audit action `pack.exported` with `{ format, question_count }`. Route detail: [docs/03-api-contract.md](../../docs/03-api-contract.md) § "Question import formats and QTI export (RW-59)".
- **Why.** Owners move questions between tools. The export closes the loop with the import.
- **Not included.** QTI tests and sections. Numeric tolerance or unit in QTI. HTML or media in prompts. Feedback blocks. Any export format other than `qti3`.

### `negative_marks` (EX-1, migration 0184)

- **Column.** `questions.negative_marks NUMERIC(6,2) NULL CHECK (>= 0)`. `NULL` means "use the assessment default". It is metadata: a change does not create a `question_versions` row. Table detail: [docs/02-data-model.md](../../docs/02-data-model.md) § "S14 additions (2026-10-16)".
- **API field.** `POST /api/admin/questions` and `PATCH /api/admin/questions/:id` accept `negative_marks` (a number of 0 or more; `null` clears it on the patch). An invalid value returns 422 `NEGATIVE_MARKS_INVALID`. The list and detail return the field.
- **Import column.** An optional common column `negative_marks` (0 to 1000, blank means the default) in the CSV and XLSX templates.
- **Passage steps.** A `structured_case` step may carry its own `points` and `negative_marks` (no migration). See [docs/05-ai-pipeline.md](../../docs/05-ai-pipeline.md) § "Passage sets (EX-3)".
- **UI.** The question editor has an input for the value (create form and edit card). Help id `admin.question.editor.negative_marks` (renamed S15; the S14 id did not match the page prefix, see RCA 2026-10-17).
- **Not included.** A penalty for AI-graded types. Per-type penalty rules.

## Question source and exam columns (EXP-2, migration 0194, 2026-10-17)

- **What.** Table `question_source` (one row for each question: origin, rights status, source reference, licence, hashes, optional previous-year fields) and four `questions` columns: `difficulty_est`, `review_state`, `language_primary`, `content_i18n`. Full column list and backfill rules: `docs/02-data-model.md` section "Question source and exam columns".
- **Write paths.** `repo.insertQuestion` and `repo.insertAiDraftQuestion` write the source row through `repo.insertQuestionSource` (tenant from the pack). `07-ai-grading/src/handlers/admin-generate.ts` writes its own row (`ai_original`). Clone and re-sync call `copyQuestionSource` in `src/clone/helpers.ts`. Any new path that inserts into `questions` must write a row, or the pack cannot publish.
- **Rules.** `publishPack` throws `RIGHTS_NOT_CLEARED` for a missing row or `scraped_raw`. `withdrawQuestion` (route `POST /api/admin/super/questions/:id/withdraw`) archives the item, marks it withdrawn, bumps the pack version and audits. `updateQuestion` refuses to re-activate a withdrawn item. Clone and re-sync skip withdrawn masters.
- **Why.** Rights and provenance must be queryable and enforceable. The table is separate so provenance changes without a question version bump. `review_state` is separate from `status` because many readers depend on `status`.
- **Considered and rejected.** Exam columns on `questions`. A wider `status` CHECK. FKs to `users` and `question_imports` (cross-module FK trap). A SQL content hash.
- **Not included.** The review gate (EXP-18), editing of `difficulty_est` or `review_state` through a route, import columns (EXP-4), filters (EXP-5), Hindi (EXP-9), UI.
- **Grandfather.** Existing active questions were set to `review_state = 'verified'` by the migration without a review. Do not read this as "checked".
- **Takedown propagation (EXP-19, 2026-10-17).** `withdrawQuestion` calls `propagateTakedown` (`src/clone/takedown.ts`) in the same tx. It marks every clone (`source_question_id` = the withdrawn id) in every tenant archived plus `withdrawn`, and writes one `question.takedown_propagated` audit row per tenant (clone tenant id, actor `system`). Uses the clone-on-grant role switch (`assessiq_system`, then `assessiq_app` per tenant for the audit), restores the caller context. Idempotent. Why: closes the gap until the next re-sync. Rejected: background job, `withSystemRole` (cannot nest in `withTenant`). Not included: frozen assessment pools (EXP-20, owner decision). Tests: `src/__tests__/takedown-propagation.test.ts`.
- **Downstream.** Module 05 pickers need no change (they filter `status = 'active'`). Module 14 has the new audit action `question.withdrawn`. QTI export adds `provenance.json`. Test harnesses that apply a hand-picked migration list must apply 0174 and 0194 (see `aptitude-seed-migration.test.ts`).

## Exam blueprints (EXP-6, migration 0201, 2026-10-17)

- **What.** `src/exam-blueprints.ts`: tables `exam_blueprints` and `exam_blueprint_sections`, service (`listExamBlueprints`, `getExamBlueprint` exported to module 05; create, update, delete internal) and routes under `/api/admin/blueprints` (reads: any admin; writes: super admin, checked again in the handler). Seed: SSC CGL Tier 1, owner-verified.
- **Why.** A full mock needs the exam's real sections, marks and negative marking without per-admin set-up.
- **Rules.** No `tenant_id`: platform data, tenant sessions read only (no write policy). Writes use `withSystemRole`, then switch to `assessiq_app` to audit in the same transaction (same pattern as the framework seed load). Stage and subject ids must be platform nodes of the right kind. Update replaces the sections.
- **Considered and rejected.** Tenant-owned blueprints; storing the cutoff in the seed; a `total_questions` column.
- **Not included.** Other exams (add only after the owner verifies them), normalisation across shifts, rank prediction.
- **Editor UI (2026-10-31).** `/admin/exam-blueprints` shows New pattern, Edit and Delete to super admins only. The form is `modules/10-admin-dashboard/src/components/BlueprintEditor.tsx`: it calls `POST /api/admin/blueprints` (create) and `PUT /api/admin/blueprints/:id` (edit) and mirrors the zod body rules in its own checks. Delete calls `DELETE`, which archives the row: nothing is erased. Help ids `admin.blueprints.editor.*`. The form keeps the stored stage id, subject ids and allowed question types on edit; it has no picker for them.
- **Downstream.** Module 05 builds a draft from a blueprint (`createMockFromBlueprint`). Module 14 has three new actions. Tests: `src/__tests__/exam-blueprints.test.ts`.

### Review gate consumer (EXP-18, 2026-10-18)

Module 05 `publishAssessment` reads `questions.review_state`: `in_review`, `disputed` and `needs_fix` on an active pool question block publish (422 `QUESTIONS_NOT_VERIFIED`); NULL and `verified` pass. Part 2 (below) adds the writers: review actions, bulk verify, `in_review` on import.

### Review gate actions (EXP-18 part 2, 2026-10-18)

- **What.** `service/review.ts` (new): `reviewQuestion` (Verify, Needs fix with a note, Withdraw), `bulkVerifyPack` (every `in_review` question of one set, with an `expected_count` guard) and `getPackReview` (the list for the review screen, answer key included). Routes in `review-routes.ts` (three, on the `adminOnly` chain; see `docs/03-api-contract.md` § "Question review routes"). `withdrawInTx` was split out of `withdrawQuestion` so Withdraw from the review screen shares one code path. Imports (`import/commit.ts`, `bulkImport`) insert `review_state = 'in_review'` through the new `reviewState` field of `insertQuestion`. Clones keep the source state (`copyQuestionSource`, unchanged).
- **Authorization.** Role `admin` or `super_admin`; the pack tenant must equal the session tenant; a platform pack needs `super_admin`, an organisation pack needs `admin`. Checked in the handler (`assertReviewRole`) and in the service.
- **Audit.** `question.review_changed` with `before.review_state`, `after.review_state`, `action`, `bulk`, and (since Z-52 gap 6) `note_id`. The note TEXT is never in the audit row; it lives in `question_review_notes`. One row per question, also for bulk verify. `question.withdrawn` carries `note_id` the same way.
- **Locking.** `SELECT ... FOR UPDATE` in id order on the question rows. Module 05 share-locks the same rows in id order, so a review write and a publish or invite cannot interleave.
- **Why.** Owner rule D6: review before invite. **Considered and rejected:** a `review_note` column (migration, harness changes); `in_review` in `createQuestion` (breaks every fixture; EXP-17 will set it for organisation uploads); resetting the state on edit (not in the contract).
- **Z-52 rules (2026-10-19).**
  1. **Needs fix reaches clones.** Option chosen: propagate on mark (`propagateNeedsFix` in `service/review.ts`, same role-switch pattern as `propagateTakedown`). A read-time check was rejected: RLS hides the platform master from a tenant, so the module 05 gate cannot read it without a system-role query in the publish path. No schema change. Clones that are archived or already `needs_fix` are skipped. The clone is not restored when the master is verified again (content may differ; the tenant admin reviews it).
  2. **`restoreVersion` resets review.** A `verified` question becomes `in_review` (same rule as a content edit); NULL and other states are kept. Audit `content_restored`.
  3. **Locks and deadlocks.** Review writes (`FOR UPDATE`) and module 05 (`FOR SHARE`) lock rows in id order. Postgres `40P01` maps to `409 DEADLOCK_RETRY` (`asRetryableDeadlock`; module 05 `lockOrRetry`).
  4. **`expected_ids`** on bulk verify pins the exact set; `expected_count` is still accepted alone.
  Not included: Z-52 gaps 5 to 7, NULL backfill.
- **Not included.** EXP-17 organisation upload, `disputed` writer, Needs fix note outside the audit log.
- **Downstream.** Module 05 gates (publish, invite, resend, re-open). Module 14 action `question.review_changed`. Module 10 page. Module 16 help ids.
- **Tests.** `src/__tests__/question-review.test.ts` (each action, bulk, count guard, platform and tenant isolation, role refusal, imports, clone state).

## Passages (EXP-8, migration 0211, 2026-10-19)

- **What.** `passages` table plus `questions.passage_id` / `passage_position`. Import v2 reads `passage_ref` and `passage_text` (`import/v2.ts`, `applyPassageGroups` in `import/staging.ts`, group insert in `import/commit.ts`). `copyQuestionSource` in `clone/helpers.ts` copies the passage with the question.
- **Why.** EX-3 only had steps inside one `structured_case` question. Exams need one stem for several separate, separately scored rows. `structured_case` stays as is.
- **Considered, rejected.** Putting the passage text into `question_versions.content` (needs a change in every snapshot writer, and doubles the text per child). Mutable passages with a text copy on each `attempt_questions` row (more storage; immutable rows give the same freeze).
- **Not included.** Images (EXP-10), AI grading of passages, an edit screen (edit = new row + repoint), `has_passage` filter, re-sync of a changed link on an existing clone.
- **Import `math` column (2026-11-11).** The CSV importer (`tools/aiq-import-csv.ts`, commit aa9928d1) reads an optional `math` column; `true` sets `content.math` and runs the KaTeX save-time check at import. No schema change. See `docs/03-api-contract.md` "Import: math column".
- **Downstream.** 06 draws passages whole (see its SKILL). 11/apps/web show the passage above the stem.

## EXP-17 organisation upload and Z-52 gap 5 (2026-10-19)
- Admins upload through `/api/admin/question-imports*` (see docs/03-api-contract.md). It reuses `stageImport` and `commitImport`; `stageImport` takes an optional `tenantUpload` argument that forces origin `tenant_upload` and the uploader's rights on every row, also after a row edit (`question_imports.upload_rights_status`, migration 0209).
- The warranty (who and when) is stored on `question_imports` and in the audit row. The pack is private to the tenant. No AI call is made.
- `insertQuestion` defaults `review_state` to `in_review`; `insertAiDraftQuestion` writes `in_review`. The raw INSERT in `modules/07-ai-grading/src/handlers/admin-generate.ts` is outside this module and still writes NULL.
- Not included: plan quotas, backfill of legacy NULL rows.
- **EXP-17 UI support (2026-10-19).** `import/org-uploads.ts`: `listOrgUploads` (own uploads with question and withdrawn counts) and `withdrawImport` (every question with `question_source.import_id` = the import, through `withdrawInTx`, one transaction, idempotent). Routes `GET /api/admin/question-imports` and `POST /api/admin/question-imports/:id/withdraw`. All eight organisation routes take the `orgUploadGuard` option (admin chain plus `requireTier('question_upload')`, injected from apps/api; defaults to adminOnly). An optional `source_ref` upload field fills rows without one. Why no import-level audit row: the audit action list is module 14; the per-question `question.withdrawn` rows already carry the ids. Page: `modules/10-admin-dashboard/src/pages/org-question-upload.tsx`.

### Review notes, Dispute and review queue (Z-52 gaps 6 and 7, EXP-12, 2026-10-19)

- **What.** Migration `0214_z52_question_review_notes.sql`: append-only table `question_review_notes` (RLS SELECT and INSERT only, `FORCE`, trigger rejects UPDATE and non-system DELETE, `assessiq_app` has SELECT and INSERT only). `reviewQuestion` has a new action `dispute` (state `disputed`, note required like Needs fix). Any non-empty note on verify, needs_fix, dispute or withdraw is inserted in the same tx (`repo.insertReviewNote`), with the question version and the author. New service `listReviewQueue` (route `GET /api/admin/review-queue`) and `getReviewNotes` (route `GET /api/admin/questions/:id/review-notes`).
- **Propagation.** `propagateNeedsFix` became `propagateBlock(target)`: Needs fix and Disputed on a PLATFORM master reach tenant clones; audit text `needs_fix_propagated` or `disputed_propagated`, ids only. Frozen pools keep their copy.
- **Gate.** Module 05 is unchanged: any state but `verified` or NULL already blocks publish and invite. The `open` list filter includes `disputed`.
- **Queue scope.** Caller's own tenant only: super_admin sees the platform tenant, an admin sees the organisation. No content or answer key in the list. Archived and withdrawn rows are left out.
- **Why.** Audit rows must hold ids, not free text; a question page needs to show the reason; disputes (EXP-12) need history. **Rejected:** one `review_note` column (loses history).
- **Not included.** A UI, edit or delete of a note, candidate-raised disputes, re-scoring (none, bands untouched), notes on clones of a platform master (a tenant cannot read platform notes).


## Translations live inside `content` (FUT-3, 2026-10-21)

- **Rule.** The Hindi overlay (EXP-9) is stored inside the versioned `content` of `question_versions`, not in `questions.content_i18n` (migration 0194, line 82).
- **Why.** Candidates read the version. A version is frozen when an attempt starts, so a translation stored in the version cannot change under a running attempt. A column on `questions` is outside that freeze.
- **Rejected.** Keeping the overlay in `questions.content_i18n`. A separate translation table is rejected for the same reason.
- **Not included.** Any code now. Apply the rule when EXP-9 starts. Moving the existing `content_i18n` data is part of EXP-9. Design: `docs/design/2026-10-21-future-ready-question-store.md` D9.

## S50 additions (2026-10-22)
- Import options: `skip_trigram` (EXP-21, hash classes only), `target_pack_id` and `target_level_position` (EXP-23: append to an existing pack of the same tenant and domain; no pack is created; the pack version is NOT bumped, as with a manual add). Origin `template_generated` (EXP-21) needs a `seed_ref` `<template_id>@<version>:seed=<n>:gen=<generator_version>` (EXP-22); a repeated `seed_ref` is a `duplicate` of class `exact`. Super-admin withdraw by `seed_ref` prefix: `import/seed-withdraw.ts`.
- xlsx imports run an inflate budget (`assertXlsxInflateBudget`, 4 x `IMPORT_MAX_BYTES`) before ExcelJS reads the workbook (GATE-8 A6-1).

## S51 additions (2026-10-23)
- Organisation upload (EXP-17): csv and xlsx only, generated licence id on `question_source.licence_id`, optional `source_note`, plan limits from `plan-limits.ts` (`assertUploadWithinPlan`, per-tenant advisory lock at commit, only while `PLAN_TIERS_ENFORCED`). Module 04 now depends on `@assessiq/billing`.

## EXP-28 review queue additions (S62, 2026-10-26)

- `listReviewQueue` returns `reported` (questions with a candidate report) and `report_count` per item; the filter `reported` lists only those. Source: table `question_reports` (module 06, migration 0268), tenant-scoped by RLS, so an organisation sees its own candidates' reports. Platform master questions do not see the reports on tenant clones (not included; needs a system-role aggregate and an owner rule).
- A report does not set `disputed` or `needs_fix`. The staff review actions stay the only way to change a state.

### Decision: auto-dispute from candidate reports is OFF (owner, 2026-10-26)
- **Rule:** a candidate report (EXP-28) never changes marks, never changes the review state, and never moves a question to `disputed` by count. Only a human reviewer sets `disputed`.
- **Why:** a platform master question is shared by many organisations. If N reports flipped it to `disputed`, a few accounts (or one group of candidates, or a hostile user) could block a good question for every organisation. Reports are cheap to create and hard to verify, so a count is a weak signal. Free sign-up and Mock tests make abuse easier, not harder. A false block hurts marks and tests that are already running.
- **Considered and rejected:** (a) auto-dispute at a fixed N; (b) auto-dispute with a per-organisation count; (c) auto-hide from new draws after N. All three give the attacker a switch. The reviewer queue (Reported tab, Reports column) is the control.
- **Not included:** any threshold, any auto state change, any email on count.
- **Revisit when:** there is real report data and the reviewer queue is too slow. Then add a reviewer alert (not a state change) at a count. Any state change stays human.

## Z-166 report count across organisations (2026-10-28)

- **What.** `listReviewQueue` for the platform tenant (super admin) adds `all_orgs_report_count` to each item: candidate reports on the master question plus every organisation copy (`questions.source_question_id` = master id), summed by `crossOrgReportCounts` (system role, read-only, one `unnest` query for the page). Organisation admins get `null`.
- **Why.** Each organisation sees only its own reports, so one bad template looks small in every queue. The super admin needs the total to decide a fix at the master.
- **Rejected.** A new route (the queue already is the super-admin screen); a per-organisation breakdown (owner asked for counts only, no organisation or candidate detail); auto-dispute at a threshold (stays OFF, see above).
- **Not included.** Notes, reasons, tenant names, any write. Clones of clones are not followed (clones always point at the master).
- **Downstream.** Web review-queue Reports cell shows `N in all organisations` under the existing `admin.review_queue.reports` help tip (no new help id). Real-DB test: `question-review-notes.test.ts`.

## EXP-14 phase 1 (2026-10-29): owner columns

`questions`, `question_versions`, `question_tags`, `question_taxonomy` carry `tenant_id`; the four child tables and `question_source` carry `pack_id`. Insert triggers fill them from the parent, so services do NOT set them. Composite foreign keys reject a wrong owner. Rule: never UPDATE `pack_id` or `tenant_id` of a question (child keys block it). Phase 2 (licensed-read policies) is next; see `docs/02-data-model.md` and `docs/design/2026-10-21-future-ready-question-store.md` section 10.

## FUT-2 key hiding (2026-10-29)

Admin read routes return licensed questions (cloned: `source_question_id` set, or another tenant's) without key, rubric, translations, `source_ref` and `source_url` unless the caller is `super_admin`. Mechanism: `licensedQuestionSql(alias)`, `redactMasterKey(row)`, `adminViewFor(type, content)` and `mayReadMasterKey(role)` in `packages/question-types/src/licensed.ts` and `registry.ts`. Services take an optional `viewerRole`; only route handlers pass it. New admin read routes that return `content` or `rubric` MUST do the same (see `docs/03-api-contract.md` FUT-2). Per-organisation read bucket: `questionReadGuard` option, wired in `apps/api/src/server.ts`. Test: `src/__tests__/fut2-key-hiding.test.ts`.

## EXP-14 phase 2: licensed read (2026-10-29)

Platform packs are readable by a licensed tenant through `licensed_read` SELECT policies (0280), decided by `licensed_pack_ids()` / `readable_platform_packs()` / `licensed_platform_tenant()` (0279), and only while the env flag `LICENSED_READ` is on (default off). Rules, rollback and tests: `docs/02-data-model.md` section "EXP-14 phase 2". A NEW table that carries `pack_id` must get its own `licensed_read` policy (the lint refuses it otherwise). Do not add a write policy that depends on these functions. Admin list code must go through `buildQuestionWhere` (entitlement filter).

## EXP-25 part b: subject-map outcomes (S78, 2026-10-29)

- `src/frameworks/subject-map.json` now has 5 subjects, 37 units and 125 outcomes (Quant, Reasoning and English complete; General awareness and Technical aptitude have no outcomes yet). Still `draft-unverified`. Data only, no migration.
- Never rename, move or delete the 17 part A outcome codes (test `framework-seed-boards.test.ts`). Load twice is safe (`subject-map-load.test.ts`).
- The list of new units with reasons is in `docs/02-data-model.md` section "EXP-25 part b". Production has not loaded this framework yet: a super admin loads it from the Framework seeds screen.

## EXP-10 part 1: question images and maths (S79, 2026-10-29)

- `src/assets/`: `image-clean.ts` (strict PNG / JPEG structure check and metadata strip; pure), `assets.ts` (upload with caps under a per-organisation advisory lock, meta, bytes, `copyAssetsForContent` for clone and re-sync, `assertAssetsInPack`), `rich-validate.ts` (KaTeX save-time check, only when `content.math === true`), `routes.ts` (upload is super admin; reads are admin).
- `question_assets` rows never change. `question_versions.asset_ids` is filled by a trigger (migration 0284) that also enforces the same-pack rule. Clone-on-grant and re-sync MUST call `copyAssetsForContent` before they insert a question, and the re-sync change check compares the rewritten content.
- Only `getAssetBytes` and `copyAssetsForContent` (here) and module 06 `attempt-assets.ts` select the `data` column. Every list or meta query names its columns (a test scans the sources).
- Import carries no images: JSON `bulkImport` refuses `stem_assets` / `option_assets`; CSV and XLSX have no such columns.
- Full record: `docs/design/2026-10-17-exam-pack-source-and-taxonomy-plan.md` sections 12 and 13; `docs/02-data-model.md` section "EXP-10 part 1".


## EXP-7 exam-item generator, in-repo part (2026-10-31)

- **What:** `src/exam-item-gate.ts` (pure similarity gate and provenance), `src/service/exam-item-generation.ts` (body parser, gate pipeline, click path under the existing `withAiLock` single-flight, now exported from `service/generation.ts`), route `POST /api/admin/generate/exam-items` (super admin). Tests: `src/__tests__/exam-item-gate.test.ts` (synthetic data only).
- **Modes:** A1 writes new original items from a concept (`origin ai_original`, rights `original`). A2 light-edits a source question and keeps the reference (`origin` and rights `derived_from_source`, reference in `question_source.source_ref`). No migration: migration 0194 already has these values and columns. Migration 0288 stays unused.
- **Similarity:** Jaccard over word 3-grams (Unicode aware, Hindi works). A1 rejects at or above 0.35 to any seed. A2 needs 0.40 up to under 0.97 to its own source and rejects 0.85 or more against the platform bank. Constants live at the top of the gate file; tune them only with a measured sample.
- **Seeds:** passed in per run by the VPS side, held in memory, never stored here. Exam content, seeds and skill text never enter git (see "Exam content is never committed").
- **Not wired:** module 07 has no runtime hook for the skill `gen-exam-items` yet, so the route answers 501 `EXAMGEN_RUNTIME_NOT_WIRED` and no AI call is possible. No wizard mode selector yet. The route is synchronous (no detached polling) until the hook exists.

## EXP-9 A6 Hindi facet
- `has_hindi` (true/false) on the question list and `/facets`: true = `content #>> '{i18n,hi,question}'` is non-blank. AND-combined; the facet ignores its own filter. Facets reply gains `has_hindi: [{value:"true"|"false",count}]`.
- Different from the `language` facet, which filters the column `questions.language_primary` (the main language). No index, no migration (JSONB path scan within the pack filter).
- Tests: `__tests__/exp9-hindi-facet.test.ts` (Postgres testcontainer).


## EXP-9 A3 Hindi import columns
- Optional MCQ columns `question_hi`, `options_hi` (JSON array, same style as `options`), `rationale_hi`. All blank: no `i18n` key, file imports as before.
- Any Hindi cell filled: `question_hi` required; `options_hi` must have the same count and order as `options` (row error on `options_hi` otherwise). `rationale_hi` optional.
- Written to `content.i18n.hi = { question, options, rationale }` and checked by the real `McqContentSchema`. `correct` stays an English index.
- Non-MCQ row with a Hindi cell: row error. The MCQ template carries the three columns last, blank in the sample row.
- `assertValidMath` (`assets/rich-validate.ts`) walks `i18n.hi`, so Hindi text gets the KaTeX and deny-list checks when `math` is true. The duplicate hash (`import/v2.ts` `leaves`) skips `i18n`: the import cannot add Hindi to an existing question (it is a duplicate). Export (`export.ts`) does not round-trip the Hindi columns.

## Re-tag by seed prefix (S109-D6)
`retagBySeedPrefix(ctx, { moves, dryRun = true, packSlugs?, includeClones? })` (`src/service/retag.ts`, CLI `tools/aiq-retag.ts`) swaps ONLY the `question_taxonomy` link from one subject-map node to another for `template_generated` rows (rights not withdrawn, any question status, platform packs) whose `seed_ref` starts with a prefix. Needed because withdraw + reload of a live template row does not work (importer skips a known seed_ref of any status, 0246). Platform super_admin only; target must be an active `outcome` and differ from the source node.
- **Prefix:** end it with `@<digits>:`, for example `coord.distance_integer@1:`. `coord.x@1` would also match `coord.x@10:`. `_` and `%` are literal.
- **Two transactions, not one:** (1) all master moves on the platform tenant (atomic); (2) only with `includeClones`, the clone swap in a separate system-role tx (takedown mechanism), clones tied to the same master filter and to a master that already holds the target link. If (2) fails, (1) stays committed, the result has `cloneError`, the CLI prints the master table and exits 4; re-run with `--include-clones` (idempotent). Without `includeClones` a later resync only ADDS links (`copyQuestionTaxonomy`), so clones would hold BOTH links.
- **Audit:** one `question.updated` row per move (`kind: taxonomy_retag`, `count`, `question_ids`); per clone tenant `kind: taxonomy_retag_clones` with `clone_question_ids`.
- **Run order:** `--node-diff`; seed the framework (`aiq-import-csv.ts --seed-frameworks subject-map`); dry run; then `--commit --expect <n> --include-clones` (`--expect` refuses when the dry-run master count differs).
- **Rollback:** the reverse move (swap fromNode and toNode, same prefix).
- **Side effect:** reports read live topic links, so a move across units changes the topic breakdown of past attempts.
- Subject map gained `coordinate-geometry`, `statistics`, `cube-and-dice` (outcomes 125 to 128).

## Verify and activate by ids; snapshot repair (T-62, S110)

**What.** Three service calls and one tool.
- `verifyQuestionsByIds(actor, ids)` (`src/service/review.ts`): sets `review_state = 'verified'` for exactly the listed questions. `in_review` and NULL are changed; `verified` is counted as `alreadyVerified`. One audit row per changed question (`question.review_changed`, `after.bulk = true`, `after.by_ids = true`).
- `activateQuestionsByIds(actor, ids)` (`src/service/packs.ts`): `super_admin` only. Sets `status = 'active'` for the listed `draft` rows and writes the missing version snapshot for every listed row. One audit row per pack (`question.updated`, `after.kind = 'bulk_activate_by_ids'`, counts, `ids_sha256`, `first_ids`; no full id list).
- `backfillMissingSnapshots(actor, { commit, packSlugs })` (`src/service/packs.ts`): `super_admin` only. Counts, and with `commit` repairs, ACTIVE questions of the actor's tenant that have no `question_versions` row. One audit row per pack (`after.kind = 'snapshot_backfill'`).
- `activateAllQuestionsForPack` now also writes the missing snapshot for every active row of the pack (audit field `snapshots_written`).
- Shared helper `repo.snapshotMissingVersions(client, ids, savedBy)`: insert at `questions.version`, then `version + 1` (the `publishPack` rule), only for rows with no snapshot at all.
- Tool `tools/aiq-verify-activate.ts` (ids file or seed prefix; `--verify`, `--activate`, `--backfill-snapshots`; dry run by default; `--commit --expect <n>`).

**Why.** (1) The draw pool and the assessment freeze INNER JOIN `question_versions`. The CSV import writes no snapshot and the pack-wide activation wrote none, so a row imported into an already published pack was `active` but never drawn (RCA 2026-11-13). (2) The pack-wide activation flips every draft of a pack; a load needs a call that touches only its own rows.

**Rules.** Each by-ids call is one transaction and all-or-nothing: one refused id fails the call with `BY_IDS_REFUSED` (`details.bad` holds the first 20 ids with a reason) and nothing is written. 1 to 5,000 ids. The tenant filter is explicit in SQL (`p.tenant_id = actor.tenantId`); RLS is not relied on, because policy `licensed_read` shows licensed rows of other tenants. Activate refuses: not found, pack not published, withdrawn, `archived`, `ai_draft`, a draft that is not `verified`, a draft whose rights are not cleared. Verify refuses: not found, withdrawn, archived, `needs_fix`, `disputed`.

**Guards added after review.** `activateQuestionsByIds` and `backfillMissingSnapshots` call `assertRoleFitsTenant`: platform organisation only, organisation clones are never touched. Ids are format-checked and lower-cased. `snapshotMissingVersions` repeats the "no snapshot" guard in its INSERT, so two parallel runs cannot write two snapshots. `backfillMissingSnapshots` takes `expect` and refuses inside the write transaction when the count differs; an unknown pack slug is an error. `activateQuestionsByIds` returns one `idsSha256` per pack, equal to the audit row.

**Known limits.** An assessment published before a repair keeps its frozen pool; it needs a new publish to get the repaired rows. A draft edited before activation is drawn with its text from before the edit (existing rule: an edit shows after a re-publish). `activateAllQuestionsForPack` on a pack with 0 drafts throws before its repair step; use the backfill.

**Differences from the pack-wide calls.** `activateQuestionsByIds` requires `verified` for a draft (the pack-wide call does not); it returns zero counts when nothing changes (the pack-wide call throws `NO_DRAFT_QUESTIONS_TO_ACTIVATE`); it throws on rights not cleared (the pack-wide call skips such rows). `verifyQuestionsByIds` is not the `bulkVerifyPack` rule: `bulkVerifyPack` takes only `in_review` rows and leaves the rest.

**Considered and rejected.** `revisePack` then `publishPack` as the repair (a new snapshot for every row, the live pack in `draft` for a moment, every draft auto-activated). A raw SQL insert (no audit row). A snapshot write in the import commit (a draft row would then carry a snapshot before review; the repair sits at the one point every row passes: activation). An HTTP route (the tool is the only caller). Chunked calls (a failure in a later chunk would leave a partial write).

**Not included.** A pack version bump, so organisation clones do not receive newly activated rows until a publish (`clone/resync.ts` is a no-op unless the pack version rose): owner decision. A change of "Verify all".

**Hold rule (owner 2026-11-13, option a).** `repo.bulkActivateDraftQuestionsForPack` (used by "Activate all" and by the auto-activation of `publishPack`) does not activate a draft marked `needs_fix` or `disputed`; the row stays draft and is counted in `heldBack` (audit field `held_back`, error detail `heldBack`). `in_review`, `verified` and NULL activate as before. To hold a row out of a load, mark it `needs_fix`. Rejected: "only verified or NULL activates" (it stopped the publish flow for every `in_review` question; 6 existing tests showed it).

**Downstream.** Modules 05 (freeze) and 06 (draw pool) now see rows that were imported after the pack was published. Audit consumers see two new `after.kind` values and one new field. No schema change, no route, no help id.

**Tests.** `src/__tests__/verify-activate-by-ids.test.ts` (real Postgres, 7 cases: the pool query returns the row after either activate call, a later edit does not collide, a draft outside the list stays draft, refusals write nothing, exact verify audit shape, idempotent re-run, backfill). `tools/__tests__/aiq-verify-activate.test.ts` (23 cases, fakes).

## Snapshot on every activation path, organisation repair, clone sync (T-62 part 2, S110)

**What.**
- `updateQuestion` (`src/service/questions.ts`): when a call sets `status` to `active`, `repo.snapshotMissingVersions` runs AFTER `updateQuestionRow`. A row with no snapshot that is edited and activated in one call gets ONE snapshot with the NEW content (the old-content snapshot and its version bump are skipped for that row only). A row that already has a snapshot keeps the snapshot-before-update rule.
- `bulkUpdateQuestionStatus` to `active`: snapshot for the updated ids (audit field `snapshots_written`).
- `backfillMissingSnapshots`: organisation mode. Platform tenant needs `super_admin`; an organisation needs its own `admin` (`assertReviewRole` + `assertRoleFitsTenant`). Only the actor's own tenant is read or written.
- `activateAllQuestionsForPack` and `activateQuestionsByIds`: when rows were activated, the pack version rises by 1 in the same transaction (audit field `pack_version`), and after the commit the pack is pushed to its organisation clones (`autoSyncClonesForPack`, best-effort, never inside the activation transaction). One switch: `SYNC_CLONES_ON_ACTIVATION` in `src/service/packs.ts` (false = no bump, no push; the tool is then the only path). `activateQuestionsByIds` returns `cloneSync` (tenants, updated, failed per pack).
- `syncClonesForPack(actor, slug, { commit, expectAdded })`: platform `super_admin` only. Dry run = the real `resyncClonedPack` per clone in a system-role transaction that is always rolled back; it returns per clone `added`, `changed`, `archived`, `skipped`, plus `wouldRevive`, `unchanged`, `clonePackStatus`, `missingInClone`. Commit refuses before any write when a clone would skip rows or when the added total differs from `expectAdded`; bumps the pack version only when a clone is at or above the master version and misses rows; then `resyncSetForTenant` per clone, with a result or an error per clone.
- Clone code (`src/clone/clone-on-grant.ts`, `src/clone/resync.ts`): `negative_marks` is copied into NEW clone rows.
- Tool `tools/aiq-verify-activate.ts`: `--backfill-snapshots --tenant <slug>`, `--sync-clones --pack <slug> [--commit --expect <n>]`.

**Why.** Owner words 2026-11-13: organisation clones get newly activated rows (option 1), and the snapshot fix must hold for every organisation and every future row. Two more paths set a question active with no snapshot (single-question status change, bulk status change); 267 rows of one organisation were in that state since May 2026. `resyncClonedPack` is a no-op unless the master pack version rose, and only `publishPack` raised it, so rows activated after a publish never reached a clone.

**Considered and rejected.** A database trigger on `questions.status` (the clone code inserts active rows and writes its own snapshot at the same version: a trigger would collide or need its own rules). A second implementation of the resync diff for the dry run (two code paths that can disagree). A cross-tenant repair run by the platform actor under the system role (the organisation admin as actor keeps the tenant filter and the audit row inside the tenant). A version bump or a clone push on the single-question and bulk-status paths (snapshot only there). Bumping on every `--sync-clones` commit (a repeat run would bump for nothing).

**Not included (recorded as later rows).** Refresh of `review_state`, the Hindi overlay and `difficulty_est` on EXISTING clone rows; an archived-pack check inside `resyncClonedPack` (the manual Update endpoint can reach an archived clone pack); `cognitive_level`, `nice_task_id`, `difficulty_params` are not copied to clones; `negative_marks` on clone rows that exist already (no data fix); the strict hold rule.

**T-85 and T-86 (S111, 2026-11-13).** `resyncClonedPack` now reads the clone pack status and throws `ValidationError` `CLONE_ARCHIVED` for an archived clone pack, before any write. Why: the manual Update endpoint (`resyncLicensedSet`, module 05) could add and revive rows in an archived clone; the automatic push and `syncClonesForPack` already skip archived clones, and each of their loops catches the error per clone. `copyQuestionSource` (`clone/helpers.ts`) now also copies `cognitive_level`, `nice_task_id`, `difficulty_params` and `attack_technique`, so NEW clone rows get them on both paths (clone-on-grant and resync insert). These 4 columns are display only (admin chips, analytics); no draw, pool or scoring code reads them. Rejected: a refresh of the 4 columns on EXISTING clone rows (it goes with T-84, owner decision) and a copy into `question_versions` (no code writes those columns there). A full column diff of `questions` found no other column that the clone misses. Known limit (row T-89, owner decides): a revoke archives the clone pack and a later re-grant reuses that pack but does not set it back (`19-billing/src/service.ts`, `clone-on-grant.ts`), so the manual Update then returns `CLONE_ARCHIVED` until the pack is un-archived. Tests: `snapshot-all-paths.test.ts` 18 and 19 (24 in the file).

**T-89 (S111, 2026-11-13).** `clonePackToTenant` (`clone/clone-on-grant.ts`, the reuse branch) restores a clone pack that a licence revoke archived: when the organisation uses the set again (`importLicensedSet` or `createAssessmentFromSet` in module 05, after the licence check) the pack goes back to `published` and `resyncClonedPack` brings it to the master version, in the same system-role transaction and under the same advisory lock. `materializeSetForTenant` writes one `tenant.pack_resynced` audit row with `unarchived: true`. Why here and not at the grant: `grantEntitlement` (module 19) makes no clone and 19 has no dependency on 04 (RW-47 rejected that dependency), so the first licensed use is the re-grant event for the clone. Only a revoke archive is undone: the code looks for a `tenant.pack_clone_archived` audit row that names the clone id with no newer `pack.archived` row for the pack; a pack that an admin archived by hand stays archived (the earlier dead end stays for that case). Rows that an admin archived by hand follow the normal resync rules (a row whose master is active becomes active again, as in every resync). Rejected: an UPDATE inside `grantEntitlement` (no resync possible there, and it would restore before any use); un-archive of every archived clone (it would undo a deliberate archive, for example S109-D5). Not included: no change in module 19, no new audit action, no UI text. One revoke archive is undone only once: a later `tenant.pack_resynced` row with `unarchived: true` consumes it, so a pack archived again with no audit row stays archived; the audit lookup is pinned to the tenant. Planner rulings (not owner words): (a) the licence check runs in its own transaction before the materialize, so a revoke that commits between the two is undone at once; accepted, because the same race exists for a first clone, the window is one request, publish stays blocked by `assertPublishEntitled` and the next use is blocked by the licence check (open row T-90: re-check the licence inside the materialize transaction); (b) a throw in the resync rolls back the un-archive and fails the request. The audit row also carries `new_pack_version`. Tests: `snapshot-all-paths.test.ts` 20, 20b, 20c, 20d and 21 (29 cases in the file).

**Downstream.** Each activation in a platform pack now changes the banks of every organisation that holds a clone, at once, and raises the pack version number shown in the admin. A resync also updates clone rows whose master changed, sets a non-active clone row back to active when its master is active, and archives clone rows whose master left the active set (existing rule). Published assessments keep their frozen pool (module 05). Audit consumers see `pack_version`, `snapshots_written` on bulk status rows, and a `pack.updated` row with `after.kind = 'version_bump_for_clone_sync'`.

**Tests.** `src/__tests__/snapshot-all-paths.test.ts` (real Postgres, 22 cases after the review round: all paths, the combined edit-and-activate case, organisation mode and its refusals, push on activation, dry-run purity by a whole-database fingerprint, commit equals preview, archived clone pack untouched, `negative_marks` on both clone paths, a forced clone failure, expectAdded and skipped guards). `tools/__tests__/aiq-verify-activate.test.ts` (62 cases after the review round).

**Review round (two independent read-only reviews, S110 part 2).**
- Activation is the publish event of a row: `repo.snapshotForActivation` runs for every row that goes draft or ai_draft to active (by ids, Activate all, `updateQuestion`, bulk status). It writes a snapshot when the row has none OR when its newest snapshot differs from the row in content, rubric or type (jsonb equality; SQL NULL and JSON null rubric count as equal), so a draft that was edited before activation is drawn with its current text. `repo.snapshotMissingVersions` (missing only) stays for rows that are already active (repair in Activate all, by-ids for active ids, `backfillMissingSnapshots`): an edit of an active row still shows only after a re-publish (existing rule).
- `activateAllQuestionsForPack(tenantId, packId, userId, { awaitCloneSync })` returns `cloneSync: "background" | "done" | "off"`. The HTTP route passes `awaitCloneSync: false`: the response does not wait for the clone push (own connections, own catch and log).
- `autoSyncClonesForPack` returns `{ tenants, updated, failed, skipped }`; `activateQuestionsByIds.cloneSync` carries it; the tool exits 4 when failed or skipped is above 0.
- `syncClonesForPack` commit refuses before any write when a clone preview failed (`details.preview_errors`), and marks a clone whose real resync skipped rows with `error`.
- `updateQuestion` returns and audits the real version after an activation snapshot.
- Known limits: `negative_marks` is copied to NEW clone rows only (existing clone rows keep their value: owner decision); a content-only edit of an ACTIVE row that has no snapshot serves the old content (older state; the repairs leave no such platform row); `wouldRevive` is reported from a read before the sync.
