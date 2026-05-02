// AssessIQ — modules/05-assessment-lifecycle state machine.
//
// PURE FUNCTIONS ONLY. No I/O, no DB, no time. Time-dependent decisions take
// `now: Date` as a parameter so tests can pin the clock — there is no
// `Date.now()` reference anywhere in this file.
//
// This is the trap surface for module 05. The KICKOFF DoD (`docs/plans/
// PHASE_1_KICKOFF.md` § Session 3 § DoD) recommends invoking codex:rescue on
// state-machine + boundary-cron specifically — state corruption is the
// nastiest class of bug because it's silent and asymmetric (a closed
// assessment that bounces back to draft loses invitations + attempts).
//
// The machine encodes:
//
//          create
//        draft ────────▶ published ────▶ active ────▶ closed
//           ▲              │  ▲             │            │
//           │              ▼  │             │            │
//           │        cancelled│             │            │
//           │                  └─reopen     │            │
//           └──unpublish (if no invitations)             │
//                                                        ▼
//                                                   (terminal)
//
// Service-layer wiring:
//   * publishAssessment    → enforces canTransition('draft','published')
//   * closeAssessment      → enforces canTransition('active','closed')
//   * reopenAssessment     → enforces canTransition('closed','published')
//                            AND a time check: now < closes_at
//   * unpublishAssessment  → enforces canTransition('published','draft')
//                            AND a no-invitations precondition (service-side)
//   * cancelAssessment     → not in v1 surface (out of Phase 1 scope per
//                            modules/05-assessment-lifecycle/SKILL.md), but
//                            the machine recognises the edge so the boundary
//                            cron can never accidentally arrive at it.
//   * boundary cron        → invokes nextStateOnTimeBoundary() per row;
//                            applies the returned state via canTransition.
//
// CONFIDENTIALITY GUARANTEE: every illegal transition produces a typed
// ValidationError (AppError-derived) with details.code === INVALID_STATE_TRANSITION.
// Callers that try `closeAssessment` on a `draft` assessment get a 422 — they
// never see the row update silently dropped, and the audit log captures the
// rejection.

