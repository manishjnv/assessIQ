// Z-181: a draft assessment never shows the red "may not be entitled" pre-warning.
// The server rule (billing assertPublishEntitled) also accepts clone lineage and domain scope,
// which this page cannot see; a real refusal shows through publishError.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Routes, Route } from "react-router";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  getCompanyUsage: () => Promise.resolve({}),
  cancelAssessmentApi: vi.fn(),
  deleteAssessmentApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
  HelpProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AdminAssessmentDetail } from "../pages/assessment-detail.js";

const DRAFT = {
  id: "as-1",
  name: "Campus Placement Aptitude",
  status: "draft",
  pack_id: "pack-clone-1",
  opens_at: null,
  closes_at: null,
  created_at: "2026-11-01T00:00:00.000Z",
  level_label: "L1",
  pack_name: "Campus Placement Aptitude",
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("draft assessment entitlement hint (Z-181)", () => {
  it("shows the neutral note and no red warning for a cloned licensed set", async () => {
    adminApi.mockImplementation(async (path: string) => {
      if (path === "/admin/assessments/as-1") return DRAFT;
      if (path.startsWith("/admin/assessments/as-1/invitations")) return { items: [], total: 0 };
      if (path.startsWith("/admin/users")) return { items: [] };
      return {};
    });
    render(
      <MemoryRouter initialEntries={["/admin/assessments/as-1"]}>
        <Routes><Route path="/admin/assessments/:id" element={<AdminAssessmentDetail />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Only content your plan is entitled to is shown/)).toBeTruthy();
    expect(screen.queryByText(/may not be entitled/)).toBeNull();
  });
});
