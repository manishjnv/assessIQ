// AssessIQ — Phase 1 runtime: Claude Code CLI on the VPS.
//
// Phase 2 G2.A Session 1.a ships the STUB only. The real runtime —
// `runClaudeCodeGrading` spawning `claude -p ...`, parsing the
// stream-json events, extracting `submit_anchors` + `submit_band` tool
// inputs, computing the proposal — lands in Session 1.b under
// codex:rescue (this file is on the D2 lint allow-list and load-bearing
// per CLAUDE.md).
//
// IMPORTANT (D2): This is one of the TWO files allowed to spawn `claude`.
// The other is modules/07-ai-grading/handlers/admin-grade.ts. The lint at
// modules/07-ai-grading/ci/lint-no-ambient-claude.ts enforces this.
//
// IMPORTANT (D8 — compliance frame): the runtime MUST be called only on a
// fresh admin click, with admin session active within 60s, and the result
// MUST be a *proposal* the admin reviews before the gradings row is
// written. Phase 1 is admin-in-the-loop; never auto-accept.

import { AppError } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "../types.js";
import type { GradingInput, GradingProposal } from "../types.js";

export async function gradeSubjective(
  _input: GradingInput,
): Promise<GradingProposal> {
  // Session 1.a: stub. Session 1.b ships the real implementation per
  // docs/05-ai-pipeline.md § "Implementation skeleton — Phase 1".
  throw new AppError(
    "Phase 2 G2.A Session 1.a: claude-code-vps runtime not yet implemented; " +
      "the lint sentinel + migrations + module skeleton ship first. " +
      "See docs/plans/PHASE_2_KICKOFF.md G2.A Session 1.",
    AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
    503,
  );
}

/**
 * Public alias — `runClaudeCodeGrading` is the symbol named in D2's
 * allow-list contract. The lint sentinel matches on this name AND on
 * the file path; both conditions narrow the import surface.
 */
export const runClaudeCodeGrading = gradeSubjective;
