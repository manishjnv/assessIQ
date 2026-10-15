// RW-91 — "Reset two-factor" row action for TENANT admins on the users page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const reset = vi.fn();
const sessionRole = vi.hoisted(() => ({ role: "admin" as string }));

vi.mock("react-router-dom", () => ({ useParams: () => ({}), useNavigate: () => vi.fn() }));
vi.mock("../api.js", () => ({
  adminApi: vi.fn().mockResolvedValue({
    items: [
      ["me", "admin", true],
      ["other", "admin", true],
      ["plain", "admin", false],
      ["boss", "super_admin", true],
    ].map(([id, role, totp]) => ({ id, role, totp_enrolled: totp, email: `${id}@x.com`, name: id, status: "active", deleted_at: null, created_at: "2026-05-01T00:00:00.000Z" })),
    total: 4, page: 1, pageSize: 20,
  }),
  AdminApiError: class AdminApiError extends Error {},
  disableUserApi: vi.fn(), reenableUserApi: vi.fn(), softDeleteUserApi: vi.fn(), restoreUserApi: vi.fn(), cancelInvitationApi: vi.fn(),
  exportUserDataApi: vi.fn(), eraseUserPiiApi: vi.fn(),
  resetUserTotpApi: (...a: unknown[]) => reset(...a),
  superResetUserTotpApi: vi.fn(),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../session.js", () => ({
  useAdminSession: () => ({ session: { user: { id: "me", role: sessionRole.role } }, loading: false }),
}));

import { AdminUsers } from "../pages/users.js";

afterEach(() => { cleanup(); reset.mockReset(); sessionRole.role = "admin"; });

async function openMenu(email: string): Promise<void> {
  const row = (await screen.findByText(email)).closest("div[style*='grid']") as HTMLElement;
  const btn = row.querySelector("button"); // own row has no Manage menu at all
  if (btn) fireEvent.click(btn);
}

describe("AdminUsers (tenant admin) — Reset two-factor", () => {
  it("shows the action for another enrolled admin and calls the tenant route with the reason", async () => {
    reset.mockResolvedValue(undefined);
    render(<AdminUsers />);
    await openMenu("other@x.com");
    fireEvent.click(screen.getByText("Reset two-factor"));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Lost phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset two-factor" }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith("other", "Lost phone"));
  });

  it("is hidden on the own row, for a user without TOTP and for a super admin target", async () => {
    render(<AdminUsers />);
    for (const email of ["me@x.com", "plain@x.com", "boss@x.com"]) {
      await openMenu(email);
      expect(screen.queryByText("Reset two-factor")).toBeNull();
    }
  });

  it("is hidden when the signed-in role is not admin", async () => {
    sessionRole.role = "super_admin";
    render(<AdminUsers />);
    await openMenu("other@x.com");
    expect(screen.queryByText("Reset two-factor")).toBeNull();
  });
});