import { ValidationError } from "@assessiq/core";
import {
  ASSESSMENT_STATUSES,
  type AssessmentStatus,
  AL_ERROR_CODES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Static transition table
// ---------------------------------------------------------------------------
//
// `LEGAL_TRANSITIONS[from]` is the complete set of states reachable from
// `from`. A transition is legal IFF `to` is in that set. Self-transitions
// (e.g. draft → draft) are NOT legal — the service layer treats a no-op
// status update as a no-op, not a transition.
//
// Why a static table rather than a switch: exhaustiveness is checked by
// `satisfies Record<AssessmentStatus, ReadonlySet<AssessmentStatus>>`. Adding
// a new status to ASSESSMENT_STATUSES without updating this table is a
// compile error. Switch statements would silently fall through.

const LEGAL_TRANSITIONS = {
  draft: new Set<AssessmentStatus>(["published", "cancelled"]),
  published: new Set<AssessmentStatus>(["draft", "active", "cancelled"]),
  active: new Set<AssessmentStatus>(["closed"]),
  closed: new Set<AssessmentStatus>(["published"]),  // reopen edge
  cancelled: new Set<AssessmentStatus>(),            // terminal
} as const satisfies Record<AssessmentStatus, ReadonlySet<AssessmentStatus>>;

// ---------------------------------------------------------------------------
// canTransition — pure boolean check
// ---------------------------------------------------------------------------

export function canTransition(
  from: AssessmentStatus,
  to: AssessmentStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

// ---------------------------------------------------------------------------
// assertCanTransition — throw a typed ValidationError on illegal transition
// ---------------------------------------------------------------------------
//
// Service-layer use. Throws ValidationError so the global Fastify error
// handler maps to a 422 envelope with the structured details payload.
// Callers that need a different status code should catch + re-throw their
// own AppError-derived exception with the appropriate domain code.

export function assertCanTransition(
  from: AssessmentStatus,
  to: AssessmentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ValidationError(
      `Illegal state transition: ${from} → ${to}`,
      {
        details: {
          code: AL_ERROR_CODES.INVALID_STATE_TRANSITION,
          from,
          to,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// nextStateOnTimeBoundary — boundary-cron decision function
// ---------------------------------------------------------------------------
//
// Given the current time and an assessment's lifecycle-relevant fields,
// return the state the assessment SHOULD be in. The boundary cron applies
// this to every published+active row every 60s.
//
// Rules (in priority order):
//   1. If status='published' and opens_at is set and now >= opens_at → 'active'.
//      (Boundary fires the moment the window opens.)
//   2. If status='active' and closes_at is set and now >= closes_at → 'closed'.
//      (Boundary fires the moment the window closes.)
//   3. If status='published' and BOTH opens_at and closes_at have already
//      passed (admin set a window entirely in the past, e.g. backfilling) →
//      'closed'. Skipping 'active' is correct — the candidate window never
//      materialised in real time.
//   4. Otherwise → unchanged.
//
// Idempotency: calling this function twice with the same inputs returns the
// same result. The boundary cron's bulk UPDATE is safe to retry.
//
// Time-traveling assessments: the function makes NO attempt to "rewind" a
// closed assessment to active or published if the admin pushes closes_at
// further into the future. Reopening is an explicit admin action via
// reopenAssessment(); the cron only moves states forward in lifecycle order.

export interface BoundaryRow {
  status: AssessmentStatus;
  opens_at: Date | null;
  closes_at: Date | null;
}

export function nextStateOnTimeBoundary(
  now: Date,
  row: BoundaryRow,
): AssessmentStatus {
  const { status, opens_at, closes_at } = row;

  // Case 1 + 3: published assessments
  if (status === "published") {
    // Both bounds in the past → skip straight to closed.
    if (
      opens_at !== null &&
      closes_at !== null &&
      now.getTime() >= closes_at.getTime() &&
      now.getTime() >= opens_at.getTime()
    ) {
      return "closed";
    }
    // Open window has arrived → transition to active.
    if (opens_at !== null && now.getTime() >= opens_at.getTime()) {
      return "active";
    }
  }

  // Case 2: active assessments past their closes_at → closed.
  if (status === "active") {
    if (closes_at !== null && now.getTime() >= closes_at.getTime()) {
      return "closed";
    }
  }

  // Otherwise unchanged. (draft / closed / cancelled never advance via cron.)
  return status;
}

// ---------------------------------------------------------------------------
// Helpers used elsewhere — kept here so the state-machine surface is the
// single source of truth for "is this valid".
// ---------------------------------------------------------------------------

/**
 * Strict window validation. The DB has a CHECK constraint
 * `opens_at < closes_at` when both are set; this surfaces it at the service
 * layer with a typed error before the INSERT/UPDATE round-trips to Postgres.
 */
export function assertValidWindow(
  opens_at: Date | null,
  closes_at: Date | null,
): void {
  if (
    opens_at !== null &&
    closes_at !== null &&
    opens_at.getTime() >= closes_at.getTime()
  ) {
    throw new ValidationError(
      `opens_at (${opens_at.toISOString()}) must be strictly before closes_at (${closes_at.toISOString()})`,
      {
        details: {
          code: AL_ERROR_CODES.WINDOW_INVALID,
          opens_at: opens_at.toISOString(),
          closes_at: closes_at.toISOString(),
        },
      },
    );
  }
}

/**
 * reopenAssessment requires that the closes_at, if set, has not yet passed.
 * If closes_at is NULL the reopen is allowed (no time-bound deadline).
 *
 * Time-windowing intent: reopen is the admin-initiated counter to a closed
 * assessment that was closed prematurely (or by the boundary cron) but the
 * window itself is still open. After closes_at passes, reopening would
 * immediately re-close — pointless and confusing.
 */
export function assertReopenAllowed(
  now: Date,
  closes_at: Date | null,
): void {
  if (closes_at !== null && now.getTime() >= closes_at.getTime()) {
    throw new ValidationError(
      `Cannot reopen an assessment past its closes_at (${closes_at.toISOString()})`,
      {
        details: {
          code: AL_ERROR_CODES.REOPEN_PAST_CLOSES_AT,
          now: now.toISOString(),
          closes_at: closes_at.toISOString(),
        },
      },
    );
  }
}

// Re-export for tests that want to iterate over the full enum without
// importing types.ts directly.
export { ASSESSMENT_STATUSES };
