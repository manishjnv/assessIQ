// AssessIQ — @assessiq/scoring public barrel.
//
// Phase 2 G2.B Session 3. Public surface pinned for 10-admin-dashboard (G2.C).
// Do NOT import from any 07-ai-grading module here — scoring reads the gradings
// table directly via SQL, no runtime dep on @assessiq/ai-grading.

// Types + schemas
export {
  ARCHETYPE_LABELS,
  ArchetypeLabelSchema,
  ArchetypeSignalsSchema,
  AttemptScoreSchema,
  CohortStatsSchema,
  LeaderboardRowSchema,
  IndividualScoreSchema,
  type ArchetypeLabel,
  type ArchetypeSignals,
  type AttemptScore,
  type CohortStats,
  type LeaderboardRow,
  type IndividualScore,
  type CohortPercentiles,
} from "./types.js";

// Archetype helpers (exported for testing + future SKILL.md extension)
export {
  computeSignals,
  deriveArchetype,
  computeLastMinuteFraction,
  type SignalsInput,
  type DeriveArchetypeInput,
} from "./archetype.js";

// Service (public surface pinned for 10-admin-dashboard and 07-ai-grading)
export {
  computeAttemptScore,
  computeAttemptScoreInTx,
  recomputeOnOverride,
  getAttemptScoreRow,
  cohortStats,
  leaderboard,
  individualReport,
} from "./service.js";

// Route registrar
export {
  registerScoringRoutes,
  type RegisterScoringRoutesOptions,
} from "./routes.js";

// Deterministic MCQ scoring (no AI) — called from 06-attempt-engine submit paths
// and the 07-ai-grading admin Grade handler.
export {
  scoreMcqForAttempt,
  scoreMcqAndFinalizeIfComplete,
  scoreMcqAndFinalizeSafely,
  isMcqAnswerCorrect,
  MCQ_SENTINEL_SHA,
} from "./mcq.js";

// One shared finalize (SP1): the single definition of "complete" and the only
// place (besides tests) that flips an attempt to 'graded' and bills it.
export {
  finalizeAttemptIfComplete,
  type FinalizeAttemptInput,
} from "./finalize.js";

// One shared release (SP2): the only place a finished result is published to the
// candidate. Called inside the caller's withTenant tx; emails are sent AFTER commit.
export {
  releaseAttemptInTx,
  RELEASE_ERROR_CODES,
  type ReleaseActor,
  type ReleaseAttemptInput,
} from "./release.js";
