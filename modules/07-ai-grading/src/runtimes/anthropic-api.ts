// AssessIQ — Phase 2+ runtime: Anthropic API via @anthropic-ai/claude-agent-sdk.
//
// Phase 2 G2.A Session 1.a ships the STUB only. The real runtime — Agent
// SDK wiring + tool-use enforcement + budget gate — lands when the user
// flips `AI_PIPELINE_MODE=anthropic-api`. That deploy is gated by:
//   - D6 budget enforcement (modules/07-ai-grading reads tenant_grading_budgets
//     before each call)
//   - codex:rescue at first ship (CLAUDE.md AssessIQ rule #2)
//   - Eval harness re-baselining (D5)
//
// IMPORTANT (D2 / CLAUDE.md rule #2):
//   This is the ONLY file allowed to import `@anthropic-ai/claude-agent-sdk`.
//   The lint at modules/07-ai-grading/ci/lint-no-ambient-claude.ts enforces.
//   The actual SDK import line will land with the real implementation —
//   for now the stub keeps the file's existence so the allow-list slot
//   stays reserved (deleting this file would break the contract reservation).
//
// Phase 1 invariant: callers reach this file ONLY when
// AI_PIPELINE_MODE=anthropic-api. The default (claude-code-vps) never
// loads this code path through runtime-selector.ts's switch statement.

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput, GradingProposal } from "../types.js";

export async function gradeSubjective(
  _input: GradingInput,
): Promise<GradingProposal> {
  throw new AppError(
    "Phase 3+: anthropic-api runtime is designed but not yet shipped. " +
      "See docs/05-ai-pipeline.md § Decisions captured § D1 + D6.",
    AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
    503,
  );
}
