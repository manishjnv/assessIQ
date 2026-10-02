// RemindersCard: shows saved state, PATCHes only the reminders body, shows inline feedback.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { RemindersCard } from "../components/RemindersCard.js";
import { AdminApiError } from "../api.js";

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("RemindersCard", () => {
  it("defaults to off, enables, and PATCHes enabled + hours_before", async () => {
    adminApi.mockResolvedValue({});
    render(<RemindersCard assessmentId="as-1" />);
    const on = screen.getByLabelText("Send automatic reminders") as HTMLInputElement;
    expect(on.checked).toBe(false);
    expect((screen.getByLabelText("Hours before the deadline") as HTMLSelectElement).disabled).toBe(true);

    fireEvent.click(on);
    fireEvent.change(screen.getByLabelText("Hours before the deadline"), { target: { value: "48" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder settings" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
    expect(adminApi).toHaveBeenCalledWith("/admin/assessments/as-1/reminders", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, hours_before: 48 }),
    });
  });

  it("preloads saved values and shows the server error inline", async () => {
    adminApi.mockRejectedValue(new AdminApiError(404, { code: "NOT_FOUND", message: "Assessment not found" }));
    render(<RemindersCard assessmentId="as-1" initial={{ enabled: true, hours_before: 72 }} />);
    expect((screen.getByLabelText("Send automatic reminders") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Hours before the deadline") as HTMLSelectElement).value).toBe("72");
    fireEvent.click(screen.getByRole("button", { name: "Save reminder settings" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Assessment not found"));
  });
});
