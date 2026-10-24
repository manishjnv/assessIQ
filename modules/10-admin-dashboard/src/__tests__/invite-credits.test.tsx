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
const MSG = "You need 20 credits. You have 10 available. Buy credits.";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const ASSESSMENT = {
  id: ID, name: "SOC Analyst L1", status: "active", pack_id: null, opens_at: null, closes_at: null,
  created_at: "2026-09-01T00:00:00.000Z", level_label: "L1", pack_name: "SOC Pack", delivery_mode: "real", camera_required: false,
};
const inv = (id: string, status: string, expires_at: string) => ({
  id, user_id: `x-${id}`, user_name: `Cand ${id}`, user_email: `${id}@x.com`, status, created_at: "2026-09-01T00:00:00.000Z", expires_at,
});
const ROWS = [
  inv("pend", "pending", FUTURE), inv("view", "viewed", FUTURE), inv("start", "started", FUTURE),
  inv("done", "submitted", FUTURE), inv("rev", "expired", FUTURE), inv("lapsed", "pending", PAST),
];
const USERS = [
  { id: "u-1", email: "ada@example.com", name: "Ada", role: "candidate", status: "active" },
  { id: "u-2", email: "bob@example.com", name: "Bob", role: "candidate", status: "active" },
];

function mockApi(refuse: boolean): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `/admin/assessments/${ID}` && !init?.method) return ASSESSMENT;
    if (path.startsWith(`/admin/assessments/${ID}/invitations`) && !init?.method) return { items: ROWS, total: ROWS.length, resendable: 0 };
    if (path.startsWith("/admin/users")) return { items: USERS };
    if (path === `/admin/assessments/${ID}/invite` && init?.method === "POST") {
      if (refuse) throw new AdminApiError(409, { code: "CREDITS_INSUFFICIENT", message: MSG, details: { code: "CREDITS_INSUFFICIENT", need: 40, available: 30, canInvite: 1, cost: 20 } });
      return { invited: 1, skipped: [] };
    }
    throw new Error(`unexpected adminApi call: ${init?.method ?? "GET"} ${path}`);
  });
}

async function renderPage(): Promise<void> {
  render(
    <MemoryRouter initialEntries={[`/admin/assessments/${ID}`]}>
      <Routes><Route path="/admin/assessments/:id" element={<AdminAssessmentDetail />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByText(/SOC Analyst L1/);
}

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("AdminAssessmentDetail - invite credit hold (Z-147)", () => {
  it("C1 shows the cost line with the free credits", async () => {
    getCompanyUsage.mockResolvedValue({ invite_limit: null, credits: { unlimited: false, available: 90 } });
    mockApi(false);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ada/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob/ }));
    expect((await screen.findByTestId("credit-cost-line")).textContent).toBe("2 students x 20 = 40 credits, you have 90 available");
  });

  it("C1b shows no cost line for an unlimited plan", async () => {
    getCompanyUsage.mockResolvedValue({ credits: { unlimited: true, available: 0 } });
    mockApi(false);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ada/ }));
    expect(screen.queryByTestId("credit-cost-line")).toBeNull();
  });

  it("C2 a credits refusal shows the message, Buy credits and Invite N now (trims the selection)", async () => {
    getCompanyUsage.mockResolvedValue({ credits: { unlimited: false, available: 30 } });
    mockApi(true);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "+ Invite candidates" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ada/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Invite 2 candidates$/ }));
    const box = await screen.findByTestId("credits-refusal");
    expect(box.textContent).toContain(MSG);
    expect(screen.getByRole("link", { name: "Buy credits" }).getAttribute("href")).toBe("/contact");
    fireEvent.click(screen.getByRole("button", { name: "Invite 1 now" }));
    expect(screen.queryByTestId("credits-refusal")).toBeNull();
    expect((screen.getByRole("checkbox", { name: /Ada/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Bob/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("C3 Held chip on pending, viewed and started rows only", async () => {
    getCompanyUsage.mockResolvedValue({});
    mockApi(false);
    await renderPage();
    expect((await screen.findAllByTestId("held-chip")).length).toBe(3);
  });
});
