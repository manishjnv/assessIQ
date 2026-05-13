// AssessIQ — @assessiq/admin-dashboard barrel.
//
// Phase 2 G2.C. Exports all pages and domain composites consumed by apps/web.
// apps/web imports pages by name and wires them into the router.

// ── Domain composites ──────────────────────────────────────────────────────
export { AnchorChip } from "./components/AnchorChip.js";
export type { AnchorChipProps } from "./components/AnchorChip.js";

export { ArchetypeRadar } from "./components/ArchetypeRadar.js";
export type { ArchetypeRadarProps } from "./components/ArchetypeRadar.js";

export { BandPicker } from "./components/BandPicker.js";
export type { BandPickerProps } from "./components/BandPicker.js";

export { EscalationDiff } from "./components/EscalationDiff.js";
export type { EscalationDiffProps } from "./components/EscalationDiff.js";

export { GradingProposalCard } from "./components/GradingProposalCard.js";
export type { GradingProposalCardProps } from "./components/GradingProposalCard.js";

export { RubricEditor } from "./components/RubricEditor.js";
export type { RubricEditorProps, RubricDraft, AnchorDraft, BandDraft } from "./components/RubricEditor.js";

export { ScoreDetail } from "./components/ScoreDetail.js";
export type { ScoreDetailProps } from "./components/ScoreDetail.js";

// AdminShell is used internally — exported for custom embedding if needed.
export { AdminShell } from "./components/AdminShell.js";
export type { AdminShellProps } from "./components/AdminShell.js";

export { QuestionContentView } from "./components/QuestionContentView.js";
export type { QuestionContentViewProps } from "./components/QuestionContentView.js";

// ── Pages ──────────────────────────────────────────────────────────────────
export { AdminDashboard } from "./pages/dashboard.js";
export { AdminAttempts } from "./pages/attempts.js";
export { AdminAttemptDetail } from "./pages/attempt-detail.js";
export { AdminGradingJobs } from "./pages/grading-jobs.js";
export { AdminCohortReport } from "./pages/cohort-report.js";
export { AdminIndividualReport } from "./pages/individual-report.js";
export { AdminQuestionEditor } from "./pages/question-editor.js";
export { AdminBilling } from "./pages/billing.js";
export { AdminHelpContent } from "./pages/help-content.js";
export { AdminGuide } from "./pages/admin-guide.js";
export { AdminQuestionBank } from "./pages/question-bank.js";
export { AdminPackDetail } from "./pages/pack-detail.js";
export { AdminAssessments } from "./pages/assessments.js";
export { AdminAssessmentDetail } from "./pages/assessment-detail.js";
export { AdminReports } from "./pages/reports.js";
export { AdminGenerationAttempts } from "./pages/generation-attempts.js";
export { AdminCertificates } from "./pages/certificates.js";
export { AdminActivity } from "./pages/activity.js";
export { domainLabel, DOMAIN_LABELS } from "./lib/domains.js";
