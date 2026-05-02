// Public barrel for @assessiq/candidate-ui.
//
// Phase 1 G1.D ships:
//   - Wire types for /api/me/* + /take/start
//   - Typed fetch client (CandidateApiError, takeStart, list/start/get/save/flag/event/submit/getResult)
//   - Presentation primitives (AttemptTimer, AutosaveIndicator, IntegrityBanner, QuestionNavigator)
//   - Resilience layer (localStorage backup; retry/throttle live in the hooks)
//   - Hooks (useAutosave, useIntegrityHooks, useMultiTabWarning)
//
// Page-level routes live in apps/web/src/pages/take/ and import from this barrel.

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  AttemptStatus,
  AttemptWire,
  AttemptAnswerWire,
  FrozenQuestionWire,
  CandidateAttemptViewWire,
  InvitedAssessmentWire,
  TakeStartResponseWire,
  SubmitAttemptResponseWire,
  AttemptResultPendingWire,
  CandidateEventType,
  CandidateEventInput,
  ApiErrorEnvelope,
} from "./types";

// ─── API client ───────────────────────────────────────────────────────────────
export {
  CandidateApiError,
  takeStart,
  listInvitedAssessments,
  startAttempt,
  getAttempt,
  saveAnswer,
  toggleFlag,
  recordEvent,
  submitAttempt,
  getResult,
} from "./api";
export type { SaveAnswerArgs } from "./api";

// ─── Components ───────────────────────────────────────────────────────────────
export {
  AttemptTimer,
  AutosaveIndicator,
  IntegrityBanner,
  QuestionNavigator,
} from "./components";
export type {
  AttemptTimerProps,
  AutosaveIndicatorProps,
  AutosaveStatus,
  IntegrityBannerProps,
  IntegrityBannerKind,
  QuestionNavigatorProps,
  NavigatorItem,
} from "./components";

// ─── Hooks ────────────────────────────────────────────────────────────────────
export {
  useAutosave,
  useIntegrityHooks,
  useMultiTabWarning,
} from "./hooks";
export type {
  UseAutosaveArgs,
  UseAutosaveResult,
  UseIntegrityHooksArgs,
  UseMultiTabWarningArgs,
  UseMultiTabWarningResult,
} from "./hooks";

// ─── Resilience ───────────────────────────────────────────────────────────────
export {
  readBackup,
  writeBackup,
  clearBackup,
} from "./resilience/localStorage-backup";
export type { BackupEnvelope } from "./resilience/localStorage-backup";
