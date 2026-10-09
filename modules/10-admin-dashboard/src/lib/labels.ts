// One place for every enum -> visible label mapping (RW-13).
// Words follow docs/10-branding-guideline.md section 2.5 (glossary). Pages must
// never render a raw enum value; call one of these functions instead.
// Every function falls back to humanize() for values it does not know.

import type { ChipVariant } from "@assessiq/ui-system";
import type { EvaluationStatus } from "./evaluation.js";

export interface StatusDisplay {
  label: string;
  variant: ChipVariant;
}

export function humanize(slug: string): string {
  if (!slug) return slug;
  const spaced = slug.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function labeler(map: Record<string, string>): (value: string | null | undefined) => string {
  return (value) => (value == null ? "" : (map[value] ?? humanize(value)));
}

function displayer(map: Record<string, StatusDisplay>): (value: string) => StatusDisplay {
  return (value) => map[value] ?? { label: humanize(value), variant: "default" };
}

// Result state shown to the organisation (spec 2026-10-01): AssessIQ grades,
// the organisation reviews and releases.
const EVALUATION_STATUS: Record<EvaluationStatus, StatusDisplay> = {
  awaiting_evaluation: { label: "Awaiting grading", variant: "accent" },
  ready_to_publish:    { label: "Ready to release", variant: "success" },
  published:           { label: "Released",         variant: "default" },
};

export function evaluationStatusDisplay(status: EvaluationStatus): StatusDisplay {
  return EVALUATION_STATUS[status] ?? { label: humanize(status), variant: "default" };
}

export const attemptStatusDisplay = displayer({
  draft:                 { label: "Draft",           variant: "default" },
  in_progress:           { label: "In progress",     variant: "accent" },
  submitted:             { label: "Submitted",       variant: "accent" },
  auto_submitted:        { label: "Auto-submitted",  variant: "warn" },
  cancelled:             { label: "Cancelled",       variant: "default" },
  pending_admin_grading: { label: "Pending grading", variant: "accent" },
  graded:                { label: "Graded",          variant: "success" },
  released:              { label: "Released",        variant: "default" },
});

export const packStatusDisplay = displayer({
  draft:     { label: "Draft",     variant: "accent" },
  published: { label: "Published", variant: "success" },
  archived:  { label: "Archived",  variant: "default" },
});

export const assessmentStatusDisplay = displayer({
  draft:     { label: "Draft",     variant: "accent" },
  published: { label: "Published", variant: "success" },
  active:    { label: "Active",    variant: "success" },
  closed:    { label: "Closed",    variant: "default" },
  cancelled: { label: "Cancelled", variant: "default" },
});

/** Organisation (tenant) status. */
export const organisationStatusDisplay = displayer({
  active:    { label: "Active",    variant: "success" },
  suspended: { label: "Suspended", variant: "warn" },
  archived:  { label: "Archived",  variant: "default" },
});

/** Question status shares the question-set vocabulary. */
export const questionStatusLabel = labeler({ draft: "Draft", published: "Published", archived: "Archived" });

export const questionTypeLabel = labeler({
  mcq: "Multiple choice",
  subjective: "Subjective",
  kql: "KQL",
  scenario: "Scenario",
  log_analysis: "Log analysis",
  numeric: "Numeric",
  multi_select: "Multi-select",
  ordering: "Ordering",
  structured_case: "Structured case",
});

/** Plan tier of an organisation (billing). */
export const planTierLabel = labeler({ free: "Free", pro: "Pro", enterprise: "Enterprise", internal: "Internal" });

/** Certificate tier. */
export const certificateTierLabel = labeler({ completion: "Completion", distinction: "Distinction", honors: "Honours" });

export const audienceLabel = labeler({ admin: "Admin", reviewer: "Reviewer", candidate: "Candidate", all: "Everyone" });

export const roleLabel = labeler({
  super_admin: "Platform admin",
  admin: "Admin",
  reviewer: "Reviewer",
  candidate: "Candidate",
});

/** Background job state (BullMQ). */
export const jobStatusLabel = labeler({
  waiting: "Waiting",
  active: "Running",
  completed: "Completed",
  failed: "Failed",
  delayed: "Delayed",
  paused: "Paused",
});

/** Question-generation attempt state. */
export const generationStatusLabel = labeler({
  success: "Success",
  partial: "Partial",
  failed: "Failed",
  running: "Running",
});

export const cognitiveLevelLabel = labeler({
  remember: "Remember",
  understand: "Understand",
  apply: "Apply",
  analyze: "Analyse",
  evaluate: "Evaluate",
  create: "Create",
});

/** What an entitlement grant covers. */
export const grantScopeLabel = labeler({ domain: "Subject", pack: "Question set" });

/** Difficulty: L1/L2/L3 (or 1/2/3) -> Beginner/Intermediate/Advanced. */
// ponytail: unknown values are authored level names (e.g. "SOC Analyst L1") — show as written, never humanize.
const DIFFICULTY: Record<string, string> = {
  L1: "Beginner", L2: "Intermediate", L3: "Advanced",
  "1": "Beginner", "2": "Intermediate", "3": "Advanced",
};
export function difficultyLabel(value: string | null | undefined): string {
  return value == null ? "" : (DIFFICULTY[value] ?? value);
}

/** Score band: 0/1/2/3/4 -> Band 0/1/2/3/4. */
export function bandLabel(band: number | null | undefined): string {
  return band === null || band === undefined ? "" : `Band ${band}`;
}
