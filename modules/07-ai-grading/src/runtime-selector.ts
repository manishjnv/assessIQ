// AssessIQ — modules/07-ai-grading runtime dispatch (D1).
//
// Single static switch on `config.AI_PIPELINE_MODE`. Runtime modules are
// loaded via dynamic `import()` per case branch so only the active runtime's
// module-level imports are evaluated at startup — Phase 1 (claude-code-vps)
// never touches the Phase-2+ Agent SDK runtime, so a missing SDK in the
// production image cannot crash boot. R2 hazard from Session 1.a is now
// resolved.
//
// IMPORTANT — D1 invariant:
//   This is the ONLY place that decides which runtime executes. There is
//   no string-based dispatch, no plugin loader. Mode is read once at
//   process start; changing it is a deploy event, never a runtime toggle.
//
// IMPORTANT — D2 invariant:
//   Banned-path files (cron, BullMQ workers, candidate routes, webhooks,
//   apps/worker entrypoints) that import `gradeSubjective` from this
//   package transitively reach the runtime files via these dynamic
//   imports. The lint at modules/07-ai-grading/ci/lint-no-ambient-claude.ts
//   matches against banned paths importing the package barrel; the dynamic
//   import here does NOT save such a banned-path file from being flagged.
//   The static-source enforcement is the load-bearing gate.

import { AppError, config } from "@assessiq/core";
import { AI_GRADING_ERROR_CODES } from "./types.js";
import type { GradingInput, GradingProposal } from "./types.js";

/**
 * Mode-agnostic core. Delegates to the active runtime per D1.
 *
 * Callers (handlers/admin-grade.ts) MUST verify admin session + heartbeat
 * + single-flight mutex BEFORE calling this function. The runtime itself
 * is intentionally credential-/mode-aware only — it does not duplicate
 * the route-layer auth checks.
 */
export async function gradeSubjective(
  input: GradingInput,
): Promise<GradingProposal> {
  switch (config.AI_PIPELINE_MODE) {
    case "claude-code-vps": {
      const m = await import("./runtimes/claude-code-vps.js");
      return m.gradeSubjective(input);
    }
    case "anthropic-api": {
      const m = await import("./runtimes/anthropic-api.js");
      return m.gradeSubjective(input);
    }
    case "open-weights": {
      const m = await import("./runtimes/open-weights.js");
      return m.gradeSubjective(input);
    }
    default: {
      const mode = config.AI_PIPELINE_MODE as string;
      throw new AppError(
        `Unknown AI_PIPELINE_MODE: ${mode}`,
        AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
        500,
      );
    }
  }
}
