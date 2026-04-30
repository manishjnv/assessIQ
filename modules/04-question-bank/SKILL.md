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
