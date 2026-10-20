// AssessIQ — Mock results page (Z-90): tiles from API data, and the empty state.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    apiError = { code: "x", message: "boom" };
  },
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));
vi.mock("@assessiq/ui-system", () => ({
  Spinner: () => React.createElement("div", { role: "status" }, "Loading"),
  EmptyState: ({ title, body }: { title: string; body: string }) =>
    React.createElement("div", null, React.createElement("p", null, title), React.createElement("p", null, body)),
}));

import { adminApi } from "../api.js";
import { AdminMockResults } from "../pages/mock-results.js";

const mockApi = adminApi as unknown as ReturnType<typeof vi.fn>;

function reply(summary: unknown) {
  mockApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/admin/mock/summary")) return { data: summary };
    if (path.startsWith("/admin/mock/topics")) {
      return { data: { topics: [], strongest: [{ topic: "Networking", attempts_graded: 4, correct_pct: 90 }], weakest: [{ topic: "General", attempts_graded: 4, correct_pct: 25 }] } };
    }
    if (path.startsWith("/admin/mock/students")) {
      return { data: [{ user_id: "u1", name: "Student One", mock_attempts: 2, avg_score_pct: 62.5, last_score_pct: 70, last_taken_at: "2026-10-01T10:00:00Z" }] };
    }
    if (path.startsWith("/admin/mock/trend")) return { data: [{ date: "2026-10-01", score_pct: 60, attempts: 2 }, { date: "2026-10-02", score_pct: 70, attempts: 1 }] };
    return { data: [] };
  });
}

describe("AdminMockResults", () => {
  beforeEach(() => { mockApi.mockReset(); });
  afterEach(cleanup);

  it("renders the tiles, topics, students and trend from API data", async () => {
    reply({ mock_attempts: 3, students: 2, completed_pct: 80, avg_score_pct: 65.5, by_assessment: [{ assessment_id: "a1", name: "Mock One", attempts: 3, avg_score_pct: 65.5, last_taken_at: null }] });
    render(<MemoryRouter><AdminMockResults /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("tile-attempts").textContent).toContain("3"));
    expect(screen.getByTestId("tile-students").textContent).toContain("2");
    expect(screen.getByTestId("tile-average").textContent).toContain("65.5%");
    expect(screen.getByTestId("tile-completed").textContent).toContain("80%");
    expect(screen.getByTestId("weak-topics").textContent).toContain("General");
    expect(screen.getByTestId("strong-topics").textContent).toContain("Networking");
    expect(screen.getByTestId("students-table").textContent).toContain("Student One");
    expect(screen.getByTestId("mock-trend-chart")).toBeTruthy();
  });

  it("shows the empty state when no mock test was taken", async () => {
    reply({ mock_attempts: 0, students: 0, completed_pct: 0, avg_score_pct: null, by_assessment: [] });
    render(<MemoryRouter><AdminMockResults /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("No mock tests have been taken yet.")).toBeTruthy());
    expect(screen.getByText("Invite candidates to a Mock test to see results here.")).toBeTruthy();
    expect(screen.queryByTestId("tile-attempts")).toBeNull();
  });
});
