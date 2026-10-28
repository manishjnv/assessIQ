// UAT 2026-10-29 (Option A): the org admin sees the organisation code and a copyable student sign-in link.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { adminApi } = vi.hoisted(() => ({ adminApi: vi.fn() }));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
}));
vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: {
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" },
      tenant: { id: "t1", slug: "flux-point", name: "FluxPoint Ltd" },
      mfaStatus: "verified",
    },
    loading: false,
  }),
  fetchAdminWhoami: vi.fn().mockResolvedValue(null),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));

import { TenantSettings } from "../pages/tenant-settings.js";

afterEach(() => {
  cleanup();
  adminApi.mockReset();
});

describe("Organisation code block", () => {
  it("shows the code and the sign-in link, read only, and copies the link", async () => {
    adminApi.mockImplementation(async (path: string) => {
      if (path === "/admin/tenant-settings") return { retention_days: 730, updated_at: "2026-09-01T00:00:00.000Z", result_release_mode: "manual", logo: null };
      if (path.startsWith("/admin/erased-candidates")) return { items: [], total: 0 };
      throw new Error(`unexpected adminApi call: ${path}`);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<TenantSettings embedded />);
    const code = (await screen.findByLabelText("Organisation code")) as HTMLInputElement;
    expect(code.value).toBe("flux-point");
    expect(code.readOnly).toBe(true);
    const link = screen.getByLabelText("Student sign-in link") as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/candidate/login?tenant=flux-point`);
    expect(document.querySelector('[data-help-id="admin.tenant_settings.org_code"]')).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.value));
  });
});
