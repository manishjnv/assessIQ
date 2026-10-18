// Z-22 #2 (dashboard -> assessments ?new=1) and #3 (reports candidate search).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

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
  createAssessmentFromSet: vi.fn(),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../components/UsageBanner.js", () => ({ UsageBanner: () => null }));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { email: "a@b.c", role: "admin" } } }) }));
vi.mock("@assessiq/help-system/components", () => ({ HelpTip: () => null }));
vi.mock("../pages/assessments/FromSetPicker.js", () => ({ FromSetPicker: () => null }));
vi.mock("../pages/assessments/BlueprintBuilder.js", () => ({ BlueprintBuilder: () => null }));
vi.mock("../pages/assessments/PreviewAdequacy.js", () => ({ PreviewAdequacy: () => null }));
vi.mock("../pages/SectionsEditor.js", () => ({ SectionsEditor: () => null, buildSections: () => [] }));
vi.mock("@assessiq/ui-system", () => ({
  Chip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
  StatCard: () => null,
  Table: () => null,
  Spinner: () => React.createElement("div", { role: "status" }, "Loading"),
  EmptyState: ({ title }: { title: string }) => React.createElement("div", null, title),
  formatDate: (d: string) => d,
  formatDateTime: (d: string) => d,
  formatDayLine: () => "",
}));

import { adminApi } from "../api.js";
import { AdminDashboard } from "../pages/dashboard.js";
import { AdminAssessments } from "../pages/assessments.js";
import { AdminReports } from "../pages/reports.js";

const mockApi = adminApi as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function Loc(): React.ReactElement {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

describe("Z-22 #2 — New assessment opens the create form", () => {
  it("dashboard button navigates to /admin/assessments?new=1", async () => {
    mockApi.mockResolvedValue({ items: [], counts: { in_queue: 0, awaiting_evaluation: 0, ready_to_publish: 0 } });
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/assessments" element={<Loc />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New assessment" }));
    expect((await screen.findByTestId("loc")).textContent).toBe("/admin/assessments?new=1");
  });

  it("assessments page opens the form on ?new=1 and clears the param", async () => {
    mockApi.mockResolvedValue({ items: [], total: 0 });
    render(
      <MemoryRouter initialEntries={["/admin/assessments?new=1"]}>
        <Routes>
          <Route path="/admin/assessments" element={<><AdminAssessments /><Loc /></>} />
        </Routes>
      </MemoryRouter>,
    );
    // Open form shows the toggle as "Cancel"
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeDefined();
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/admin/assessments"));
  });
});

describe("Z-22 #3 — reports candidate search", () => {
  const route = (url: string) => {
    if (url.startsWith("/admin/users")) {
      return Promise.resolve({ items: [{ id: "u-1", email: "ann@x.io", name: "Ann" }] });
    }
    return Promise.resolve({ items: [], total: 0 });
  };

  it("debounces, queries /admin/users?search=, and links to the individual report", async () => {
    mockApi.mockImplementation(route);
    render(<MemoryRouter><AdminReports /></MemoryRouter>);
    vi.useFakeTimers();
    const input = screen.getByRole("searchbox", { name: "Find a candidate" });
    fireEvent.change(input, { target: { value: "ann" } });
    expect(mockApi.mock.calls.some((c) => String(c[0]).startsWith("/admin/users"))).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    vi.useRealTimers();
    const link = await screen.findByRole("link", { name: /Ann/ });
    expect(link.getAttribute("href")).toBe("/admin/reports/individual/u-1");
    const call = mockApi.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith("/admin/users"));
    expect(call).toContain("search=ann");
  });

  it("shows an empty state when nothing matches", async () => {
    mockApi.mockImplementation((url: string) =>
      url.startsWith("/admin/users") ? Promise.resolve({ items: [] }) : Promise.resolve({ items: [], total: 0 }));
    render(<MemoryRouter><AdminReports /></MemoryRouter>);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a candidate" }), { target: { value: "zzz" } });
    expect(await screen.findByText("No candidates found.", {}, { timeout: 2000 })).toBeDefined();
  });

  it("shows the API error message on failure", async () => {
    const { AdminApiError } = await import("../api.js");
    mockApi.mockImplementation((url: string) =>
      url.startsWith("/admin/users")
        ? Promise.reject(new AdminApiError(500, { code: "X", message: "Search is down." }))
        : Promise.resolve({ items: [], total: 0 }));
    render(<MemoryRouter><AdminReports /></MemoryRouter>);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a candidate" }), { target: { value: "ann" } });
    expect(await screen.findByText("Search is down.", {}, { timeout: 2000 })).toBeDefined();
  });
});
