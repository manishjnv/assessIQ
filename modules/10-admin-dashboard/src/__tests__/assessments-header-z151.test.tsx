// AssessIQ — Z-151 header of the admin Assessments page.
//
//   H1  "Send a test now" is a primary link to /admin/start-test
//   H2  "New assessment (advanced)" is an outline button (type=button) that
//       is not a link
//   H3  the count chip shows "N assessments" when the list is complete

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  getCompanyEntitlements: () => Promise.resolve({ entitlements: [] }),
  getCompanyUsage: () => Promise.resolve({}),
  createAssessmentFromSet: vi.fn(),
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

vi.mock("../components/UsageBanner.js", () => ({
  UsageBanner: () => null,
}));

vi.mock("../session.js", () => ({
  useAdminSession: () => ({ user: { id: "admin-1", role: "admin" }, tenantId: "t-1" }),
}));

// HelpTip needs a HelpProvider (AdminShell supplies it in the app).
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
  HelpProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AdminAssessments } from "../pages/assessments.js";

afterEach(cleanup);

function mockList(total: number, itemCount: number): void {
  const items = Array.from({ length: itemCount }, (_, i) => ({
    id: `as-${i}`,
    name: `Assessment ${i}`,
    status: "published",
    created_at: "2026-09-01T00:00:00.000Z",
  }));
  adminApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/admin/assessments?")) return { items, total };
    return { items: [], total: 0 };
  });
}

describe("Assessments header (Z-151)", () => {
  it("shows Send a test now (primary link) and New assessment (advanced) (outline button)", async () => {
    mockList(1, 1);
    render(
      <MemoryRouter>
        <AdminAssessments />
      </MemoryRouter>,
    );

    const send = await screen.findByRole("link", { name: "Send a test now" });
    expect(send.getAttribute("href")).toBe("/admin/start-test");
    expect(send.className).toContain("aiq-btn-primary");

    const advanced = screen.getByRole("button", { name: "New assessment (advanced)" });
    expect(advanced.getAttribute("type")).toBe("button");
    expect(advanced.className).toContain("aiq-btn-outline");
    expect(screen.queryByRole("link", { name: "Start a test" })).toBeNull();
  });

  it("count chip shows the plain count when the list is complete", async () => {
    mockList(2, 2);
    render(
      <MemoryRouter>
        <AdminAssessments />
      </MemoryRouter>,
    );
    expect(await screen.findByText("2 assessments")).toBeTruthy();
  });

  it("count chip shows showing N of M when the list is paged", async () => {
    mockList(250, 2);
    render(
      <MemoryRouter>
        <AdminAssessments />
      </MemoryRouter>,
    );
    expect(await screen.findByText("showing 2 of 250")).toBeTruthy();
  });
});
