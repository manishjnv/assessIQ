// AssessIQ — smoke tests for the super-admin evaluate page
// (scoring / result-release, spec 2026-10-01 §5b — frontend half).
//
//   E1  Grade all, Re-run, Accept all, manual score (KQL) each hit the right
//       /admin/super/evaluations/:id/* endpoint with the right body; the page never
//       shows candidate PII; the score that COMPLETES the attempt shows the
//       "Released to <company>" state (no separate release click)
//   E2  Release to company stays disabled until every question is graded
//   E3  a fresh-MFA 401 on a manual score opens the inline step-up and retries
//   E4  before the LAST accept the page says it will release the result (inline notice,
//       no confirm dialog); no notice while accepting would not complete the evaluation
//   E5  a sent-back attempt: Re-run AI (attempt level, body {}) shows the new proposals
//       over the existing grades with Accept / Override; accepting does not release;
//       Release to company (the recovery action) still works
//   E6  Re-run AI only for graded + unreleased + sent-back; Grade all never for a graded one

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const { adminApi, verifyTotpApi } = vi.hoisted(() => ({
  adminApi: vi.fn(),
  verifyTotpApi: vi.fn(),
}));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: (...a: unknown[]) => verifyTotpApi(...a),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
}));

vi.mock("../session.js", () => ({
  useAdminSession: () => ({ session: null, loading: false }),
  fetchAdminWhoami: vi.fn().mockResolvedValue(null),
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

import { AdminApiError } from "../api.js";
import { AdminEvaluationDetail } from "../pages/evaluation-detail.js";

const AID = "11111111-1111-4111-8111-111111111111";
const Q1 = "22222222-2222-4222-8222-222222222222"; // subjective — AI graded
const Q2 = "33333333-3333-4333-8333-333333333333"; // kql — scored by hand
const BASE = `/admin/super/evaluations/${AID}`;

// Fixed timestamps so "newer than the grade" is deterministic whatever the clock says.
const T_OLD_GRADE = "2026-09-30T10:00:00.000Z";
const T_RERUN = "2026-10-01T09:00:00.000Z"; // a re-run proposal: after the old grades
const T_ACCEPTED = "2026-10-01T09:05:00.000Z"; // the grade written by accepting it: after the proposal

const NOTICE = "Accepting the last grade releases this result to Acme College. If Acme College publishes automatically, the student gets it within a minute.";

const PROPOSAL = {
  attempt_id: AID,
  question_id: Q1,
  anchors: [],
  band: { reasoning_band: 3, ai_justification: "Covers the pivot and the credential reuse." },
  score_earned: 15,
  score_max: 20,
  prompt_version_sha: "anchors:aaaaaaaa;band:bbbbbbbb;escalate:-",
  prompt_version_label: "grade-band v3",
  model: "sonnet",
  generated_at: "2026-09-30T09:00:00.000Z",
};

function gradingRow(questionId: string, score: number, max: number, grader: string, gradedAt = T_OLD_GRADE) {
  return {
    id: `g-${questionId.slice(0, 4)}-${gradedAt}`,
    tenant_id: "t-acme",
    attempt_id: AID,
    question_id: questionId,
    grader,
    score_earned: score,
    score_max: max,
    status: "correct",
    anchor_hits: null,
    reasoning_band: null,
    ai_justification: null,
    error_class: null,
    prompt_version_sha: "x",
    prompt_version_label: "x",
    model: "x",
    escalation_chosen_stage: null,
    graded_at: gradedAt,
    graded_by: null,
    override_of: null,
    override_reason: null,
  };
}

type Initial = "pending" | "kqlScored" | "sentBack" | "gradedNotSentBack" | "released";

/**
 * The "server": mutable detail that the POST handlers advance, mimicking the real rules —
 * the accept / manual score that COMPLETES a pre-graded attempt flips it to graded AND
 * releases it to the company; an already-graded (sent-back) attempt is never auto-released;
 * the attempt-level re-run on a graded attempt caches its proposals.
 */
function makeServer(opts: { mfaOnManualScore?: boolean; initial?: Initial } = {}) {
  const initial = opts.initial ?? "pending";
  const graded = initial === "sentBack" || initial === "gradedNotSentBack" || initial === "released";
  const state = {
    status: graded ? "graded" : "pending_admin_grading",
    released: initial === "released",
    sentBack: initial === "sentBack",
    gradings: [
      ...(initial === "kqlScored" ? [gradingRow(Q2, 7, 10, "admin_override")] : []),
      ...(graded ? [gradingRow(Q1, 15, 20, "ai"), gradingRow(Q2, 7, 10, "admin_override")] : []),
    ],
    proposals: (initial === "kqlScored" ? [PROPOSAL] : null) as unknown[] | null,
    manualAttempts: 0,
  };
  const complete = () => [Q1, Q2].every((q) => state.gradings.some((g) => g.question_id === q));
  const completeIfDone = () => {
    if (state.status !== "graded" && complete()) {
      state.status = "graded";
      state.released = true; // the server releases in the same step (owner decision 2026-10-01)
      state.proposals = null;
    }
  };
  const detail = () => ({
    attempt: {
      id: AID,
      status: state.status,
      started_at: "2026-09-29T09:00:00.000Z",
      submitted_at: "2026-09-29T10:00:00.000Z",
      assessment_name: "SOC Analyst L1",
      level_label: "L1",
      // Stray candidate fields the API must never send — the page must not render them.
      candidate_email: "pii@example.com",
      candidate_name: "Priya Sharma",
    },
    tenant_id: "t-acme",
    tenant_name: "Acme College",
    evaluation_released_at: state.released ? "2026-10-01T08:00:00.000Z" : null,
    evaluation_note: state.sentBack ? "Q1 looks too generous." : null,
    evaluation_sent_back_at: state.sentBack ? "2026-09-30T12:00:00.000Z" : null,
    answers: [
      { question_id: Q1, answer: { response: "Attackers pivot with stolen credentials." } },
      { question_id: Q2, answer: { query: "SecurityEvent | where EventID == 4625" } },
    ],
    frozen_questions: [
      { question_id: Q1, type: "subjective", content: { question: "Explain lateral movement." }, points: 20, rubric: null },
      { question_id: Q2, type: "kql", content: { question: "Find failed logons." }, points: 10, rubric: null },
    ],
    gradings: [...state.gradings], // a fresh array per response, like the real API
    ai_proposals: state.proposals,
    grading_started_at: null,
  });

  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === BASE && method === "GET") return detail();
    if (path === `${BASE}/grade`) {
      state.proposals = [PROPOSAL];
      return { proposals: [PROPOSAL] };
    }
    if (path === `${BASE}/rerun`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { forceEscalate?: boolean };
      if (state.status === "graded") {
        // attempt-level Re-run AI on a sent-back attempt: a fresh verdict, cached server-side
        const fresh = { ...PROPOSAL, score_earned: 10, generated_at: T_RERUN };
        state.proposals = [fresh];
        return { proposals: [fresh] };
      }
      expect(body).toEqual({ forceEscalate: true });
      return { proposals: [{ ...PROPOSAL, band: { ...PROPOSAL.band, reasoning_band: 4 } }] };
    }
    if (path === `${BASE}/accept`) {
      const sent = (JSON.parse(String(init?.body)) as { proposals: Array<{ question_id: string; score_earned: number }> }).proposals;
      for (const p of sent) state.gradings.push(gradingRow(p.question_id, p.score_earned, 20, "ai", state.status === "graded" ? T_ACCEPTED : T_OLD_GRADE));
      completeIfDone();
      return { attempt: { id: AID, status: state.status === "graded" ? "graded" : "pending_admin_grading" } };
    }
    if (path === `${BASE}/questions/${Q2}/manual-score`) {
      state.manualAttempts += 1;
      if (opts.mfaOnManualScore && state.manualAttempts === 1) {
        throw new AdminApiError(401, { code: "UNAUTHENTICATED", message: "fresh totp required" });
      }
      state.gradings.push(gradingRow(Q2, 7, 10, "admin_override"));
      completeIfDone();
      return {};
    }
    if (path === `${BASE}/release-to-tenant`) {
      state.released = true;
      state.sentBack = false;
      return { attempt_id: AID, evaluation_released_at: "2026-10-01T08:00:00.000Z" };
    }
    throw new Error(`unexpected adminApi call: ${method} ${path}`);
  });
  return state;
}

