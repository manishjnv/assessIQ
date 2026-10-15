// RW-57 part 2: Curriculum frameworks section on the Platform page.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const list = vi.fn();
const load = vi.fn();
let role = "super_admin";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {},
  resendInvitationApi: vi.fn(),
  listTenantsApi: vi.fn().mockResolvedValue({ tenants: [] }),
  suspendTenantApi: vi.fn(), resumeTenantApi: vi.fn(), archiveTenantApi: vi.fn(), unarchiveTenantApi: vi.fn(),
}));
vi.mock("../api/frameworks.js", () => ({
  listFrameworkSeedsApi: (...a: unknown[]) => list(...a),
  loadFrameworkSeedApi: (...a: unknown[]) => load(...a),
}));
vi.mock("../session.js", () => ({ useAdminSession: () => ({ session: { user: { id: "u", role } }, loading: false }) }));
vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}));
vi.mock("@assessiq/help-system/components", () => ({
  HelpTip: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));
vi.mock("../pages/platform/CreateCompanyForm.js", () => ({ CreateCompanyForm: () => null }));
vi.mock("../pages/platform/EditAdminModal.js", () => ({ EditAdminModal: () => null }));
vi.mock("../pages/platform/BillingDrawer.js", () => ({ BillingDrawer: () => null }));
vi.mock("../pages/platform/ManageMenu.js", () => ({ ManageMenu: () => null }));
vi.mock("../pages/platform/PlatformDomainsSection.js", () => ({ PlatformDomainsSection: () => null }));
vi.mock("../pages/platform/BackgroundJobsSection.js", () => ({ BackgroundJobsSection: () => null }));
vi.mock("../pages/platform/LifecycleConfirmModal.js", () => ({
  LifecycleConfirmModal: () => null,
  LIFECYCLE_COPY: { suspend: { verb: "Suspended" }, resume: { verb: "Resumed" }, archive: { verb: "Archived" }, unarchive: { verb: "Unarchived" } },
}));

import { AdminPlatform } from "../pages/platform.js";

const SEEDS = [
  { code: "cbse", name: "CBSE (NCERT)", board: "CBSE", version: "NCERT rationalised 2023-24", nodeCount: 335, loadedVersion: null },
  { code: "ib", name: "International Baccalaureate", board: "IB", version: "IB 2020", nodeCount: 89, loadedVersion: "IB 2020" },
];

afterEach(() => { cleanup(); list.mockReset(); load.mockReset(); role = "super_admin"; });

describe("Platform curriculum frameworks section", () => {
  it("lists the bundled seeds and loads one after confirm", async () => {
    list.mockResolvedValue({ items: SEEDS });
    load.mockResolvedValue({ frameworks: 1, nodesCreated: 335, nodesUpdated: 0, nodesUnchanged: 0 });
    render(<AdminPlatform />);
    expect(await screen.findByText("CBSE (NCERT)")).toBeTruthy();
    expect(screen.getByText("International Baccalaureate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(load).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Load")!);
    await waitFor(() => expect(load).toHaveBeenCalledWith("cbse"));
    expect(await screen.findByText(/335 added, 0 updated, 0 unchanged/)).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("is absent for a tenant admin", async () => {
    role = "admin";
    list.mockResolvedValue({ items: SEEDS });
    render(<AdminPlatform />);
    await waitFor(() => expect(screen.queryByText("Curriculum frameworks.")).toBeNull());
    expect(list).not.toHaveBeenCalled();
  });
});
