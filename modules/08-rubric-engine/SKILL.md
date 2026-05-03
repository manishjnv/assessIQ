# 08-rubric-engine — Anchors, bands, scoring DSL

> **Status:** live (Phase 2 G2.B Session 2 — 2026-05-03). Service-only; ships zero migrations. Public surface stable.

## Purpose
Single source of truth for the rubric data structure that turns subjective questions into AI-gradable units, plus the pure-function scoring math that converts AI outputs into per-question scores. The rubric is the contract between question authoring (04), AI grading (07), and score aggregation (09).

## Scope
- **In:** rubric Zod schema (`RubricSchema`, `AnchorSchema`, `AnchorFindingSchema`), rubric validation (`validateRubric`), per-question score helpers (`sumAnchorScore`, `computeReasoningScore`, `finalScore`).
- **Out:** the AI calls themselves (07), final aggregation across questions / archetype / cohort (09), DB persistence (rubrics live in `questions.rubric` JSONB owned by 04).

## Module boundary (P2.D12)
**Service-only — zero migrations, zero DB access, zero Fastify routes.** The rubric DSL is denormalized in `questions.rubric` JSONB owned by 04. The earlier draft of `docs/02-data-model.md` listed 08 as owning `rubrics`/`anchors` tables; that line was dead text and never shipped — the data-model row was updated in this session to record the service-only boundary explicitly.

## Dependencies
- `zod` (peer)

That is the entire dependency surface. No `@assessiq/core`, no DB, no Fastify, no auth — keeps 08 importable from any layer including pure unit tests.

## Schema (lifted from 04 — verbatim)
```ts
type Anchor = {
  id: string;                      // 'a1','a2',...
  concept: string;                 // human-readable name
  weight: number;                  // 0..100, integer
  synonyms: string[];              // strings the AI considers equivalent expressions (≥1)
};

type Rubric = {
  anchors: Anchor[];               // ≥1 required concepts the answer must cover
  reasoning_bands: {               // 5 bands (0..4) defining quality tiers; all required
    band_4: string;
    band_3: string;
    band_2: string;
    band_1: string;
    band_0: string;
  };
  anchor_weight_total: number;     // 0..100
  reasoning_weight_total: number;  // 0..100
  // INVARIANT: anchor_weight_total + reasoning_weight_total === 100
};

type AnchorFinding = {
  anchor_id: string;
  hit: boolean;
  evidence_quote?: string;
  confidence?: number;             // 0..1
};
```

The aspirational `required` flag on `Anchor` and `error_classes` field on `Rubric` mentioned in earlier drafts of this SKILL.md are **NOT** in the shipped schema. They remain a Phase 3+ rubric-DSL upgrade if/when admin authoring proves the need.

## Public surface
```ts
import {
  AnchorSchema, RubricSchema, AnchorFindingSchema,
  type Anchor, type Rubric, type AnchorFinding,
  validateRubric,
  sumAnchorScore, computeReasoningScore, finalScore,
} from "@assessiq/rubric-engine";

validateRubric(rubric: unknown): { valid: boolean; errors: string[] }
sumAnchorScore(anchors: Anchor[], findings: AnchorFinding[]): number
computeReasoningScore(rubric: Rubric, band: number): number
finalScore(rubric: Rubric, findings: AnchorFinding[], band: number): { earned: number; max: number }
```

`validateRubric` returns the unified `{ valid, errors }` shape with human-readable error strings (path-prefixed). 04-question-bank ships its own internal `validateRubric` returning `{ ok, data | errors: ZodIssue[] }` for service-internal consumers (its `createQuestion`/`updateQuestion` paths bind to ZodIssue for per-issue error code mapping); the two coexist on purpose — same name, different module, different return contract.

## Score formula (verbatim from `docs/05-ai-pipeline.md` § Score computation L336–345)
```
anchor_score    = sum(anchor.weight for each finding where hit === true)
reasoning_score = (band / 4) * rubric.reasoning_weight_total     // band ∈ [0..4]
earned          = anchor_score + reasoning_score
max             = anchor_weight_total + reasoning_weight_total   // == 100 by invariant
```

### Worked example (matches the test fixture)
```
Rubric: 3 anchors @ weight 20 each (anchor_weight_total=60), reasoning_weight_total=40
AI says: a1 hit, a2 hit, a3 miss; band 3
  anchor_score    = 20 + 20 = 40
  reasoning_score = (3/4) * 40 = 30
  earned          = 70
  max             = 100
```

## Re-export contract (zero consumer churn)
- `@assessiq/question-bank` re-exports `AnchorSchema`, `RubricSchema`, `Anchor`, `Rubric` from this module so existing `import { RubricSchema } from "@assessiq/question-bank"` lines keep working unchanged.
- `@assessiq/ai-grading/runtimes/claude-code-vps.ts` imports `finalScore` from this module (replacing its prior local `computeFinalScore` helper which has been removed).
- 09-scoring will consume `sumAnchorScore` + `computeReasoningScore` + `finalScore` for per-question recompute on override (Phase 2 G2.B Session 3, next).

## Authoring guidance (surfaced in admin help via P2.D17 keys)
- 3–6 anchors is the sweet spot. Too few → AI grades too lenient. Too many → fragmented signal.
- Synonym lists prevent surface-keyword failures. Include MITRE IDs, common abbreviations, alternate phrasings.
- Reasoning band descriptions should be 1–2 sentences and behaviorally specific. "Band 4: shows correct causal chain AND correct escalation path" not "Band 4: very good".

## Help/tooltip surface
- `admin.rubric.anchor.weight` — weighting strategy
- `admin.rubric.anchor.synonyms` — why and what to include
- `admin.rubric.reasoning.bands` — band-writing guidance
- `admin.rubric.error_classes` — taxonomy purpose, deferred to Phase 3+ rubric DSL upgrade

## Anti-pattern guards
- **NEVER** add migrations or DB access to this module — service-only is the contract (P2.D12).
- **NEVER** import the AI runtime, Fastify, auth, or pg from here — keeps 08 a leaf module that downstream consumers can pull in without dragging the world.
- **NEVER** introduce a stateful `RubricEngine` class — pure functions only, deterministic, idempotent.
- **NEVER** rename or change the signatures of the four public helpers without coordinating with 07 + 09 (and updating their tests). The signatures are pinned by PHASE_2_KICKOFF.md G2.B Session 2.

## Open questions / Phase 3+ deferrals
- AI-assisted rubric drafting from a sample answer — Phase 2 admin tool (P2.D14 covers the authoring UI shell).
- Rubric inheritance (level-default + question-specific override) — deferred.
- `required` flag on `Anchor` (capping band ≤ 2 when a required anchor misses) — deferred to Phase 3+ rubric DSL upgrade.
- `error_classes` taxonomy on `Rubric` (driving the learning-loop reports in 15-analytics) — deferred to Phase 3+.

## Decisions resolved
- **P2.D12 — module boundary.** Service-only, zero migrations. `questions.rubric` JSONB owned by 04 stays canonical. `docs/02-data-model.md` § "Module ownership" row updated this session to remove the dead `rubrics`/`anchors` table reference.
