// SectionsCard: Edit disabled when attempts exist; 409 SECTIONS_LOCKED shown inline.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  listDomainsApi: () => Promise.resolve({ items: [] }),
  listCategoriesApi: () => Promise.resolve({ items: [] }),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(status: number, apiError: { code: string; message: string; details?: Record<string, unknown> }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
    }
  },
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => children,
}));

import { SectionsCard } from "../components/SectionsCard.js";
import { AdminApiError } from "../api.js";

const settings = { integrity: { fullscreen: true }, sections: [{ name: "Quant", question_count: 5, minutes: 10 }] };

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("SectionsCard", () => {
  it("shows no Edit sections button once published or started (summary only)", () => {
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit sections" })).toBeNull();
    expect(screen.getByText("Quant (10 min)")).toBeTruthy();
    cleanup();
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts isDraft onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit sections" })).toBeNull();
  });

  it("re-reads settings before saving (keeps sibling-card edits) and shows 409 SECTIONS_LOCKED inline", async () => {
    // Integrity was changed by IntegrityCard after page load; the stale prop still says fullscreen: true.
    const fresh = { ...settings, integrity: { fullscreen: false } };
    adminApi
      .mockResolvedValueOnce({ settings: fresh })
      .mockRejectedValueOnce(
        new AdminApiError(409, { code: "CONFLICT", message: "x", details: { code: "SECTIONS_LOCKED" } }),
      );
    const onSaved = vi.fn();
    render(<SectionsCard assessmentId="a1" settings={settings} hasAttempts={false} isDraft onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit sections" }));
    fireEvent.click(screen.getByRole("button", { name: "Save sections" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("after candidates have started"));
    expect(adminApi.mock.calls[0]).toEqual(["/admin/assessments/a1"]);
    const [path, init] = adminApi.mock.calls[1] as [string, { method: string; body: string }];
    expect(path).toBe("/admin/assessments/a1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ settings: fresh, question_count: 5 });
    expect(onSaved).not.toHaveBeenCalled();
  });
});
