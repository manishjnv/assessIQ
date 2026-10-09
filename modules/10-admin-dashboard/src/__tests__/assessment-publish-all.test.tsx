// AssessIQ — smoke test for "Publish all ready" on the assessment detail page
// (scoring / result-release, spec 2026-10-01 §5b — frontend half).
//
//   P1  confirm → POST /admin/assessments/:id/release-all, then the page shows
//       how many results were published and how many were skipped (and why)
//   P2  the button is hidden while the assessment has no attempts

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  getCompanyEntitlements: () => Promise.resolve({ entitlements: [] }),
  cancelAssessmentApi: vi.fn(),
  deleteAssessmentApi: vi.fn(),
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

// HelpTip needs a HelpProvider (AdminShell supplies it in the app).
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
  HelpProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AdminAssessmentDetail } from "../pages/assessment-detail.js";

const ID = "as-1";

const ASSESSMENT = {
  id: ID,
  name: "SOC Analyst L1",
  status: "published",
  pack_id: null,
  opens_at: null,
  closes_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  level_label: "L1",
  pack_name: "SOC Pack",
};

function invitation(withAttempt: boolean) {
  return {
    id: "inv-1",
    user_id: "u-1",
    user_email: "priya@example.com",
    user_name: "Priya Sharma",
    status: withAttempt ? "submitted" : "pending",
    created_at: "2026-09-02T00:00:00.000Z",
    expires_at: null,
    attempt_id: withAttempt ? "att-1" : null,
    started_at: withAttempt ? "2026-09-29T09:00:00.000Z" : null,
    submitted_at: withAttempt ? "2026-09-29T10:00:00.000Z" : null,
  };
}

function mockApi(withAttempt: boolean): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `/admin/assessments/${ID}` && !init?.method) return ASSESSMENT;
    if (path.startsWith(`/admin/assessments/${ID}/invitations`)) return { items: [invitation(withAttempt)], total: 1 };
    if (path.startsWith("/admin/users")) return { items: [] };
    if (path === `/admin/assessments/${ID}/release-all`) {
      return { released: ["att-1", "att-2"], skipped: [{ id: "att-3", code: "RESULT_NOT_READY" }] };
    }
    throw new Error(`unexpected adminApi call: ${init?.method ?? "GET"} ${path}`);
  });
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/admin/assessments/${ID}`]}>
      <Routes>
        <Route path="/admin/assessments/:id" element={<AdminAssessmentDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(/SOC Analyst L1/);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminAssessmentDetail — Release all ready", () => {
  it("P1 confirms, POSTs release-all and reports published / skipped counts", async () => {
    mockApi(true);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Release all ready" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/results can't be changed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Release all ready" }));

    await screen.findByText("Released 2 results");
    expect(screen.getByText(/Skipped 1:\s*not ready yet/)).toBeTruthy();

    const call = adminApi.mock.calls.find((c) => c[0] === `/admin/assessments/${ID}/release-all`);
    expect(call).toBeTruthy();
    expect((call?.[1] as RequestInit).method).toBe("POST");
  });

  it("P2 the button is hidden while there are no attempts", async () => {
    mockApi(false);
    await renderPage();
    expect(screen.queryByRole("button", { name: "Release all ready" })).toBeNull();
  });
});
