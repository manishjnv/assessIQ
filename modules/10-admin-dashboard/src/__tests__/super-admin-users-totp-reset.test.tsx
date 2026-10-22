// RW-45 — "Reset two-factor" row action on the super-admin users page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const reset = vi.fn();

vi.mock("react-router", () => ({ useParams: () => ({ tenantId: "t-1" }), useNavigate: () => vi.fn() }));
vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
  disableUserApi: vi.fn(), reenableUserApi: vi.fn(), softDeleteUserApi: vi.fn(), restoreUserApi: vi.fn(), cancelInvitationApi: vi.fn(),
  superDisableUserApi: vi.fn(), superReenableUserApi: vi.fn(), superSoftDeleteUserApi: vi.fn(), superRestoreUserApi: vi.fn(), superCancelInvitationApi: vi.fn(),
  listTenantsApi: vi.fn().mockResolvedValue({ tenants: [{ id: "t-1", name: "Acme", status: "active" }] }),
  listTenantUsersAsSuperApi: vi.fn().mockResolvedValue({
    users: ["me", "other", "plain"].map((id) => ({ id, totp_enrolled: id !== "plain", email: `${id}@x.com`, name: id, role: "admin", status: "active", deleted_at: null, created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z" })),
    pending_invitations: [],
  }),
  superResetUserTotpApi: (...a: unknown[]) => reset(...a),
}));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("../session.js", () => ({
  useAdminSession: () => ({ session: { user: { id: "me" } }, loading: false }),
}));

import { SuperAdminUsers } from "../pages/super-admin-users.js";

afterEach(() => { cleanup(); reset.mockReset(); });

async function openMenu(email: string): Promise<void> {
  const row = (await screen.findByText(email)).closest("div[style*='grid']") as HTMLElement;
  const btn = row.querySelector("button"); // own row has no Manage menu at all
  if (btn) fireEvent.click(btn);
}

describe("SuperAdminUsers — Reset two-factor", () => {
  it("is absent on the signed-in super admin's own row", async () => {
    render(<SuperAdminUsers />);
    await openMenu("me@x.com");
    expect(screen.queryByText("Reset two-factor")).toBeNull();
  });

  it("is absent for a user without TOTP", async () => {
    render(<SuperAdminUsers />);
    await openMenu("plain@x.com");
    expect(screen.queryByText("Reset two-factor")).toBeNull();
  });

  it("requires a reason, then calls the endpoint with tenant, user and reason", async () => {
    reset.mockResolvedValue(undefined);
    render(<SuperAdminUsers />);
    await openMenu("other@x.com");
    fireEvent.click(screen.getByText("Reset two-factor"));
    fireEvent.click(screen.getByRole("button", { name: "Reset two-factor" }));
    expect(reset).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Lost phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset two-factor" }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith("t-1", "other", "Lost phone"));
  });
});
