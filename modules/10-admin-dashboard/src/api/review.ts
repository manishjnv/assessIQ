// AssessIQ - Admin question review API client (EXP-18 review queue and notes).
//
// Thin typed wrappers over adminApi (/api base). Types are defined here on purpose:
// the new review routes are built by another agent, so this file does not import
// types from the backend modules.
//
// Routes:
//   GET  /admin/review-queue?state=&page=&pageSize=        -> ReviewQueueResponse
//   GET  /admin/questions/:id/review-notes                 -> ReviewNotesResponse (newest first)
//   POST /admin/questions/:id/review  { action, note? }    -> action: verify | needs_fix | dispute | withdraw
//   GET  /admin/questions/:id/affected-attempts            -> AffectedAttemptsResponse (read only)

import { adminApi } from "../api.js";

/** The state filter of the review queue. `open` = in review, disputed or needs fix. */
export type ReviewQueueState = "open" | "in_review" | "verified" | "disputed" | "needs_fix" | "none" | "all";

/** A review state stored on a question. */
export type ReviewStateValue = "in_review" | "verified" | "disputed" | "needs_fix";

/** The actions the review route accepts. `needs_fix` and `dispute` need a note. */
export type ReviewAction = "verify" | "needs_fix" | "dispute" | "withdraw";

export interface ReviewCounts {
  in_review: number;
  verified: number;
  disputed: number;
  needs_fix: number;
  none: number;
}

export interface ReviewLatestNote {
  note: string;
  state: string;
  created_at: string;
}

export interface ReviewQueueItem {
  id: string;
  pack_id: string;
  pack_name: string;
  type: string;
  topic: string;
  status: string;
  version: number;
  review_state: string | null;
  origin: string | null;
  rights_status: string | null;
  updated_at: string;
  latest_note: ReviewLatestNote | null;
}

export interface ReviewQueueResponse {
  counts: ReviewCounts;
  total: number;
  items: ReviewQueueItem[];
}

export interface ReviewQueueParams {
  state: ReviewQueueState;
  page: number;
  pageSize: number;
}

export interface ReviewNoteItem {
  id: string;
  version: number;
  state: string;
  note: string;
  author_user_id: string | null;
  created_at: string;
}

export interface ReviewNotesResponse {
  latest: ReviewNoteItem | null;
  items: ReviewNoteItem[];
}

export interface AffectedAttemptItem {
  attempt_id: string;
  assessment_id: string;
  assessment_name: string;
  candidate_user_id: string;
  status: string;
  question_version: number;
  submitted_at: string | null;
}

export interface AffectedAttemptsResponse {
  question_id: string;
  current_version: number;
  total: number;
  items: AffectedAttemptItem[];
}

export async function getReviewQueueApi(params: ReviewQueueParams): Promise<ReviewQueueResponse> {
  const qs = new URLSearchParams({
    state: params.state,
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  return adminApi<ReviewQueueResponse>(`/admin/review-queue?${qs.toString()}`);
}

export async function getReviewNotesApi(questionId: string): Promise<ReviewNotesResponse> {
  return adminApi<ReviewNotesResponse>(`/admin/questions/${encodeURIComponent(questionId)}/review-notes`);
}

export async function postQuestionReviewApi(questionId: string, action: ReviewAction, note?: string): Promise<unknown> {
  return adminApi<unknown>(`/admin/questions/${encodeURIComponent(questionId)}/review`, {
    method: "POST",
    body: JSON.stringify({ action, ...(note !== undefined ? { note } : {}) }),
  });
}

export async function getAffectedAttemptsApi(questionId: string): Promise<AffectedAttemptsResponse> {
  return adminApi<AffectedAttemptsResponse>(`/admin/questions/${encodeURIComponent(questionId)}/affected-attempts`);
}
