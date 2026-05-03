// AssessIQ — modules/07-ai-grading runtime dispatch (D1).
//
// Single static switch on `config.AI_PIPELINE_MODE`. Phase 2 G2.A Session 1.a
// ships only the dispatch shell — the three runtime files (claude-code-vps,
// anthropic-api, open-weights) ship as `NotImplementedError` stubs in this
// session, with real claude-code-vps wiring landing in Session 1.b.
//
// IMPORTANT — D1 invariant:
//   This is the ONLY place that decides which runtime executes. There is
//   no string-based dispatch, no dynamic `import()`, no plugin loader.
//   Mode is read once at process start; changing it is a deploy event,
//   never a runtime toggle.
//
// IMPORTANT — D2 invariant:
//   This file imports from `runtimes/*` files. Those imports are the
//   D2 lint allow-list seam — a banned-path file (cron, BullMQ worker,
//   candidate route) that imports `gradeSubjective` from this package
//   transitively pulls in the runtime references and the lint catches
//   it. See modules/07-ai-grading/ci/lint-no-ambient-claude.ts.
//
// IMPORTANT — Session 1.b/2+ author warning (eager-import startup hazard):
//   The three runtime modules are imported eagerly here (lines below).
//   Session 1.a stubs have zero module-level side effects, so eager
//   loading is safe. When the anthropic-api runtime ships the real
//   Agent SDK import at module top-level, eager loading WILL crash
//   startup in claude-code-vps mode with MODULE_NOT_FOUND because the
//   SDK is intentionally absent in Phase 1 (D1 defense-in-depth).
//   Fix at that point by EITHER (a) converting these to dynamic
//   import() inside each case branch so only the active runtime loads,
//   OR (b) declaring the Agent SDK as optionalDependencies in
//   modules/07-ai-grading/package.json and wrapping its top-level
//   import in a try/catch inside the anthropic-api runtime file.

import { AppError } from "@assessiq/core";
import { config } from "@assessiq/core";
import { gradeSubjective as gradeViaClaudeCodeVps } from "./runtimes/claude-code-vps.js";
import { gradeSubjective as gradeViaAnthropicApi } from "./runtimes/anthropic-api.js";
import { gradeSubjective as gradeViaOpenWeights } from "./runtimes/open-weights.js";
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
    case "claude-code-vps":
      return gradeViaClaudeCodeVps(input);
    case "anthropic-api":
      return gradeViaAnthropicApi(input);
    default: {
      // exhaustiveness: if D1 adds 'open-weights' to the enum, this branch
      // routes there. The current 00-core/src/config.ts enum permits only
      // claude-code-vps + anthropic-api today; open-weights is future.
      // The cast preserves narrow typing on a runtime-string fallthrough.
      const mode = config.AI_PIPELINE_MODE as string;
      if (mode === "open-weights") {
        return gradeViaOpenWeights(input);
      }
      throw new AppError(
        `Unknown AI_PIPELINE_MODE: ${mode}`,
        AI_GRADING_ERROR_CODES.RUNTIME_NOT_IMPLEMENTED,
        500,
      );
    }
  }
}
