// AssessIQ — @assessiq/rubric-engine public barrel.
//
// Phase 2 G2.B Session 2. Service-only module — no Fastify routes, no
// migrations, no DB access. Pure schemas + pure functions.

export {
  AnchorSchema,
  RubricSchema,
  AnchorFindingSchema,
  type Anchor,
  type Rubric,
  type AnchorFinding,
} from "./types.js";

export { validateRubric } from "./validate.js";

export {
  sumAnchorScore,
  computeReasoningScore,
  finalScore,
} from "./score.js";
