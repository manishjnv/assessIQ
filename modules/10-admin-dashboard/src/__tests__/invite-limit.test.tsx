// AssessIQ — EXP-37 students-per-assessment limit on the invite dialog (2026-10-23).
//
//   L1  invite_limit is a number → the dialog shows "This setup supports up to N students…"
//   L2  invite_limit is null → no limit note in the dialog
//   L3  a refused invite (409 INVITE_LIMIT_EXCEEDED) shows the server's full sentence in the dialog

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router";

const { adminApi, getCompanyUsage } = vi.hoisted(() => ({
  adminApi: vi.fn(),
  getCompanyUsage: vi.fn(),
}));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  getCompanyUsage: (...a: unknown[]) => getCompanyUsage(...a),
  getCompanyEntitlements: () => Promise.resolve({ entitlements: [] }),
  cancelAssessmentApi: vi.fn(),
  deleteAssessmentApi: vi.fn(),
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

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

// HelpTip needs a HelpProvider (AdminShell supplies it in the app).
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
  HelpProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AdminApiError } from "../api.js";
import { AdminAssessmentDetail } from "../pages/assessment-detail.js";

const ID = "as-1";
const REFUSAL =
  "This setup allows up to 150 students for one assessment. You are adding 10 and 145 are already invited. Split the students into two assessments, or contact support.";

const ASSESSMENT = {
  id: ID,
  name: "SOC Analyst L1",
  status: "active",
  pack_id: null,
  opens_at: null,
  closes_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  level_label: "L1",
  pack_name: "SOC Pack",
};

function mockApi(inviteFails: boolean): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `/admin/assessments/${ID}` && !init?.method) return ASSESSMENT;
    if (path.startsWith(`/admin/assessments/${ID}/invitations`) && !init?.method) {
      return { items: [], total: 0, resendable: 0 };
    }
    if (path.startsWith("/admin/users")) {
      return { items: [{ id: "u-1", email: "ada@example.com", name: "Ada", role: "candidate", status: "active" }] };
    }
    if (path === `/admin/assessments/${ID}/invite` && init?.method === "POST") {
      if (inviteFails) {
        throw new AdminApiError(409, { code: "INVITE_LIMIT_EXCEEDED", message: REFUSAL, details: { limit: 150, active: 145, adding: 10 } });
      }
      return { invited: 1, skipped: [] };
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

async function openInviteDialogAndPickOne(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Ada/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Invite 1 candidate$/ }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminAssessmentDetail — students per assessment limit (EXP-37)", () => {
  it("L1 shows the limit note in the invite dialog when invite_limit is a number", async () => {
    getCompanyUsage.mockResolvedValue({ invite_limit: 150 });
    mockApi(false);
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
    expect(
      await screen.findByText("This setup supports up to 150 students for one assessment."),
    ).toBeTruthy();
  });

  it("L2 shows no limit note when invite_limit is null", async () => {
    getCompanyUsage.mockResolvedValue({ invite_limit: null });
    mockApi(false);
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
    await screen.findByRole("checkbox", { name: /Ada/ });
    expect(screen.queryByText(/This setup supports up to/)).toBeNull();
  });

  it("L3 shows the server's refusal sentence in the dialog error area", async () => {
    getCompanyUsage.mockResolvedValue({ invite_limit: 150 });
    mockApi(true);
    await renderPage();

    await openInviteDialogAndPickOne();
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(adminApi.mock.calls.filter((c) => c[0] === `/admin/assessments/${ID}/invite`)).toHaveLength(1);
  });
});
