// Z-150 — a failed load shows "Could not load the counts." + Retry, never "No results.".
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    apiError: { code: string; message: string };
    constructor(_s: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
    }
  },
  getCompanyEntitlements: vi.fn(() => Promise.resolve([])),
  getCompanyUsage: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/UsageBanner.js", () => ({ UsageBanner: () => null }));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { email: "a@b.c", role: "admin" } } }) }));
vi.mock("@assessiq/help-system/components", () => ({ HelpTip: () => null }));
vi.mock("@assessiq/ui-system", () => ({
  Chip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
  StatCard: ({ label }: { label: string }) => React.createElement("div", null, label),
  Card: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  Icon: () => null,
  Table: ({ emptyMessage }: { emptyMessage: string }) => React.createElement("div", null, emptyMessage),
  Spinner: () => React.createElement("div", { role: "status" }, "Loading"),
  EmptyState: ({ title }: { title: string }) => React.createElement("div", null, title),
  ConfirmDialog: () => null,
  formatDate: (d: string) => d,
  formatDateTime: (d: string) => d,
  formatDayLine: () => "",
}));

import { adminApi } from "../api.js";
import { AdminDashboard } from "../pages/dashboard.js";
import { AdminGradingJobs } from "../pages/grading-jobs.js";

const mockApi = adminApi as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Z-150 error state", () => {
  it.each([["dashboard", AdminDashboard], ["grading-jobs", AdminGradingJobs]] as const)("%s", async (_n, Page) => {
    mockApi.mockRejectedValue(new Error("boom"));
    render(<MemoryRouter><Page /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Could not load the counts/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No results.")).toBeNull();
  });
});
