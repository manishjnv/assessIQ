// AssessIQ — attempt-detail error-handling tests.
//
// Verifies that a transient grade/action error does NOT blank-red the page:
//   - Page stays rendered with question content when error is set.
//   - Error banner shows with Refresh + Dismiss buttons.
//   - Clicking Refresh triggers a new load() call and clears the error.
//   - Clicking Dismiss clears the banner without reloading.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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

vi.mock("../components/BandPicker.js", () => ({
  BandPicker: () => React.createElement("div", { "data-testid": "band-picker" }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DETAIL = {
  attempt: {
    id: "attempt-abc123",
    status: "pending_admin_grading",
    started_at: "2026-05-10T09:00:00Z",
    submitted_at: "2026-05-10T10:00:00Z",
    candidate_email: "test@example.com",
    assessment_name: "SOC L2 Assessment",
    level_label: "L2",
  },
  answers: [
    { question_id: "q1", answer: "candidate answer for q1" },
  ],
  frozen_questions: [
    { id: "q1", type: "mcq", content: "What is the MITRE technique for PowerShell abuse?", points: 5 },
  ],
  gradings: [],
};

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { adminApi, AdminApiError } from "../api.js";
import { AdminAttemptDetail } from "../pages/attempt-detail.js";

const mockAdminApi = adminApi as ReturnType<typeof vi.fn>;

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
    render(React.createElement(AdminAttemptDetail));
    await waitFor(() =>
      expect(screen.queryByText("What is the MITRE technique for PowerShell abuse?")).not.toBeNull(),
    );
  });

  it("shows error banner (not blank-red page) when Grade returns 409 HEARTBEAT_STALE", async () => {
    // Second call is the Grade POST — rejects with HEARTBEAT_STALE.
    const heartbeatError = new (AdminApiError as unknown as new (
      status: number,
      apiError: { code: string; message: string },
    ) => InstanceType<typeof AdminApiError>)(409, {
      code: "HEARTBEAT_STALE",
      message: "Your session was idle for more than 5 minutes — refresh the page to continue grading.",
    });
    mockAdminApi.mockRejectedValueOnce(heartbeatError);

    render(React.createElement(AdminAttemptDetail));

    // Wait for initial load to complete and question to appear.
    await waitFor(() =>
      expect(
        screen.queryByText("What is the MITRE technique for PowerShell abuse?"),
      ).not.toBeNull(),
    );

    // Click Grade button to trigger the failing action.
    const gradeBtn = screen.getByText("Grade all");
    fireEvent.click(gradeBtn);

    // Error banner should appear.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Your session was idle for more than 5 minutes — refresh the page to continue grading.",
        ),
      ).not.toBeNull(),
    );

    // Page must still show question content — NOT a blank page.
    expect(
      screen.queryByText("What is the MITRE technique for PowerShell abuse?"),
    ).not.toBeNull();

    // Refresh and Dismiss buttons must be present.
    expect(screen.queryByText("Refresh")).not.toBeNull();
    expect(screen.queryByText("Dismiss")).not.toBeNull();
  });

  it("Refresh button calls load() and clears the error banner", async () => {
    const heartbeatError = new (AdminApiError as unknown as new (
      status: number,
      apiError: { code: string; message: string },
    ) => InstanceType<typeof AdminApiError>)(409, {
      code: "HEARTBEAT_STALE",
      message: "Your session was idle for more than 5 minutes — refresh the page to continue grading.",
    });
    // Grade fails, then the Refresh load() succeeds.
    mockAdminApi
      .mockRejectedValueOnce(heartbeatError) // Grade POST
      .mockResolvedValueOnce(MOCK_DETAIL);   // Refresh load GET

    render(React.createElement(AdminAttemptDetail));

    await waitFor(() =>
      expect(
        screen.queryByText("What is the MITRE technique for PowerShell abuse?"),
      ).not.toBeNull(),
    );

    fireEvent.click(screen.getByText("Grade all"));

    await waitFor(() =>
      expect(screen.queryByText("Refresh")).not.toBeNull(),
    );

    // Before click: adminApi has been called twice (initial load + grade).
    const callsBefore = mockAdminApi.mock.calls.length;

    fireEvent.click(screen.getByText("Refresh"));

    // After click: a new load() call should have been made.
    await waitFor(() => expect(mockAdminApi.mock.calls.length).toBeGreaterThan(callsBefore));

    // Error banner should disappear after Refresh completes.
    await waitFor(() =>
      expect(screen.queryByText("Refresh")).toBeNull(),
    );
  });

  it("Dismiss button clears the error banner without reloading", async () => {
    const heartbeatError = new (AdminApiError as unknown as new (
      status: number,
      apiError: { code: string; message: string },
    ) => InstanceType<typeof AdminApiError>)(409, {
      code: "HEARTBEAT_STALE",
      message: "Your session was idle for more than 5 minutes — refresh the page to continue grading.",
    });
    mockAdminApi.mockRejectedValueOnce(heartbeatError);

    render(React.createElement(AdminAttemptDetail));

    await waitFor(() =>
      expect(
        screen.queryByText("What is the MITRE technique for PowerShell abuse?"),
      ).not.toBeNull(),
    );

    fireEvent.click(screen.getByText("Grade all"));

    await waitFor(() =>
      expect(screen.queryByText("Dismiss")).not.toBeNull(),
    );

    const callsBefore = mockAdminApi.mock.calls.length;
    fireEvent.click(screen.getByText("Dismiss"));

    // Banner gone.
    await waitFor(() => expect(screen.queryByText("Dismiss")).toBeNull());

    // No additional API call was made by Dismiss.
    expect(mockAdminApi.mock.calls.length).toBe(callsBefore);

    // Page still shows question content.
    expect(
      screen.queryByText("What is the MITRE technique for PowerShell abuse?"),
    ).not.toBeNull();
  });
});
