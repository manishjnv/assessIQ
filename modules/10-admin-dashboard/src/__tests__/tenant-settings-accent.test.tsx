// AssessIQ — "Organisation colour" field on the tenant settings page (Z-119).
//   A1 a dark colour shows a preview and a "Readable" message; Save PATCHes the lowercase hex and fires aiq:accent
//   A2 a light colour shows the "Too light" message and Save is disabled (no API call)
//   A3 blank clears the colour (PATCH primary null)

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: vi.fn(),
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
vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: { user: { id: "u1", email: "a@x.com", name: "A", role: "admin" }, tenant: { id: "t1", slug: "acme", name: "Acme" }, mfaStatus: "verified" },
    loading: false,
  }),
  fetchAdminWhoami: vi.fn().mockResolvedValue(null),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

import { TenantSettings } from "../pages/tenant-settings.js";

const PATH = "/admin/tenant-settings/accent";

function mockApi(accent: string | null): void {
  adminApi.mockImplementation(async (path: string) => {
    if (path === "/admin/tenant-settings") return { retention_days: 730, result_release_mode: "manual", accent, logo: null };
    if (path.startsWith("/admin/erased-candidates")) return { items: [], total: 0 };
    if (path === PATH) return { primary: null, previous: null };
    throw new Error(`unexpected adminApi call: ${path}`);
  });
}
const accentCalls = (): unknown[][] => adminApi.mock.calls.filter((c) => c[0] === PATH);
const codeInput = (): HTMLInputElement => screen.getByLabelText("Colour code") as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("TenantSettings - Organisation colour", () => {
  it("A1 readable colour: preview, message, save sends lowercase hex and fires aiq:accent", async () => {
    mockApi(null);
    const seen: unknown[] = [];
    window.addEventListener("aiq:accent", (e) => seen.push((e as CustomEvent).detail), { once: true });
    render(<TenantSettings embedded />);
    await screen.findByLabelText("Colour code");
    fireEvent.change(codeInput(), { target: { value: "#3B4CCA" } });
    expect(screen.getByTestId("accent-preview")).toBeTruthy();
    expect(screen.getByTestId("accent-contrast").textContent).toContain("Readable");
    fireEvent.click(screen.getByRole("button", { name: "Save colour" }));
    await waitFor(() => expect(accentCalls()).toHaveLength(1));
    expect(accentCalls()[0]![1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ primary: "#3b4cca" }) });
    await waitFor(() => expect(seen).toEqual(["#3b4cca"]));
  });

  it("A2 light colour: 'Too light' message, Save disabled, no API call", async () => {
    mockApi(null);
    render(<TenantSettings embedded />);
    await screen.findByLabelText("Colour code");
    fireEvent.change(codeInput(), { target: { value: "#5eead4" } });
    expect(screen.getByTestId("accent-contrast").textContent).toContain("Too light");
    const btn = screen.getByRole("button", { name: "Save colour" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(accentCalls()).toHaveLength(0);
  });

  it("A3 blank clears the colour", async () => {
    mockApi("#3b4cca");
    render(<TenantSettings embedded />);
    await waitFor(() => expect(codeInput().value).toBe("#3b4cca"));
    fireEvent.change(codeInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save colour" }));
    await waitFor(() => expect(accentCalls()).toHaveLength(1));
    expect(accentCalls()[0]![1]).toMatchObject({ body: JSON.stringify({ primary: null }) });
  });
});
