# 08-rubric-engine — Anchors, bands, scoring DSL

## Purpose
Define the data structure that turns subjective questions into AI-gradable units. The rubric is the contract between question authoring (04) and AI grading (07).

## Scope
- **In:** rubric schema (anchors, weights, reasoning bands, error classes), validation, helpers for converting AI outputs into per-question scores, rubric authoring UI helpers, anchor synonym resolution.
- **Out:** the AI calls themselves (07), final aggregation (09).

## Dependencies
- `00-core`
- `04-question-bank` (rubrics live in `questions.rubric` JSONB)

## Rubric schema
```ts
type Rubric = {
  anchors: Anchor[];               // required concepts the answer must cover
  reasoning_bands: ReasoningBands; // 5 bands (0..4) defining quality tiers
  anchor_weight_total: number;     // sum of all anchor weights
  reasoning_weight_total: number;  // weight of reasoning quality (band/4 multiplied)
  error_classes?: string[];        // taxonomy of common mistakes for this question
};

type Anchor = {
  id: string;                      // 'a1','a2',...
  concept: string;                 // human-readable name
  weight: number;                  // 0..100
  synonyms: string[];              // strings the AI considers equivalent expressions
  required?: boolean;              // if true, missing this anchor caps band <= 2
};

type ReasoningBands = {
  band_4: string;  // description of what earns top band
  band_3: string;
  band_2: string;
  band_1: string;
  band_0: string;
};
```

## Public surface
```ts
validateRubric(rubric: Rubric): { valid: boolean, errors: string[] }
sumAnchorScore(anchors: Anchor[], findings: AnchorFinding[]): number
computeReasoningScore(rubric: Rubric, band: number): number
finalScore(rubric: Rubric, findings: AnchorFinding[], band: number): { earned, max }
```

## Worked example
```ts
const rubric = {
  anchors: [
    { id: 'a1', concept: 'lateral movement', weight: 20, synonyms: [...] },
    { id: 'a2', concept: 'credential reuse', weight: 20, synonyms: [...] },
    { id: 'a3', concept: 'pivot to identity', weight: 20, synonyms: [...] }
  ],
  reasoning_bands: { band_4: '...', ... },
  anchor_weight_total: 60,
  reasoning_weight_total: 40
};

// AI says: a1 hit, a2 hit, a3 miss; band 3
// anchor_score = 20 + 20 = 40
// reasoning_score = (3/4) * 40 = 30
// total: 70 / 100
```

## Authoring guidance (surfaced in admin help)
- 3–6 anchors is the sweet spot. Too few → AI grades too lenient. Too many → fragmented signal.
- Synonym lists prevent surface-keyword failures. Include MITRE IDs, common abbreviations, alternate phrasings.
- Reasoning band descriptions should be 1–2 sentences and behaviorally specific. "Band 4: shows correct causal chain AND correct escalation path" not "Band 4: very good".
- Required anchors: use sparingly. Reserved for concepts where missing = wrong-direction answer.

## Help/tooltip surface
- `admin.rubric.anchor.weight` — weighting strategy
- `admin.rubric.anchor.synonyms` — why and what to include
- `admin.rubric.reasoning.bands` — band-writing guidance
- `admin.rubric.error_classes` — taxonomy purpose, how it feeds learning loops

## Open questions
- AI-assisted rubric drafting from a sample answer — Phase 2 admin tool
- Rubric inheritance (level-default + question-specific override) — defer
