// AssessIQ — Phase C lifecycle UI tests (rounds 1–3 of 2026-05-21 fixes).
//
// Real DOM tests against AdminUsers using the super-context entry point so
// users can be injected without network mocking. Covers the three bugs the
// operator hit in production:
//
//   1. Filter chips must be mutually exclusive: turning on "Show disabled"
//      while "Show removed" was on must turn the other off, and vice versa.
//   2. The exclusive filter must actually FILTER the rendered rows — not
//      "include them in addition to active" (that was round-1's mistake).
//   3. Disabled rows must NOT use row-level `opacity` — that creates a
//      stacking context that traps the Manage dropdown's z-index. Visual
//      dimming must come from `color: var(--aiq-color-fg-muted)` instead.
//   4. The Manage dropdown must render via createPortal at document.body,
//      not inside the row — the table container uses `overflow: hidden` for
//      rounded corners and clips any in-tree absolutely-positioned panel.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Hoisted module mocks
// ---------------------------------------------------------------------------

vi.mock("react-router-dom", () => ({
  useParams: () => ({ tenantId: "tenant-x" }),
  useNavigate: () => vi.fn(),
}));

// The default lifecycle helpers are imported at module load. They are not
// reached in super-context mode, but the import must resolve.
vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string };
    constructor(status: number, apiError: { code: string; message: string }) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
  disableUserApi: vi.fn(),
  reenableUserApi: vi.fn(),
  softDeleteUserApi: vi.fn(),
  restoreUserApi: vi.fn(),
  cancelInvitationApi: vi.fn(),
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

// Import AFTER mocks
import { AdminUsers, type AdminUser, type UserLifecycleApiHandlers } from "../pages/users.js";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-05-01T00:00:00.000Z";

const USER_ACTIVE_ADMIN: AdminUser = {
  id: "u-active-admin",
  email: "admin@example.com",
  name: "Active Admin",
  role: "admin",
  status: "active",
  created_at: NOW,
  deleted_at: null,
};

const USER_DISABLED: AdminUser = {
  id: "u-disabled",
  email: "disabled@example.com",
  name: "Disabled User",
  role: "reviewer",
  status: "disabled",
  created_at: NOW,
  deleted_at: null,
};

const USER_REMOVED: AdminUser = {
  id: "u-removed",
  email: "removed@example.com",
  name: "Removed User",
  role: "reviewer",
  status: "active",
  created_at: NOW,
  deleted_at: "2026-05-10T00:00:00.000Z",
};

const NOOP_HANDLERS: UserLifecycleApiHandlers = {
  disable: vi.fn(),
  reenable: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  cancelInvitation: vi.fn(),
};

function renderWithSuperContext(): { onRefetch: ReturnType<typeof vi.fn> } {
  const onRefetch = vi.fn();
  render(
    <AdminUsers
      superContext={{
        tenantId: "tenant-x",
        tenantName: "Tenant X",
        tenantStatus: "active",
        lifecycleHandlers: NOOP_HANDLERS,
        users: [USER_ACTIVE_ADMIN, USER_DISABLED, USER_REMOVED],
        pendingInvitations: [],
        loading: false,
        fetchError: null,
        onRefetch,
      }}
    />,
  );
  return { onRefetch };
}

// Find the data row containing the given email; throws if not found.
function rowForEmail(email: string): HTMLElement {
  const emailNode = screen.getByText(email);
  // Walk up to the grid-row container (the immediate child of the table div).
  let el: HTMLElement | null = emailNode;
  while (el !== null) {
    const style = el.getAttribute("style") ?? "";
    if (style.includes("display: grid") && style.includes("grid-template-columns")) {
      return el;
    }
    el = el.parentElement;
  }
  throw new Error(`row container for ${email} not found`);
}

// ---------------------------------------------------------------------------
// Bug 1+2 — exclusive filter semantics
// ---------------------------------------------------------------------------

