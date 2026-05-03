// AssessIQ — modules/07-ai-grading public surface (Phase 2 G2.A Session 1.a).
//
// Session 1.a ships:
//   1. The lint sentinel at ci/lint-no-ambient-claude.ts (load-bearing).
//   2. Migrations 0040 (gradings) + 0041 (tenant_grading_budgets).
//   3. Type contracts (GradingProposal, AnchorFinding, BandFinding,
//      GradingsRow, GradingInput, SkillVersion, TenantGradingBudget).
//   4. Error code constants (AI_GRADING_ERROR_CODES).
//   5. The runtime-selector dispatch shell + three runtime stubs.
//
// Session 1.b (next): the real claude-code-vps runtime (claude -p spawn,
//   stream-json parsing, tool-use extraction, skill-sha pinning).
// Session 1.c (after): admin handlers (grade / accept / override / rerun /
//   queue / claim / release / grading-jobs / budget) + Fastify routes +
//   eval harness skeleton + in-repo skills + MCP server source.
//
// codex:rescue is mandatory before push for THIS session's commit per
// CLAUDE.md § Load-bearing paths — modules/07-ai-grading/** is on the
// list, and the lint sentinel itself is explicitly load-bearing-with-
// rescue-gate.

// Type contracts (re-exported for module 09, module 10, apps/api)
export {
  AI_GRADING_ERROR_CODES,
  AnchorFindingSchema,
  BandFindingSchema,
  GradingProposalSchema,
} from "./types.js";

export type {
  AiGradingErrorCode,
  AnchorFinding,
  BandFinding,
  GradingInput,
  GradingProposal,
  GradingsRow,
  SkillVersion,
  TenantGradingBudget,
} from "./types.js";

// Runtime dispatch (Session 1.b will ship the real claude-code-vps body)
export { gradeSubjective } from "./runtime-selector.js";
