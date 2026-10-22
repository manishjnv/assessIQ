// Z-22: /admin/attempts?assessmentId=<id> passes the filter to the API and shows a clearable chip.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  getReadiness: vi.fn(async () => ({ checks: {} })),
  verifyTotpApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    apiError = { code: "X", message: "x" };
  },
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

import { AdminAttempts } from "../pages/attempts.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  sessionStorage.clear();
  adminApi.mockResolvedValue({
    items: [{
      id: "t1", candidate_email: "a@b.c", candidate_name: "Ann", isErased: false,
      assessment_name: "SOC L1", level_label: "L1", status: "submitted",
      submitted_at: null, started_at: "2026-01-01T00:00:00Z",
    }],
    total: 1,
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("AdminAttempts assessment filter (Z-22)", () => {
  it("sends assessmentId, shows chip, clear removes it", async () => {
    render(
      <MemoryRouter initialEntries={[`/admin/attempts?assessmentId=${ID}`]}>
        <AdminAttempts />
      </MemoryRouter>,
    );
    await waitFor(() => expect(adminApi).toHaveBeenCalled());
    expect(adminApi.mock.calls[0]![0]).toContain(`assessmentId=${ID}`);
    expect(await screen.findByText(/Assessment: SOC L1/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Clear assessment filter"));
    await waitFor(() => expect(adminApi.mock.calls.at(-1)![0]).not.toContain("assessmentId"));
    expect(screen.queryByLabelText("Clear assessment filter")).toBeNull();
  });

  it("no param means no filter and no chip", async () => {
    render(<MemoryRouter initialEntries={["/admin/attempts"]}><AdminAttempts /></MemoryRouter>);
    await waitFor(() => expect(adminApi).toHaveBeenCalled());
    expect(adminApi.mock.calls[0]![0]).not.toContain("assessmentId");
    expect(screen.queryByLabelText("Clear assessment filter")).toBeNull();
  });
});
