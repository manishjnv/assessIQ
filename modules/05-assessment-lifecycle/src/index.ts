// AssessIQ — modules/05-assessment-lifecycle public surface.
//
// Three categories of exports:
//   1. Service functions — the public API per modules/05-assessment-lifecycle/SKILL.md
//      § "Public surface". Used by apps/api routes and (eventually) the
//      apps/worker boundary scheduler.
//   2. Boundary advancement — the pure logic apps/worker calls every 60s
//      from a BullMQ repeating job. Apps/worker does not exist yet; this is
//      a forward-declared export so the wiring lands cleanly when it does.
//   3. State-machine primitives — exported for tests and for any future
//      caller that needs to compute legal next-states without touching the
//      service (rare; service.ts is the single chokepoint for state writes).
//   4. Types and error codes — for callers that need to type-check inputs or
//      branch on AL_ERROR_CODES.
//   5. Route registrar — the Fastify plugin that mounts the 11 admin
//      endpoints. Lives co-located with the service so the route auth gates,
//      body shapes, and service contract evolve together.

// ---------------------------------------------------------------------------
// 1. Service functions
// ---------------------------------------------------------------------------

export {
  listAssessments,
  getAssessment,
  createAssessment,
  updateAssessment,
  publishAssessment,
  closeAssessment,
  reopenAssessment,
  inviteUsers,
  listInvitations,
  revokeInvitation,
  previewAssessment,
  resolveInvitationToken,
  markInvitationViewedByToken,
} from "./service.js";
export type { ResolvedInvitation } from "./service.js";

// ---------------------------------------------------------------------------
// 2. Boundary advancement (cron-callable; BullMQ scheduling deferred)
// ---------------------------------------------------------------------------

export { processBoundariesForTenant } from "./boundaries.js";
export type { BoundaryRunResult } from "./boundaries.js";

// ---------------------------------------------------------------------------
// 3. State-machine primitives — pure functions, exported for tests / advanced
//    callers. The service layer is the canonical state-write chokepoint.
// ---------------------------------------------------------------------------

export {
  canTransition,
  assertCanTransition,
  nextStateOnTimeBoundary,
  assertValidWindow,
  assertReopenAllowed,
  ASSESSMENT_STATUSES,
} from "./state-machine.js";
export type { BoundaryRow } from "./state-machine.js";

// ---------------------------------------------------------------------------
// 4. Types, schemas, and error codes
// ---------------------------------------------------------------------------

export {
  AssessmentSettingsSchema,
  AL_ERROR_CODES,
  INVITATION_STATUSES,
} from "./types.js";

export type {
  // status enums
  AssessmentStatus,
  InvitationStatus,
  // domain types
  Assessment,
  AssessmentInvitation,
  AssessmentSettings,
  // service-input types
  ListAssessmentsInput,
  CreateAssessmentInput,
  UpdateAssessmentPatch,
  PaginatedAssessments,
  ListInvitationsInput,
  PaginatedInvitations,
  InviteUsersResult,
  PreviewQuestionSet,
  // error code union
  AlErrorCode,
} from "./types.js";

// ---------------------------------------------------------------------------
// 5. Route registrar
// ---------------------------------------------------------------------------

export { registerAssessmentLifecycleRoutes } from "./routes.js";
export type { RegisterAssessmentLifecycleRoutesOptions } from "./routes.js";