const calls = (path: string): Array<[string, RequestInit | undefined]> =>
  adminApi.mock.calls.filter((c) => c[0] === path) as Array<[string, RequestInit | undefined]>;

const bodyOf = (path: string, nth = 0): unknown => JSON.parse(String(calls(path)[nth]?.[1]?.body));

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/admin/platform/evaluations/${AID}`]}>
      <Routes>
        <Route path="/admin/platform/evaluations/:attemptId" element={<AdminEvaluationDetail />} />
        <Route path="/admin/platform/evaluations" element={<div data-testid="queue-page" />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Explain lateral movement.");
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminEvaluationDetail", () => {
  it("E1 grade → re-run → accept → manual score releases by itself → back to the queue", async () => {
    makeServer();
    await renderPage();

    // Blind evaluation: company + level, never the candidate.
    expect(screen.getByText(/Acme College/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("pii@example.com");
    expect(document.body.textContent).not.toContain("Priya Sharma");

    // Grade all
    fireEvent.click(screen.getByRole("button", { name: "Grade all" }));
    await screen.findByText("AI Proposal");
    expect(calls(`${BASE}/grade`)).toHaveLength(1);
    expect(calls(`${BASE}/grade`)[0]?.[1]?.method).toBe("POST");
    // the KQL question is still unscored, so accepting Q1 would NOT complete the evaluation: no release notice
    expect(screen.queryByText(/releases this result to/)).toBeNull();
    expect(screen.queryByText("Re-run AI")).toBeNull(); // not a sent-back attempt

    // Re-run sends { forceEscalate: true } (not { question_id } + ?escalate=opus)
    fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
    await screen.findByText(/Stage-2 vs Stage-3 comparison/);
    expect(bodyOf(`${BASE}/rerun`)).toEqual({ forceEscalate: true });
    expect(adminApi.mock.calls.some((c) => String(c[0]).includes("escalate=opus"))).toBe(false);

    // Accept all → full proposal objects
    fireEvent.click(screen.getByRole("button", { name: "Accept all (1)" }));
    await waitFor(() => expect(calls(`${BASE}/accept`)).toHaveLength(1));
    const accepted = bodyOf(`${BASE}/accept`) as { proposals: Array<{ question_id: string }> };
    expect(accepted.proposals.map((p) => p.question_id)).toEqual([Q1]);

    // Manual score for the KQL question — the last missing grade: the form warns that saving releases it
    await screen.findByText("Q1 graded");
    expect(screen.getByText(/Saving the last score releases this result to Acme College/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Score \(0 to 10\)/), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/Reason \(required\)/), { target: { value: "Matches the expected query." } });
    fireEvent.click(screen.getByRole("button", { name: "Save score" }));
    await waitFor(() => expect(calls(`${BASE}/questions/${Q2}/manual-score`)).toHaveLength(1));
    expect(bodyOf(`${BASE}/questions/${Q2}/manual-score`)).toEqual({
      score_earned: 7,
      reason: "Matches the expected query.",
    });

    // Complete → released by that same step: the success state, no confirm dialog, no extra click
    await screen.findByText(/Released to Acme College\./);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(`${BASE}/release-to-tenant`)).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Release to company" }) as HTMLButtonElement).disabled).toBe(true);

    // ... with a way back to the queue
    fireEvent.click(screen.getByRole("button", { name: "Back to the queue" }));
    await screen.findByTestId("queue-page");
  });

  it("E2 Release to company is disabled until the attempt is complete", async () => {
    makeServer();
    await renderPage();
    const release = screen.getByRole("button", { name: "Release to company" }) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    expect(screen.queryByText(/Released to Acme College/)).toBeNull();
    expect(calls(`${BASE}/release-to-tenant`)).toHaveLength(0);
  });

  it("E3 a fresh-MFA 401 opens the step-up and retries the manual score", async () => {
    verifyTotpApi.mockResolvedValue(undefined);
    makeServer({ mfaOnManualScore: true });
    await renderPage();

    fireEvent.change(screen.getByLabelText(/Score \(0 to 10\)/), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/Reason \(required\)/), { target: { value: "Matches the expected query." } });
    fireEvent.click(screen.getByRole("button", { name: "Save score" }));

    await screen.findByText(/needs a fresh authenticator check/);
    expect(calls(`${BASE}/questions/${Q2}/manual-score`)).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & continue" }));

    await waitFor(() => expect(calls(`${BASE}/questions/${Q2}/manual-score`)).toHaveLength(2));
    expect(verifyTotpApi).toHaveBeenCalledWith("123456");
  });

  it("E4 the LAST accept warns that it releases the result to the company (inline, no confirm) and then shows the success state", async () => {
    // the KQL answer is already scored and the Grade-all proposals are cached: accepting Q1 completes the evaluation
    makeServer({ initial: "kqlScored" });
    await renderPage();

    await screen.findByText("AI Proposal");
    // the toolbar's Accept all and the proposal's own Accept both say so — exact wording
    const notices = screen.getAllByText(NOTICE);
    expect(notices.length).toBe(2);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Accept all (1)" }));
    await screen.findByText(/Released to Acme College\./);
    // the notice is gone once it is done, and the page went straight to the success state (no dialog)
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls(`${BASE}/release-to-tenant`)).toHaveLength(0);
    expect(screen.getByText(/It is no longer in the evaluation queue/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the queue" }));
    await screen.findByTestId("queue-page");
  });

  it("E5 sent-back attempt: Re-run AI shows the new proposals over the existing grades; accepting does not release; Release to company hands it back", async () => {
    const server = makeServer({ initial: "sentBack" });
    await renderPage();

    // graded + not released + sent back: Re-run AI is offered, Grade all is not; the grades are the current ones
    expect(screen.queryByRole("button", { name: "Grade all" })).toBeNull();
    expect(screen.getByText(/Sent back by Acme College for re-evaluation/)).toBeTruthy();
    expect(screen.queryByText("AI Proposal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Re-run AI" }));

    // attempt-level, body {} (no forceEscalate), the existing rerun endpoint
    await screen.findByText("AI Proposal");
    expect(calls(`${BASE}/rerun`)).toHaveLength(1);
    expect(calls(`${BASE}/rerun`)[0]?.[1]?.method).toBe("POST");
    expect(bodyOf(`${BASE}/rerun`)).toEqual({});
    // the proposal sits beside the grade it would replace; Accept / Override are there, the per-question Opus Re-run is not
    expect(screen.getByText(/New AI result from the re-run/)).toBeTruthy();
    expect(screen.getByText("Q1 re-run ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-run" })).toBeNull();
    // already graded, so accepting never releases: no release notice
    expect(screen.queryByText(/releases this result to/)).toBeNull();

    // Override on the proposal opens the override form for that question
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(await screen.findByText("Override grade (requires fresh MFA)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Accept all → full proposal; afterwards the card is gone (the new grade is newer) but nothing was released
    fireEvent.click(screen.getByRole("button", { name: "Accept all (1)" }));
    await waitFor(() => expect(calls(`${BASE}/accept`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("AI Proposal")).toBeNull());
    expect(screen.queryByText(/Released to Acme College/)).toBeNull();
    expect(server.released).toBe(false);

    // Release to company (the recovery action), with its confirm
    const release = await waitFor(() => {
      const b = screen.getByRole("button", { name: "Release to company" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(release);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Release to company" }));
    await screen.findByTestId("queue-page");
    expect(calls(`${BASE}/release-to-tenant`)).toHaveLength(1);
    expect(calls(`${BASE}/release-to-tenant`)[0]?.[1]?.method).toBe("POST");
  });

  it.each([
    ["a pending attempt", "pending"],
    ["a graded attempt that was not sent back", "gradedNotSentBack"],
    ["an attempt already released to the company", "released"],
  ] as const)("E6 no Re-run AI for %s", async (_label, initial) => {
    makeServer({ initial });
    await renderPage();
    expect(screen.queryByRole("button", { name: "Re-run AI" })).toBeNull();
    // Grade all belongs to pre-graded attempts only
    if (initial === "pending") expect(screen.getByRole("button", { name: "Grade all" })).toBeTruthy();
    else expect(screen.queryByRole("button", { name: "Grade all" })).toBeNull();
    expect(calls(`${BASE}/rerun`)).toHaveLength(0);
  });
});
