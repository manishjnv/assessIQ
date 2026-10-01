// Shared types + pure helpers for the evaluation flow: the super-admin queue /
// evaluate pages and the tenant review page (attempt-detail) all read the same
// attempt payload and apply the same rules.

import type { GradingProposal, GradingsRow } from "@assessiq/ai-grading";
import { AdminApiError } from "../api.js";

// ---------------------------------------------------------------------------
// Wire types (GET /admin/attempts/:id and GET /admin/super/evaluations/:id)
// ---------------------------------------------------------------------------

export type EvaluationStatus = "awaiting_evaluation" | "ready_to_publish" | "published";

/** Evaluation fields added by the scoring/release change (spec §5b). */
export interface EvaluationMeta {
  /** Tenant GET only. */
  evaluation_status?: EvaluationStatus;
  /** Super-admin GET only. */
  tenant_id?: string;
  tenant_name?: string;
  evaluation_released_at?: string | null;
  evaluation_note?: string | null;
  evaluation_sent_back_at?: string | null;
}

export interface AttemptAnswer {
  question_id: string;
  answer: unknown;
  edits_count?: number;
}

/**
 * Rubric shape carried per frozen question. Only the fields the review UI needs
 * are typed; the full RubricSchema lives in `@assessiq/rubric-engine`.
 */
export interface RubricForReview {
  anchors?: Array<{
    id: string;
    concept: string;
    weight: number;
    synonyms?: string[];
  }>;
}

export interface FrozenQuestion {
  /**
   * Canonical question id. The backend returns `question_id`; the pages
   * normalise it onto `id` at load time so per-question lookups (answers,
   * gradings, proposals) key off `q.id`.
   */
  id: string;
  question_id?: string;
  type: string;
  topic?: string;
  position?: number;
  content: unknown;
  points: number;
  rubric?: RubricForReview | null;
}

export interface AttemptDetailResponse extends EvaluationMeta {
  attempt: EvaluationMeta & {
    id: string;
    status: string;
    started_at: string | null;
    submitted_at: string | null;
    /** Absent on the super-admin payload — evaluation is blind. */
    candidate_email?: string | null;
    candidate_name?: string;
    isErased?: boolean;
    assessment_name: string;
    level_label: string;
  };
  answers: AttemptAnswer[];
  frozen_questions: FrozenQuestion[];
  gradings: GradingsRow[];
  /** Server-side cache of the last Grade-all batch (survives CF timeouts). */
  ai_proposals: GradingProposal[] | null;
  /** Set while a Grade-all batch is running on the server. */
  grading_started_at: string | null;
}

/**
 * Spec §5b does not pin whether the evaluation fields ride at the top level of
 * the payload or inside `attempt`, so read both (top level wins).
 */
export function evaluationMeta(d: AttemptDetailResponse): EvaluationMeta {
  return { ...d.attempt, ...d };
}

/** Normalises `question_id` onto `id` (the backend's field name differs). */
export function normaliseDetail(data: AttemptDetailResponse): AttemptDetailResponse {
  return {
    ...data,
    frozen_questions: (data.frozen_questions ?? []).map((q) => ({
      ...q,
      id: q.id ?? q.question_id ?? "",
    })),
  };
}

/**
 * Evaluation status, preferring the server's value. The fallback derives it
 * from the attempt status so older payloads still render sensibly.
 */
export function evaluationStatusOf(
  status: string,
  explicit?: EvaluationStatus | null,
): EvaluationStatus {
  if (explicit) return explicit;
  if (status === "released") return "published";
  if (status === "graded") return "ready_to_publish";
  return "awaiting_evaluation";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Fresh-MFA failures: 401, or 403 with MFA_REQUIRED (same rule as tenant-settings). */
export function isMfaError(err: unknown): boolean {
  return (
    err instanceof AdminApiError &&
    (err.status === 401 ||
      (err.status === 403 && err.apiError.details?.code === "MFA_REQUIRED"))
  );
}

export function apiMessage(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.apiError.message : fallback;
}

/** Matches a backend error code whether it rides at error.code or error.details.code. */
export function isErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof AdminApiError &&
    (err.apiError.code === code || err.apiError.details?.code === code)
  );
}

// ---------------------------------------------------------------------------
// Grading helpers
// ---------------------------------------------------------------------------

/**
 * AI-failure detection: proposals built by the failed-proposal branch in
 * admin-grade.ts carry these tells. They are skipped by Accept-all so a runtime
 * failure never auto-commits a score-0 row.
 */
export function isAiFailure(p: GradingProposal): boolean {
  if (p.model === "none") return true;
  if (p.prompt_version_sha === "error:no-sha") return true;
  const ec = p.band.error_class;
  if (typeof ec === "string" && ec.startsWith("AIG_")) return true;
  // Two-model vote disagreed by >=2 bands: the admin must adjudicate.
  if (p.escalation_chosen_stage === "manual") return true;
  return false;
}

/**
 * The effective grading per question: the newest row, with an admin override
 * winning a timestamp tie. Mirrors the server rule (DISTINCT ON question_id
 * ORDER BY graded_at DESC, grader = 'admin_override' DESC) so the page shows the
 * grade that is actually counted, including after an override.
 */
export function effectiveGradings(gradings: GradingsRow[]): Map<string, GradingsRow> {
  const best = new Map<string, GradingsRow>();
  for (const g of gradings) {
    const cur = best.get(g.question_id);
    if (!cur) {
      best.set(g.question_id, g);
      continue;
    }
    const gt = new Date(g.graded_at).getTime();
    const ct = new Date(cur.graded_at).getTime();
    if (gt > ct || (gt === ct && g.grader === "admin_override" && cur.grader !== "admin_override")) {
      best.set(g.question_id, g);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Queue age
// ---------------------------------------------------------------------------

export type AgeTone = "ok" | "warn" | "late";

/** >= 24 h amber, >= 48 h red (owner rule: alert the owner when items age). */
export function ageTone(hours: number): AgeTone {
  if (hours >= 48) return "late";
  if (hours >= 24) return "warn";
  return "ok";
}

export function ageLabel(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
}
