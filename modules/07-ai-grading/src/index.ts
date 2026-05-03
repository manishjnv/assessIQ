// AssessIQ — modules/07-ai-grading public surface.
//
// Session 1.a shipped:
//   1. Lint sentinel ci/lint-no-ambient-claude.ts (load-bearing).
//   2. Migrations 0040 (gradings) + 0041 (tenant_grading_budgets).
//   3. Type contracts + error codes.
//   4. Runtime-selector dispatch shell + three runtime stubs.
//
// Session 1.b ships (this session):
//   5. Repository layer (gradings + tenant_grading_budgets queries).
//   6. Single-flight mutex (D7).
//   7. 9 service-layer handlers: admin-grade, admin-accept, admin-override,
//      admin-rerun, admin-queue, admin-claim-release, admin-grading-jobs,
//      admin-budget.
//
// Session 1.c (next): real claude-code-vps runtime (claude -p spawn,
//   stream-json parsing, skill-sha pinning) + Fastify routes + eval harness.
//
// codex:rescue is mandatory before push per CLAUDE.md § Load-bearing paths.

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

// Runtime dispatch (D1 — single static switch)
export { gradeSubjective } from "./runtime-selector.js";

// Repository (Session 1.b)
export type { InsertGradingInput, QueueRow } from "./repository.js";
export {
  findGradingById,
  findGradingsForAttempt,
  findGradingByIdempotencyKey,
  insertGrading,
  findTenantBudget,
  listGradingQueue,
} from "./repository.js";

// Single-flight mutex (D7, Session 1.b)
export { singleFlight } from "./single-flight.js";

// Service-layer handlers (Session 1.b)
export type {
  HandleAdminGradeInput,
  HandleAdminGradeOutput,
} from "./handlers/admin-grade.js";
export { handleAdminGrade } from "./handlers/admin-grade.js";

export type {
  AcceptEdits,
  HandleAdminAcceptInput,
  HandleAdminAcceptOutput,
} from "./handlers/admin-accept.js";
export { handleAdminAccept } from "./handlers/admin-accept.js";

export type {
  HandleAdminOverrideInput,
  HandleAdminOverrideOutput,
} from "./handlers/admin-override.js";
export { handleAdminOverride } from "./handlers/admin-override.js";

export type {
  HandleAdminRerunInput,
  HandleAdminRerunOutput,
} from "./handlers/admin-rerun.js";
export { handleAdminRerun } from "./handlers/admin-rerun.js";

export type {
  HandleAdminQueueInput,
  HandleAdminQueueOutput,
} from "./handlers/admin-queue.js";
export { handleAdminQueue } from "./handlers/admin-queue.js";

export type {
  AttemptAnswerRow,
  FrozenQuestionRow,
  HandleAdminClaimAttemptOutput,
  HandleAdminReleaseAttemptOutput,
} from "./handlers/admin-claim-release.js";
export {
  handleAdminClaimAttempt,
  handleAdminReleaseAttempt,
} from "./handlers/admin-claim-release.js";

export type {
  HandleAdminListGradingJobsInput,
  HandleAdminListGradingJobsOutput,
  HandleAdminRetryGradingJobInput,
} from "./handlers/admin-grading-jobs.js";
export {
  handleAdminListGradingJobs,
  handleAdminRetryGradingJob,
} from "./handlers/admin-grading-jobs.js";

export type { HandleAdminBudgetOutput } from "./handlers/admin-budget.js";
export { handleAdminBudget } from "./handlers/admin-budget.js";

// Fastify route registrar — Session 1.c (routes sonnet's scope)
export { registerGradingRoutes } from "./routes.js";
export type { RegisterGradingRoutesOptions } from "./routes.js";
