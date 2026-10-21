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

**What:** question text and answer keys never go into git. The repo is public; anything committed is readable by every candidate. The aptitude seed (`0109_seed_platform_aptitude_pack.sql`, already applied in prod) was moved to `docs/exam-content/` (gitignored, local only) and untracked; `.gitignore` also blocks its old path. `tools/gen-aptitude-migration.ts` now writes there by default, and the real-content block of `aptitude-seed-migration.test.ts` reads from there (skips in CI).
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
- **Not included.** Other exams (add only after the owner verifies them), UI and help ids, normalisation across shifts, rank prediction.
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