describe("Phase C users page — filter semantics", () => {
  it("default view shows active + pending only (no disabled, no removed)", () => {
    renderWithSuperContext();
    expect(screen.queryByText("admin@example.com")).not.toBeNull();
    expect(screen.queryByText("disabled@example.com")).toBeNull();
    expect(screen.queryByText("removed@example.com")).toBeNull();
  });

  it("clicking 'Show disabled users' switches to disabled-only view", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show disabled users"));
    // Disabled row is now visible; active and removed are filtered out.
    expect(screen.queryByText("disabled@example.com")).not.toBeNull();
    expect(screen.queryByText("admin@example.com")).toBeNull();
    expect(screen.queryByText("removed@example.com")).toBeNull();
    // Label reflects the new state.
    expect(screen.queryByText("Showing disabled only")).not.toBeNull();
  });

  it("clicking 'Show removed users' switches to removed-only view", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show removed users"));
    expect(screen.queryByText("removed@example.com")).not.toBeNull();
    expect(screen.queryByText("admin@example.com")).toBeNull();
    expect(screen.queryByText("disabled@example.com")).toBeNull();
    expect(screen.queryByText("Showing removed only")).not.toBeNull();
  });

  it("turning on 'Show removed' while 'Show disabled' is on turns disabled off (mutual exclusion)", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show disabled users"));
    expect(screen.queryByText("Showing disabled only")).not.toBeNull();
    // Now flip to removed
    fireEvent.click(screen.getByText("Show removed users"));
    // Disabled chip is back to OFF label, removed chip is ON
    expect(screen.queryByText("Showing disabled only")).toBeNull();
    expect(screen.queryByText("Show disabled users")).not.toBeNull();
    expect(screen.queryByText("Showing removed only")).not.toBeNull();
    // And the rendered list is now removed-only, not "disabled + removed"
    expect(screen.queryByText("removed@example.com")).not.toBeNull();
    expect(screen.queryByText("disabled@example.com")).toBeNull();
  });

  it("filter chips are real <button type=button> for full hit-target", () => {
    renderWithSuperContext();
    const chip = screen.getByText("Show disabled users");
    // The chip text node is inside a <button>
    let el: HTMLElement | null = chip;
    let foundButton = false;
    while (el !== null) {
      if (el.tagName === "BUTTON" && el.getAttribute("type") === "button") {
        foundButton = true;
        break;
      }
      el = el.parentElement;
    }
    expect(foundButton).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug 3 — row dimming must not use opacity (stacking context trap)
// ---------------------------------------------------------------------------

describe("Phase C users page — row dimming", () => {
  it("disabled row does NOT set opacity on the row element", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show disabled users"));
    const row = rowForEmail("disabled@example.com");
    const style = row.getAttribute("style") ?? "";
    // Round-1 used opacity: 0.75 — that re-creates the stacking-context bug.
    expect(style).not.toMatch(/opacity\s*:\s*0\.7/);
    expect(style).not.toMatch(/opacity\s*:\s*0\.6/);
  });

  it("removed row does NOT set opacity on the row element either", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show removed users"));
    const row = rowForEmail("removed@example.com");
    const style = row.getAttribute("style") ?? "";
    expect(style).not.toMatch(/opacity\s*:\s*0/);
  });
});

// ---------------------------------------------------------------------------
// Bug 4 — Manage dropdown renders via createPortal at document.body
// ---------------------------------------------------------------------------

describe("Phase C users page — Manage dropdown portal", () => {
  it("clicking Manage on the disabled row opens a panel that is a child of <body>, not inside the row", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show disabled users"));
    const row = rowForEmail("disabled@example.com");
    // Click the Manage button inside this row
    const manageBtn = within(row).getByText(/Manage/i);
    fireEvent.click(manageBtn);

    // The dropdown panel contains a "Re-enable user" item — find it.
    const reenable = screen.getByText("Re-enable user");

    // Walk up from the menu item to find the floating panel container.
    // The panel has position:fixed in its inline style — that is the marker
    // of the portal placement and distinguishes it from the trigger wrapper.
    let panel: HTMLElement | null = reenable;
    while (panel !== null) {
      const style = panel.getAttribute("style") ?? "";
      if (style.includes("position: fixed")) break;
      panel = panel.parentElement;
    }
    expect(panel).not.toBeNull();

    // The panel must NOT be a descendant of the row — that is the whole
    // point of the portal (escape overflow:hidden on the table container).
    expect(row.contains(panel)).toBe(false);

    // And it MUST be a descendant of document.body (the portal target).
    expect(document.body.contains(panel)).toBe(true);
  });

  it("the dropdown panel uses position:fixed (not the in-tree absolute)", () => {
    renderWithSuperContext();
    fireEvent.click(screen.getByText("Show disabled users"));
    const row = rowForEmail("disabled@example.com");
    fireEvent.click(within(row).getByText(/Manage/i));
    const reenable = screen.getByText("Re-enable user");
    let el: HTMLElement | null = reenable;
    let foundFixed = false;
    while (el !== null) {
      const style = el.getAttribute("style") ?? "";
      if (style.includes("position: fixed")) {
        foundFixed = true;
        break;
      }
      el = el.parentElement;
    }
    expect(foundFixed).toBe(true);
  });
});
