// AssessIQ — attempt-detail error-handling tests.
//
// Verifies that a transient action error does NOT blank-red the page:
//   - Page stays rendered with question content when error is set.
//   - Error banner shows with Refresh + Dismiss buttons.
//   - Clicking Refresh triggers a new load and clears the error.
//   - Clicking Dismiss clears the banner without reloading.
//
// 2026-10-01 (scoring / result-release): tenants no longer have a Grade all
// button, so the failing action is now "Publish to candidate" on a
// ready_to_publish attempt (the publish POST is what rejects).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports that use them.
// ---------------------------------------------------------------------------

vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "attempt-abc123" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

vi.mock("../components/GradingProposalCard.js", () => ({
  GradingProposalCard: () => React.createElement("div", { "data-testid": "grading-proposal-card" }),
}));

vi.mock("../components/EscalationDiff.js", () => ({
  EscalationDiff: () => React.createElement("div", { "data-testid": "escalation-diff" }),
}));

vi.mock("../components/ScoreDetail.js", () => ({
  ScoreDetail: () => React.createElement("div", { "data-testid": "score-detail" }),
}));

vi.mock("../components/AttemptIntegrityCard.js", () => ({
  AttemptIntegrityCard: () => null,
}));
vi.mock("../components/BandPicker.js", () => ({
  BandPicker: () => React.createElement("div", { "data-testid": "band-picker" }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DETAIL = {
  attempt: {
    id: "attempt-abc123",
    status: "graded",
    started_at: "2026-05-10T09:00:00Z",
    submitted_at: "2026-05-10T10:00:00Z",
    candidate_email: "test@example.com",
    candidate_name: "Test Candidate",
    isErased: false,
    assessment_name: "SOC L2 Assessment",
    level_label: "L2",
  },
  evaluation_status: "ready_to_publish",
  answers: [
    { question_id: "q1", answer: "candidate answer for q1" },
  ],
  frozen_questions: [
    { id: "q1", type: "mcq", content: "What is the MITRE technique for PowerShell abuse?", points: 5 },
  ],
  gradings: [],
  ai_proposals: null,
  grading_started_at: null,
};

const FAIL_MESSAGE = "The publish request could not be completed — refresh the page and try again.";

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { adminApi, AdminApiError } from "../api.js";
import { AdminAttemptDetail } from "../pages/attempt-detail.js";

const mockAdminApi = adminApi as ReturnType<typeof vi.fn>;

function failure(): Error {
  return new (AdminApiError as unknown as new (
    status: number,
    apiError: { code: string; message: string },
  ) => InstanceType<typeof AdminApiError>)(409, { code: "RESULT_NOT_READY", message: FAIL_MESSAGE });
}

/** Opens the publish summary and confirms — the POST that follows is the failing call. */
async function confirmPublish(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Publish to candidate" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish to candidate" }));
}

async function renderLoaded(): Promise<void> {
  render(React.createElement(AdminAttemptDetail));
  await waitFor(() =>
    expect(screen.queryByText("What is the MITRE technique for PowerShell abuse?")).not.toBeNull(),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdminAttemptDetail — error banner behaviour", () => {
  beforeEach(() => {
    // Default: first call (load) succeeds with mock detail.
    mockAdminApi.mockResolvedValueOnce(MOCK_DETAIL);
  });

  it("renders question content after initial load", async () => {
    await renderLoaded();
  });

  it("shows error banner (not blank-red page) when Publish is rejected", async () => {
    // Second call is the publish POST — rejects.
    mockAdminApi.mockRejectedValueOnce(failure());

    await renderLoaded();
    await confirmPublish();

    // Error banner should appear.
    await waitFor(() => expect(screen.queryByText(FAIL_MESSAGE)).not.toBeNull());

    // Page must still show question content — NOT a blank page.
    expect(screen.queryByText("What is the MITRE technique for PowerShell abuse?")).not.toBeNull();

    // Refresh and Dismiss buttons must be present.
    expect(screen.queryByText("Refresh")).not.toBeNull();
    expect(screen.queryByText("Dismiss")).not.toBeNull();
  });

  it("Refresh button reloads the attempt and clears the error banner", async () => {
    // Publish fails, then the Refresh load succeeds.
    mockAdminApi
      .mockRejectedValueOnce(failure()) // publish POST
      .mockResolvedValueOnce(MOCK_DETAIL); // Refresh GET

    await renderLoaded();
    await confirmPublish();
    await waitFor(() => expect(screen.queryByText("Refresh")).not.toBeNull());

    // Before click: adminApi has been called twice (initial load + publish).
    const callsBefore = mockAdminApi.mock.calls.length;

    fireEvent.click(screen.getByText("Refresh"));

    // After click: a new load call should have been made.
    await waitFor(() => expect(mockAdminApi.mock.calls.length).toBeGreaterThan(callsBefore));

    // Error banner should disappear.
    await waitFor(() => expect(screen.queryByText("Refresh")).toBeNull());
  });

  it("Dismiss button clears the error banner without reloading", async () => {
    mockAdminApi.mockRejectedValueOnce(failure());

    await renderLoaded();
    await confirmPublish();
    await waitFor(() => expect(screen.queryByText("Dismiss")).not.toBeNull());

    const callsBefore = mockAdminApi.mock.calls.length;
    fireEvent.click(screen.getByText("Dismiss"));

    // Banner gone.
    await waitFor(() => expect(screen.queryByText("Dismiss")).toBeNull());

    // No additional API call was made by Dismiss.
    expect(mockAdminApi.mock.calls.length).toBe(callsBefore);

    // Page still shows question content.
    expect(screen.queryByText("What is the MITRE technique for PowerShell abuse?")).not.toBeNull();
  });
});
