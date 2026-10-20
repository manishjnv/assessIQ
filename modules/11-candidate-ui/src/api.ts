// Typed fetch wrappers for the candidate surface. Mirrors apps/web/src/lib/api.ts
// (cookie-trust + ApiCallError envelope) but lives in the package so consumers
// of @assessiq/candidate-ui (apps/web today, embed bundle later) get the same
// typed entrypoints without depending on the apps/web internals.
//
// All endpoints carry the candidate session via the aiq_sess cookie set by
// /api/auth/google/cb (admin path) or /api/take/start (magic-link path,
// Session 4b). credentials:'include' sends it on every call.

import { ApiCallError, createApiClient, createApiRequest } from "@assessiq/http-client";
import type {
  AttemptAnswerWire,
  AttemptResultWire,
  CandidateAttemptViewWire,
  CandidateEventInput,
  InvitedAssessmentWire,
  MyResultsResponseWire,
  AttemptFeedbackWire,
  SubmitAttemptResponseWire,
  TakePreviewResponseWire,
  TakeStartResponseWire,
  ApiErrorEnvelope,
} from "./types";

const DEFAULT_BASE = "/api";

export class CandidateApiError extends ApiCallError {
  constructor(status: number, apiError: ApiErrorEnvelope) {
    super(status, apiError);
    this.name = "CandidateApiError";
  }
}

const request = createApiRequest(DEFAULT_BASE, CandidateApiError);
const call = createApiClient(DEFAULT_BASE, CandidateApiError);

// ─── Magic-link entry (Session 4b backend) ───────────────────────────────────

/**
 * POST /take/start { token, preview: true } — anonymous, read-only. Returns the
 * landing summary WITHOUT creating an attempt, minting a session or starting
 * the timer. Mounted bare-root (NOT under /api/); Caddy forwards /take/start.
 */
export async function takePreview(
  token: string,
): Promise<TakePreviewResponseWire> {
  return call<TakePreviewResponseWire>("/take/start", {
    method: "POST",
    body: JSON.stringify({ token, preview: true }),
    base: "",
  });
}

/**
 * POST /take/start { token, consent } — the Begin click. Mints the candidate
 * session, records consent and creates the attempt (the clock starts HERE).
 * Re-calling it for an existing attempt resumes it and never resets the clock.
 */
export async function takeStart(
  token: string,
  opts: { consent?: boolean; device?: unknown; readiness?: unknown } = {},
): Promise<TakeStartResponseWire> {
  // Z-87 / Z-91: device and readiness signals ride along; the server decides (the page is not trusted).
  return call<TakeStartResponseWire>("/take/start", {
    method: "POST",
    body: JSON.stringify({
      token,
      ...(opts.consent === true ? { consent: true } : {}),
      ...(opts.device !== undefined ? { device: opts.device } : {}),
      ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
    }),
    base: "",
  });
}

// ─── Candidate attempt surface (Session 4a backend, LIVE) ────────────────────

export async function listInvitedAssessments(): Promise<{
  items: InvitedAssessmentWire[];
}> {
  return call<{ items: InvitedAssessmentWire[] }>("/me/assessments");
}

export async function startAttempt(
  assessmentId: string,
  opts: { newAttempt?: boolean } = {},
): Promise<{ attempt_id: string }> {
  // Server returns the full Attempt; the candidate UI only needs the id to
  // pivot the route, the full view is fetched fresh via getAttempt below.
  // Z-39: newAttempt = the Try again button on the result page (a retake).
  const attempt = await call<{ id: string }>(
    `/me/assessments/${encodeURIComponent(assessmentId)}/start`,
    {
      method: "POST",
      ...(opts.newAttempt === true ? { body: JSON.stringify({ new_attempt: true }) } : {}),
    },
  );
  return { attempt_id: attempt.id };
}

export async function getAttempt(
  attemptId: string,
): Promise<CandidateAttemptViewWire> {
  return call<CandidateAttemptViewWire>(
    `/me/attempts/${encodeURIComponent(attemptId)}`,
  );
}

export interface SaveAnswerArgs {
  attemptId: string;
  questionId: string;
  answer: unknown;
  client_revision?: number;
  edits_count?: number;
  time_spent_seconds?: number;
}

/** Returns the new client_revision from the X-Client-Revision response header. */
export async function saveAnswer(
  args: SaveAnswerArgs,
): Promise<{ client_revision: number }> {
  const { attemptId, questionId, ...payload } = args;
  const res = await request(`/me/attempts/${encodeURIComponent(attemptId)}/answer`, {
    method: "POST",
    body: JSON.stringify({ question_id: questionId, ...payload }),
  });

  // Server sends X-Client-Revision per docs/03-api-contract.md § Candidate.
  // Fall back to the local +1 if the header is missing (proxy stripping etc.).
  const headerVal = res.headers.get("X-Client-Revision");
  const parsed = headerVal !== null ? Number.parseInt(headerVal, 10) : Number.NaN;
  const client_revision = Number.isFinite(parsed) ? parsed : (args.client_revision ?? 0) + 1;
  return { client_revision };
}

