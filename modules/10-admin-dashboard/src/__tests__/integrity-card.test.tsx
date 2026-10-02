// IntegrityCard: shows the saved switches, PATCHes only the integrity body, shows inline feedback.

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

import { IntegrityCard } from "../components/IntegrityCard.js";
import { AdminApiError } from "../api.js";

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("IntegrityCard", () => {
  it("preloads the saved switches and PATCHes the changed pair", async () => {
    adminApi.mockResolvedValue({});
    render(<IntegrityCard assessmentId="as-1" initial={{ fullscreen: true }} />);
    const fs = screen.getByLabelText("Require full screen") as HTMLInputElement;
    const cp = screen.getByLabelText("Block copy and paste") as HTMLInputElement;
    expect(fs.checked).toBe(true);
    expect(cp.checked).toBe(false);

    fireEvent.click(cp);
    fireEvent.click(screen.getByRole("button", { name: "Save integrity settings" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved"));
    expect(adminApi).toHaveBeenCalledWith("/admin/assessments/as-1/integrity", {
      method: "PATCH",
      body: JSON.stringify({ fullscreen: true, block_copy_paste: true }),
    });
  });

  it("shows the server error inline", async () => {
    adminApi.mockRejectedValue(new AdminApiError(404, { code: "NOT_FOUND", message: "Assessment not found" }));
    render(<IntegrityCard assessmentId="as-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Save integrity settings" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Assessment not found"));
  });
});
