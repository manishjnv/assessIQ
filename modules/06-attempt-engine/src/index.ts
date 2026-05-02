// AssessIQ — modules/06-attempt-engine public surface.
//
// Five categories of exports:
//   1. Service functions — the candidate-side public API per the SKILL.md.
//      Used by apps/api routes and (eventually) the apps/worker timer sweep.
//   2. Sweeper — pure logic the BullMQ repeating job will call. Apps/worker
//      does not exist yet; this is forward-declared so the wiring lands
//      cleanly when it does (mirrors module 05's processBoundariesForTenant).
//   3. Rate-cap helpers — for tests + the candidate UI's pre-emptive throttle.
//   4. Types and error codes — for callers that need to type-check inputs or
//      branch on AE_ERROR_CODES.
//   5. Route registrar — the candidate-side Fastify plugin.

// ---------------------------------------------------------------------------
// 1. Service functions
// ---------------------------------------------------------------------------

export {
  startAttempt,
  getAttemptForCandidate,
  saveAnswer,
  toggleFlag,
  recordEvent,
  submitAttempt,
  listAnswersForAttempt,
} from "./service.js";

// ---------------------------------------------------------------------------
// 2. Sweeper (cron-callable; BullMQ scheduling deferred)
// ---------------------------------------------------------------------------

export { sweepStaleTimersForTenant } from "./service.js";
export type { SweepResult } from "./service.js";

// ---------------------------------------------------------------------------
// 3. Rate-cap helpers
// ---------------------------------------------------------------------------

export {
  tryAdmitEvent,
  pruneIdleBuckets,
  RATE_CAP_CONSTANTS,
} from "./rate-cap.js";

// ---------------------------------------------------------------------------
// 4. Types and error codes
// ---------------------------------------------------------------------------

export {
  AE_ERROR_CODES,
  ATTEMPT_STATUSES,
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_EVENT_TYPES,
  TERMINAL_ATTEMPT_STATUSES,
  WRITABLE_ATTEMPT_STATUSES,
} from "./types.js";

export type {
  AeErrorCode,
  Attempt,
  AttemptAnswer,
  AttemptEvent,
  AttemptQuestion,
  AttemptStatus,
  CandidateAttemptView,
  EventType,
  FrozenQuestion,
  RecordEventInput,
  SaveAnswerInput,
  StartAttemptInput,
  ToggleFlagInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// 5. Route registrars
// ---------------------------------------------------------------------------

export { registerAttemptCandidateRoutes } from "./routes.candidate.js";
export type { RegisterAttemptCandidateRoutesOptions } from "./routes.candidate.js";

export { registerAttemptTakeRoutes } from "./routes.take.js";
export type { RegisterAttemptTakeRoutesOptions } from "./routes.take.js";
