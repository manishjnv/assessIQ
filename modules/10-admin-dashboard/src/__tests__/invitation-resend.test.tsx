// AssessIQ — smoke tests for resending candidate invitations from the assessment
// detail page (2026-10-01).
//
//   R1  each row shows its status + "Expires <date>" / "Expired"; revoked rows are
//       labelled "revoked"; Resend is offered only where the server says
//       can_resend (never for a candidate who started)
//   R2  Resend on one row → POST /admin/invitations/:id/resend, then a "1 resent" chip
//   R3  "Resend to everyone who hasn't started (n)" → confirm dialog (count + old
//       links stop working) → POST /admin/assessments/:id/invitations/resend →
//       resent / skipped / still-to-send chips
//   R4  the bulk button is hidden when nothing is resendable
//   R5  a refused resend (409) shows the server's plain-English message

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

import { AdminApiError } from "../api.js";
import { AdminAssessmentDetail } from "../pages/assessment-detail.js";

const ID = "as-1";
const DAY = 86_400_000;

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

function row(id: string, name: string, over: Record<string, unknown>) {
  return {
    id,
    user_id: `u-${id}`,
    user_email: `${name.toLowerCase()}@example.com`,
    user_name: name,
    status: "pending",
    created_at: "2026-09-02T00:00:00.000Z",
    expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
    attempt_id: null,
    can_resend: true,
    ...over,
  };
}

const PENDING = row("inv-pending", "Priya", {});
const LAPSED = row("inv-lapsed", "Lena", { expires_at: new Date(Date.now() - DAY).toISOString() });
const REVOKED = row("inv-revoked", "Ravi", { status: "expired" });
const STARTED = row("inv-started", "Sana", {
  status: "started",
  attempt_id: "att-1",
  started_at: "2026-09-29T09:00:00.000Z",
  can_resend: false,
});

function mockApi(opts: { resendable?: number; items?: unknown[] } = {}): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === `/admin/assessments/${ID}` && !init?.method) return ASSESSMENT;
    if (path.startsWith(`/admin/assessments/${ID}/invitations`) && !init?.method) {
      const items = opts.items ?? [PENDING, LAPSED, REVOKED, STARTED];
      return { items, total: items.length, resendable: opts.resendable ?? 3 };
    }
    if (path.startsWith("/admin/users")) return { items: [] };
    if (path === "/admin/invitations/inv-pending/resend") return { ...PENDING, status: "pending" };
    if (path === `/admin/assessments/${ID}/invitations/resend`) {
      return { resent: 3, skipped: [{ id: "inv-x", code: "INVITATION_ALREADY_STARTED" }], remaining: 5 };
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

const posts = (path: string) =>
  adminApi.mock.calls.filter((c) => c[0] === path && (c[1] as RequestInit | undefined)?.method === "POST");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminAssessmentDetail — resend invitations", () => {
  it("R1 shows status + expiry per row and offers Resend only where the candidate has not started", async () => {
    mockApi();
    await renderPage();

    expect(await screen.findAllByText(/^Expires /)).toHaveLength(1); // the live pending link
    expect(screen.getByText("Expired")).toBeTruthy(); // the lapsed one
    expect(screen.getByText("revoked")).toBeTruthy(); // status 'expired' = admin revoke
    expect(screen.getByText("started")).toBeTruthy();

    const resendButtons = screen.getAllByRole("button", { name: /^Resend invitation to / });
    expect(resendButtons).toHaveLength(3); // pending, lapsed, revoked — NOT started
    expect(screen.queryByRole("button", { name: /Resend invitation to sana@example.com/ })).toBeNull();
    expect(screen.getByText("View attempt →")).toBeTruthy();
  });

  it("R2 Resend on a row POSTs to /admin/invitations/:id/resend and confirms with a chip", async () => {
    mockApi();
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Resend invitation to priya@example.com/ }));

    await screen.findByText("1 resent");
    expect(posts("/admin/invitations/inv-pending/resend")).toHaveLength(1);
  });

  it("R3 bulk: confirm dialog states the count + that old links stop working, then shows resent / skipped / still-to-send", async () => {
    mockApi({ resendable: 3 });
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Resend to everyone who hasn't started (3)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/emails will be sent/)).toBeTruthy();
    expect(within(dialog).getByText(/old links stop working/)).toBeTruthy();
    expect(posts(`/admin/assessments/${ID}/invitations/resend`)).toHaveLength(0); // nothing sent before Confirm

    fireEvent.click(within(dialog).getByRole("button", { name: "Send 3 emails" }));

    await screen.findByText("3 resent");
    expect(screen.getByText(/1 skipped:\s*already started/)).toBeTruthy();
    expect(screen.getByText(/5 more still to send/)).toBeTruthy();
    expect(posts(`/admin/assessments/${ID}/invitations/resend`)).toHaveLength(1);
  });

  it("R4 the bulk button is hidden when nothing is resendable", async () => {
    mockApi({ resendable: 0, items: [STARTED] });
    await renderPage();
    expect(screen.queryByRole("button", { name: /Resend to everyone/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resend invitation to / })).toBeNull();
  });

  it("R5 shows the server's message when a resend is refused", async () => {
    mockApi();
    await renderPage();
    const base = adminApi.getMockImplementation()!;
    adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/admin/invitations/inv-pending/resend") {
        throw new AdminApiError(409, {
          code: "CONFLICT",
          message: "This candidate has already started this assessment, so their invitation can't be resent.",
        });
      }
      return base(path, init);
    });

    fireEvent.click(await screen.findByRole("button", { name: /Resend invitation to priya@example.com/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/already started this assessment/);
  });
});