export async function toggleFlag(
  attemptId: string,
  questionId: string,
  flagged: boolean,
): Promise<{ flagged: boolean }> {
  return call<{ flagged: boolean }>(
    `/me/attempts/${encodeURIComponent(attemptId)}/flag`,
    {
      method: "POST",
      body: JSON.stringify({ question_id: questionId, flagged }),
    },
  );
}

/** Test sections: move on to the next section now (the finished one stays closed). */
export async function finishSection(attemptId: string): Promise<{ section_index: number }> {
  return call<{ section_index: number }>(
    `/me/attempts/${encodeURIComponent(attemptId)}/finish-section`,
    { method: "POST" },
  );
}

export async function recordEvent(
  attemptId: string,
  event: CandidateEventInput,
): Promise<void> {
  // 201 returns the AttemptEvent row, 204 means the rate cap dropped it.
  // Either way the caller doesn't care — fire-and-forget is the contract.
  await call<unknown>(
    `/me/attempts/${encodeURIComponent(attemptId)}/event`,
    {
      method: "POST",
      body: JSON.stringify(event),
    },
  );
}

export async function submitAttempt(
  attemptId: string,
): Promise<SubmitAttemptResponseWire> {
  return call<SubmitAttemptResponseWire>(
    `/me/attempts/${encodeURIComponent(attemptId)}/submit`,
    { method: "POST" },
  );
}

/**
 * GET /api/me/attempts/:id/result — 200 `released` (complete result) or 202
 * `pending`. Both are `res.ok`, so `call()` resolves for either; callers switch
 * on `status` and must treat anything other than "released" as pending.
 */
export async function getResult(
  attemptId: string,
): Promise<AttemptResultWire> {
  return call<AttemptResultWire>(
    `/me/attempts/${encodeURIComponent(attemptId)}/result`,
  );
}

/** GET /api/me/results — the candidate's released results, newest first. */
export async function listMyResults(): Promise<MyResultsResponseWire> {
  return call<MyResultsResponseWire>("/me/results");
}

/** GET /api/me/attempts/:id/feedback - per-question review (RW-80); items [] when the level is none. */
export async function getAttemptFeedback(attemptId: string): Promise<AttemptFeedbackWire> {
  return call<AttemptFeedbackWire>(`/me/attempts/${encodeURIComponent(attemptId)}/feedback`);
}

// ─── Progress (RW-84) ────────────────────────────────────────────────────────

export interface ProgressAttempt {
  attempt_id: string;
  assessment_id: string;
  assessment_name: string;
  released_at: string;
  total_earned: number;
  total_max: number;
  score_pct: number | null;
  passing_score_pct: number | null;
  passed: boolean | null;
  certificate: { credential_id: string; verify_url: string } | null;
}
export interface ProgressSubject {
  node_id: string;
  label: string;
  questions: number;
  correct: number;
  rate_pct: number;
}
export interface CandidateProgress {
  attempts: ProgressAttempt[];
  trend: number[];
  subjects: ProgressSubject[];
}

/** GET /api/me/progress — released attempts only: history, trend, subject strengths. */
export async function getMyProgress(): Promise<CandidateProgress> {
  return call<CandidateProgress>("/me/progress");
}

/** Z-12: POST /api/me/attempts/:id/seen — the candidate opened this result (idempotent). */
export async function markResultSeen(attemptId: string): Promise<{ seen: true }> {
  return call<{ seen: true }>(`/me/attempts/${encodeURIComponent(attemptId)}/seen`, { method: "POST" });
}

// Re-exported for callers that need to switch on the wire types.
export type { AttemptAnswerWire };

// ─── Certificate surface (Phase 5 Session 5) ─────────────────────────────────

export interface MyCertificate {
  credential_id: string;
  tier: 'completion' | 'distinction' | 'honors';
  course_title: string;
  level: string;
  issued_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  signed_hash_valid: boolean;
  verify_url: string;
  pdf_url: string;
  pdf_downloads: number;
  linkedin_shares: number;
  verification_views: number;
}

export interface MyCertificatesResponse {
  certificates: MyCertificate[];
}

export async function listMyCertificates(): Promise<MyCertificatesResponse> {
  return call<MyCertificatesResponse>('/certificates');
}

export async function shareCertificateLinkedIn(credentialId: string): Promise<void> {
  return call<void>(`/certificates/${encodeURIComponent(credentialId)}/share-linkedin`, {
    method: 'POST',
  });
}

// Generic typed GET helper — mirrors adminApi() from @assessiq/admin-dashboard.
// Used by CandidateActivity and any future pages that need ad-hoc GETs without
// a named wrapper function.
export async function candidateApi<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return call<T>(path, init);
}
