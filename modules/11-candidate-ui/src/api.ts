// Typed fetch wrappers for the candidate surface. Mirrors apps/web/src/lib/api.ts
// (cookie-trust + ApiCallError envelope) but lives in the package so consumers
// of @assessiq/candidate-ui (apps/web today, embed bundle later) get the same
// typed entrypoints without depending on the apps/web internals.
//
// All endpoints carry the candidate session via the aiq_sess cookie set by
// /api/auth/google/cb (admin path) or /api/take/start (magic-link path,
// Session 4b). credentials:'include' sends it on every call.

import type {
  AttemptAnswerWire,
  AttemptResultPendingWire,
  CandidateAttemptViewWire,
  CandidateEventInput,
  InvitedAssessmentWire,
  SubmitAttemptResponseWire,
  TakeStartResponseWire,
  ApiErrorEnvelope,
} from "./types";

const DEFAULT_BASE = "/api";

export class CandidateApiError extends Error {
  status: number;
  apiError: ApiErrorEnvelope;
  constructor(status: number, apiError: ApiErrorEnvelope) {
    super(apiError.message);
    this.status = status;
    this.apiError = apiError;
    this.name = "CandidateApiError";
  }
}

interface CallOptions extends RequestInit {
  /** Override the API base, e.g. "" for /take which is mounted bare-root. */
  base?: string;
}

async function call<T>(path: string, init: CallOptions = {}): Promise<T> {
  const { base = DEFAULT_BASE, ...rest } = init;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: { error?: ApiErrorEnvelope };
    try {
      body = (await res.json()) as { error?: ApiErrorEnvelope };
    } catch {
      body = {};
    }
    const apiErr: ApiErrorEnvelope =
      body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw new CandidateApiError(res.status, apiErr);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Magic-link entry (Session 4b backend) ───────────────────────────────────

/**
 * POST /take/start — anonymous; mints a candidate session via the magic-link
 * token and creates (or returns) the attempt. Mounted bare-root, NOT under
 * /api/, per docs/03-api-contract.md § Magic-link. Caddy must forward
 * /take/* to assessiq-api once Session 4b lands; today this returns 404 and
 * the landing page surfaces the "magic link not yet wired" state.
 */
export async function takeStart(
  token: string,
): Promise<TakeStartResponseWire> {
  return call<TakeStartResponseWire>("/take/start", {
    method: "POST",
    body: JSON.stringify({ token }),
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
): Promise<{ attempt_id: string }> {
  // Server returns the full Attempt; the candidate UI only needs the id to
  // pivot the route, the full view is fetched fresh via getAttempt below.
  const attempt = await call<{ id: string }>(
    `/me/assessments/${encodeURIComponent(assessmentId)}/start`,
    { method: "POST" },
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
  const res = await fetch(`${DEFAULT_BASE}/me/attempts/${encodeURIComponent(attemptId)}/answer`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: questionId, ...payload }),
  });

  if (!res.ok) {
    let body: { error?: ApiErrorEnvelope };
    try {
      body = (await res.json()) as { error?: ApiErrorEnvelope };
    } catch {
      body = {};
    }
    const apiErr: ApiErrorEnvelope =
      body.error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw new CandidateApiError(res.status, apiErr);
  }

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

export async function getResult(
  attemptId: string,
): Promise<AttemptResultPendingWire> {
  return call<AttemptResultPendingWire>(
    `/me/attempts/${encodeURIComponent(attemptId)}/result`,
  );
}

// Re-exported for callers that need to switch on the wire types.
export type { AttemptAnswerWire };
