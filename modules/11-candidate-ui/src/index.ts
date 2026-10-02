// Public barrel for @assessiq/candidate-ui.
//
// Phase 1 G1.D ships:
//   - Wire types for /api/me/* + /take/start
//   - Typed fetch client (CandidateApiError, takeStart, list/start/get/save/flag/event/submit/getResult)
//   - Presentation primitives (AttemptTimer, AutosaveIndicator, IntegrityBanner, QuestionNavigator)
//   - Resilience layer (localStorage backup; retry/throttle live in the hooks)
//   - Hooks (useAutosave, useIntegrityHooks, useMultiTabWarning)
//   - Result surface (2026-10-01 scoring/release): ResultSummary, MyResults,
//     listMyResults, wire types for submit/result/results
//
// Page-level routes live in apps/web/src/pages/take/ and import from this barrel.

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  AttemptStatus,
  AttemptWire,
  AttemptAnswerWire,
  FrozenQuestionWire,
  CandidateAttemptViewWire,
  SectionsViewWire,
  InvitedAssessmentWire,
  TakeStartResponseWire,
  TakePreviewResponseWire,
  SubmitAttemptResponseWire,
  AttemptResultPendingWire,
  AttemptResultReleasedWire,
  AttemptResultWire,
  ResultExpectation,
  ReleaseMode,
  ResultCertificateWire,
  MyResultItemWire,
  MyResultsResponseWire,
  CandidateEventType,
  CandidateEventInput,
  ApiErrorEnvelope,
} from "./types";

// ─── API client ───────────────────────────────────────────────────────────────
export {
  CandidateApiError,
  takeStart,
  takePreview,
  listInvitedAssessments,
  startAttempt,
  getAttempt,
  saveAnswer,
  toggleFlag,
  finishSection,
  recordEvent,
  submitAttempt,
  getResult,
  listMyResults,
} from "./api";
export type { SaveAnswerArgs } from "./api";

// ─── Components ───────────────────────────────────────────────────────────────
export {
  AttemptTimer,
  Calculator,
  AutosaveIndicator,
  IntegrityBanner,
  FullscreenGate,
  QuestionNavigator,
  CandidateHelp,
  CompletionModal,
  MyCertificates,
  MyResults,
  ResultSummary,
  CandidateShell,
  CandidateSessionBanner,
  CandidateActivity,
} from "./components";
export type {
  AttemptTimerProps,
  AutosaveIndicatorProps,
  AutosaveStatus,
  IntegrityBannerProps,
  IntegrityBannerKind,
  QuestionNavigatorProps,
  NavigatorItem,
  CandidateHelpProps,
  CompletionModalProps,
  ResultSummaryProps,
  CandidateShellProps,
  CandidateSessionBannerProps,
} from "./components";
export type { MyCertificate, MyCertificatesResponse } from "./api";

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
  IntegrityHooksState,
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
