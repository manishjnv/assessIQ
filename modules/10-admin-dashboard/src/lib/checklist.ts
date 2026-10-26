// AssessIQ — "Run an assessment" checklist logic (Z-24).
//
// Pure functions only, no fetching. The card calls the existing endpoints and
// passes the numbers here. Tick rules (one per step):
//  1. Create or pick: an assessment exists.
//  2. Add candidates: the assessment has at least one invitation row.
//  3. Send invitations: at least one candidate opened an invitation
//     (viewed, started or submitted). The invite call sends the email, so
//     "sent" is judged by the first candidate action, not by the send itself.
//  4. Watch attempts: at least one attempt exists for the assessment.
//  5. Grade and review: at least one attempt is graded or released and none
//     is still awaiting grading.
//  6. Release results: at least one attempt is released.

export interface ChecklistInvitationCounts {
  total: number;
  viewed: number;
  started: number;
  submitted: number;
}

export interface ChecklistAttemptCounts {
  /** All attempts for the assessment. */
  all: number;
  /** Attempts waiting for grading (submitted, auto_submitted, pending_admin_grading). */
  awaiting: number;
  /** Attempts graded or released. */
  gradedOrLater: number;
  /** Attempts released to candidates. */
  released: number;
}

export type ChecklistStepId =
  | "assessment"
  | "candidates"
  | "invitations"
  | "attempts"
  | "grading"
  | "release";

export interface ChecklistStep {
  id: ChecklistStepId;
  done: boolean;
}

/** Counts the server returns for each step. `null` = no assessment yet. */
export interface ChecklistInput {
  assessmentId: string | null;
  invitations?: Partial<ChecklistInvitationCounts>;
  attempts?: Partial<ChecklistAttemptCounts>;
}

export const ATTEMPT_AWAITING_STATUSES = "submitted,auto_submitted,pending_admin_grading";

const ZERO_INVITATIONS: ChecklistInvitationCounts = { total: 0, viewed: 0, started: 0, submitted: 0 };
const ZERO_ATTEMPTS: ChecklistAttemptCounts = { all: 0, awaiting: 0, gradedOrLater: 0, released: 0 };

/** Reads a count that may be missing from an older response. Never negative, never NaN. */
export function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Turns raw counts (possibly partial) into six ticks. Pure. */
export function buildChecklistSteps(input: ChecklistInput): ChecklistStep[] {
  const inv = { ...ZERO_INVITATIONS, ...input.invitations };
  const att = { ...ZERO_ATTEMPTS, ...input.attempts };
  const hasAssessment = input.assessmentId !== null;
  return [
    { id: "assessment", done: hasAssessment },
    { id: "candidates", done: hasAssessment && inv.total > 0 },
    {
      id: "invitations",
      done: hasAssessment && inv.viewed + inv.started + inv.submitted > 0,
    },
    { id: "attempts", done: hasAssessment && att.all > 0 },
    { id: "grading", done: hasAssessment && att.gradedOrLater > 0 && att.awaiting === 0 },
    { id: "release", done: hasAssessment && att.released > 0 },
  ];
}

export function allStepsDone(steps: ChecklistStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/** Link target for each step. Without an assessment, the steps point to the list or Start a test. */
export function stepHref(id: ChecklistStepId, assessmentId: string | null): string {
  if (assessmentId === null) {
    return id === "assessment" ? "/admin/create-test" : "/admin/assessments";
  }
  switch (id) {
    case "assessment":
      return "/admin/assessments";
    case "candidates":
    case "invitations":
    case "release":
      return `/admin/assessments/${encodeURIComponent(assessmentId)}`;
    case "attempts":
    case "grading":
      return `/admin/attempts?assessmentId=${encodeURIComponent(assessmentId)}`;
  }
}
