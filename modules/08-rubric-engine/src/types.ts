// AssessIQ — @assessiq/rubric-engine canonical types.
//
// Phase 2 G2.B Session 2 — lifted verbatim from modules/04-question-bank/src/types.ts
// per PHASE_2_KICKOFF.md § P2.D12. The rubric DSL is denormalized in the
// `questions.rubric` JSONB column owned by 04; 08 is a service-only module
// that exposes the canonical Zod schemas + scoring math used by 04 (validation
// at write-time), 07 (score computation at proposal-time), and 09 (score
// aggregation in Phase 2 G2.B Session 3).
//
// 04 re-exports `RubricSchema`, `AnchorSchema`, `Rubric`, `Anchor` from this
// module so existing consumer imports (`import { RubricSchema } from
// '@assessiq/question-bank'`) keep working without churn.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Anchor — one required concept the answer must cover
// ---------------------------------------------------------------------------
//
// Lifted verbatim from 04. The synonyms array drives the AI's keyword
// resolution at Stage 1; weight contributes to the final score per
// docs/05-ai-pipeline.md § "Score computation". The `required`/`error_classes`
// extensions sketched in modules/08-rubric-engine/SKILL.md are NOT in the
// shipped schema — they are aspirational for a future Phase 3+ rubric DSL
// upgrade and remain unimplemented.

export const AnchorSchema = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  synonyms: z.array(z.string().min(1)).min(1),
}).strict();

export type Anchor = z.infer<typeof AnchorSchema>;

// ---------------------------------------------------------------------------
// Rubric — full per-question rubric DSL stored in questions.rubric JSONB
// ---------------------------------------------------------------------------
//
// `anchor_weight_total + reasoning_weight_total === 100` is the load-bearing
// invariant: the score-computation math in score.ts assumes the totals add
// to 100 so finalScore returns a percentage-equivalent fraction.

export const RubricSchema = z.object({
  anchors: z.array(AnchorSchema).min(1),
  reasoning_bands: z.object({
    band_4: z.string(),
    band_3: z.string(),
    band_2: z.string(),
    band_1: z.string(),
    band_0: z.string(),
  }).strict(),
  anchor_weight_total: z.number().int().min(0).max(100),
  reasoning_weight_total: z.number().int().min(0).max(100),
}).strict()
  .refine(
    (r) => r.anchor_weight_total + r.reasoning_weight_total === 100,
    { message: "anchor_weight_total + reasoning_weight_total must equal 100" },
  );

export type Rubric = z.infer<typeof RubricSchema>;

// ---------------------------------------------------------------------------
// AnchorFinding — Stage 1 grading output ("did the answer hit anchor X?")
// ---------------------------------------------------------------------------
//
// Lifted verbatim from modules/07-ai-grading/src/types.ts so the score
// helpers in this module can describe their `findings` parameter without
// a circular dependency on 07. 07 re-exports this same schema for its own
// proposal shape via `import { AnchorFindingSchema } from '@assessiq/rubric-engine'`
// (cosmetic — same shape, single source of truth in 08).

export const AnchorFindingSchema = z.object({
  anchor_id: z.string(),
  hit: z.boolean(),
  evidence_quote: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type AnchorFinding = z.infer<typeof AnchorFindingSchema>;
