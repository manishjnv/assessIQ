// AssessIQ — Future runtime: open-weights (on-prem Llama / Mistral / etc.)
//
// Phase 2 G2.A Session 1.a ships the STUB only. The real runtime — local
// OpenAI-compatible endpoint URL via separate env vars, no Anthropic SDK
// involvement — lands when a tenant requires on-prem inference.
//
// Reserved seam: this file's existence is part of D1's three-runtime
// contract. Deleting it would silently shrink the dispatch surface.

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput, GradingProposal } from "../types.js";

export async function gradeSubjective(
  _input: GradingInput,
): Promise<GradingProposal> {
  throw new AppError(
    "Future: open-weights runtime is designed but not yet shipped.",
    AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
    503,
  );
}
