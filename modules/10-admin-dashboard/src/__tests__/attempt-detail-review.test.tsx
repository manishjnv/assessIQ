// AssessIQ — smoke tests for the tenant attempt-detail review page
// (scoring / result-release, spec 2026-10-01 §5b — frontend half).
//
// Tenants no longer grade: AssessIQ evaluates, the company reviews and publishes.
//
//   T1  awaiting_evaluation → "Awaiting AssessIQ grading" banner, no grades,
//       no publish / send-back / override, and never a Grade all / Accept all
//   T2  ready_to_publish → final grades, Override / Send back / Publish all
//       there; Send back and Publish hit the right endpoints
//   T3  an override that races the release (409 EVALUATION_NOT_RELEASED) shows a
//       plain message and reloads
//   T4  published → read-only

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: vi.fn(),
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
import { AdminAttemptDetail } from "../pages/attempt-detail.js";

const AID = "44444444-4444-4444-8444-444444444444";
const Q1 = "55555555-5555-4555-8555-555555555555";
const GET_PATH = `/admin/attempts/${AID}`;

function grading(over: Record<string, unknown> = {}) {
  return {
    id: "g-1",
    tenant_id: "t-acme",
    attempt_id: AID,
    question_id: Q1,
    grader: "ai",
    score_earned: 15,
    score_max: 20,
    status: "partial",
    anchor_hits: null,
    reasoning_band: 3,
    ai_justification: "Covers the pivot and the credential reuse.",
    error_class: null,
    prompt_version_sha: "x",
    prompt_version_label: "x",
    model: "sonnet",
    escalation_chosen_stage: null,
    graded_at: "2026-09-30T10:00:00.000Z",
    graded_by: null,
    override_of: null,
    override_reason: null,
    ...over,
  };
}

function detail(kind: "awaiting_evaluation" | "ready_to_publish" | "published") {
  const graded = kind !== "awaiting_evaluation";
  return {
    attempt: {
      id: AID,
      status: kind === "published" ? "released" : graded ? "graded" : "pending_admin_grading",
      started_at: "2026-09-29T09:00:00.000Z",
      submitted_at: "2026-09-29T10:00:00.000Z",
      candidate_email: "priya@example.com",
      candidate_name: "Priya Sharma",
      isErased: false,
      assessment_name: "SOC Analyst L1",
      level_label: "L1",
    },
    evaluation_status: kind,
    answers: [{ question_id: Q1, answer: { response: "Attackers pivot with stolen credentials." } }],
    frozen_questions: [
      { question_id: Q1, type: "subjective", content: { question: "Explain lateral movement." }, points: 20, rubric: null },
    ],
    gradings: graded ? [grading()] : [],
    score: graded ? { total_earned: 15, total_max: 20 } : null,
    ai_proposals: null,
    grading_started_at: null,
  };
}

function mockApi(kind: "awaiting_evaluation" | "ready_to_publish" | "published", extra?: (path: string, init?: RequestInit) => unknown): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === GET_PATH) return detail(kind);
    const custom = extra?.(path, init);
    if (custom !== undefined) return custom;
    throw new Error(`unexpected adminApi call: ${init?.method ?? "GET"} ${path}`);
  });
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/admin/attempts/${AID}`]}>
      <Routes>
        <Route path="/admin/attempts/:id" element={<AdminAttemptDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("Explain lateral movement.");
}

const buttonNames = (): string[] =>
  screen.queryAllByRole("button").map((b) => (b.textContent ?? "").trim());

const calls = (path: string): Array<[string, RequestInit | undefined]> =>
  adminApi.mock.calls.filter((c) => c[0] === path) as Array<[string, RequestInit | undefined]>;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminAttemptDetail — tenant review", () => {
  it("T1 awaiting evaluation: banner only, no grades and no AI or publish controls", async () => {
    mockApi("awaiting_evaluation");
    await renderPage();

    expect(screen.getByText("Awaiting AssessIQ grading.")).toBeTruthy();
    expect(screen.getByText("Awaiting grading")).toBeTruthy(); // status chip

    const names = buttonNames();
    for (const gone of ["Grade all", "Accept all", "Re-run", "Release to candidate", "Send back for re-grading", "Override grade", "Score manually"]) {
      expect(names.some((n) => n.startsWith(gone)), gone).toBe(false);
    }
    expect(screen.queryByText("Final grade")).toBeNull();
  });

  it("T2 ready to publish: final grades; send back and publish call the right endpoints", async () => {
    mockApi("ready_to_publish", (path, init) => {
      if (path === `${GET_PATH}/send-back` || path === `${GET_PATH}/release`) {
        return init?.method === "POST" ? {} : undefined;
      }
      return undefined;
    });
    await renderPage();

    expect(screen.getByText("Ready to release")).toBeTruthy(); // status chip
    expect(screen.getByText("Final grade")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Override grade" })).toBeTruthy();
    const names = buttonNames();
    for (const gone of ["Grade all", "Accept all", "Re-run", "Score manually"]) {
      expect(names.some((n) => n.startsWith(gone)), gone).toBe(false);
    }

    // Send back for re-grading — a note is required.
    fireEvent.click(screen.getByRole("button", { name: "Send back for re-grading" }));
    const send = screen.getByRole("button", { name: "Send back" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Note \(required\)/), { target: { value: "Q1 looks too low." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(calls(`${GET_PATH}/send-back`)).toHaveLength(1));
    expect(calls(`${GET_PATH}/send-back`)[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(calls(`${GET_PATH}/send-back`)[0]?.[1]?.body))).toEqual({ note: "Q1 looks too low." });

    // Release to candidate — summary modal first, then POST /release.
    fireEvent.click(screen.getByRole("button", { name: "Release to candidate" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Release to candidate" }));
    await waitFor(() => expect(calls(`${GET_PATH}/release`)).toHaveLength(1));
    expect(calls(`${GET_PATH}/release`)[0]?.[1]?.method).toBe("POST");
  });

  it("T3 an override rejected with EVALUATION_NOT_RELEASED shows a plain message", async () => {
    mockApi("ready_to_publish", (path) => {
      if (path === "/admin/gradings/g-1/override") {
        throw new AdminApiError(409, { code: "EVALUATION_NOT_RELEASED", message: "raw server text" });
      }
      return undefined;
    });
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Override grade" }));
    fireEvent.click(screen.getByRole("radio", { name: /Score band 4/ }));
    fireEvent.change(screen.getByLabelText(/Override reason \(required\)/), { target: { value: "Fully correct." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit override" }));

    await screen.findByText(/can't be changed right now/);
    // Scaled to the grading's own score_max (20), not a fixed band * 25.
    const body = JSON.parse(String(calls("/admin/gradings/g-1/override")[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.score_earned).toBe(20);
    expect(body.reasoning_band).toBe(4);
  });

  it("T4 published is read-only", async () => {
    mockApi("published");
    await renderPage();

    expect(screen.getByText("Released")).toBeTruthy(); // status chip
    expect(screen.getByText(/can no longer be changed/)).toBeTruthy();
    const names = buttonNames();
    for (const gone of ["Release to candidate", "Send back for re-grading", "Override grade", "Grade all"]) {
      expect(names.some((n) => n.startsWith(gone)), gone).toBe(false);
    }
  });
});
