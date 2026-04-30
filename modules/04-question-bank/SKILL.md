# 04-question-bank — Packs, levels, questions

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
- `admin.questions.type.subjective.rubric` — how anchors and reasoning bands work
- `admin.questions.type.kql.expected_keywords` — pattern matching limits, escape characters
- `admin.questions.type.scenario.step_dependency` — linear vs parallel; what fails downstream
- `admin.questions.import.format` — JSON/CSV schema with examples
- `admin.questions.generate.draft` — what the AI generator does, why human review is mandatory

## Open questions
- Question marketplace / shared packs across tenants — Phase 4 if multi-client demand emerges
- Per-question prerequisites (must answer Q1 before Q2 unlocks) — defer to scenario-only flow

## Decisions captured (2026-05-01)

Pinned ahead of Phase 1 G1.A Session 1 per `docs/plans/PHASE_1_KICKOFF.md` § Decisions captured. User confirmed all four user-blocking decisions resolve to orchestrator defaults.

### `log_analysis` content shape (decision #3)

`questions.content` for `type='log_analysis'` mirrors the `kql` shape with two field swaps: `log_excerpt` (raw log text) replaces `tables` and `expected_findings` (fuzzy concept list, anchor-style matching) replaces `expected_keywords`. Adds `log_format` enum (`syslog | json | csv | freeform`) so the candidate UI picks a syntax-aware viewer. Canonical schema lives at `docs/02-data-model.md` § "questions.content shapes by type" → "**Log_analysis**". Zod schema in `modules/04-question-bank/src/types.ts` (lands in G1.A Session 1).

### Bulk import file format (decisions #4 + #13)

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

`publishPack(id)` flips `question_packs.status` to `published` AND writes a `question_versions` row for every question in the pack at the current `(content, rubric)`, **even if no edit happened since the last publish**. This guarantees a permanent immutable snapshot keyed by `(question_id, version)` for the published pack version. Subsequent question edits create new `question_versions` rows but do NOT alter the published snapshot — until `publishPack` is called again, which bumps `question_packs.version` and re-snapshots. Resolves the SKILL.md ambiguity about whether publish is a metadata-only flip or a content snapshot. (It's both.)
