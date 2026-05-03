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
