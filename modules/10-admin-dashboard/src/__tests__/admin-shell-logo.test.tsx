// AssessIQ — AdminShell tenant logo (Logo phase L2): logo + "via AssessIQ" when
// the session carries logo_url; the tenant name only when it is null.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@assessiq/ui-system";
import React from "react";

const { sessionRef } = vi.hoisted(() => ({
  sessionRef: { logo_url: null as string | null },
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: {
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" },
      tenant: { id: "t1", slug: "acme", name: "Acme College", logo_url: sessionRef.logo_url },
      mfaStatus: "verified",
      totpEnrolled: true,
    },
    loading: false,
    error: null,
  }),
  adminLogout: vi.fn(),
}));

vi.mock("@assessiq/help-system/components", () => ({
  HelpProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HelpDrawerTrigger: () => null,
  useHelpContext: () => ({ page: 'admin.x', entries: new Map(), loading: false, drawerOpenKey: null, openDrawer: () => {}, closeDrawer: () => {} }),
}));

import { AdminShell } from "../components/AdminShell.js";

function renderShell(): void {
  render(
    <MemoryRouter>
      <ThemeProvider theme="light" density="cozy">
        <AdminShell breadcrumbs={["Dashboard"]}>
          <p>page content</p>
        </AdminShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AdminShell — tenant logo", () => {
  it("shows the logo (28 px) and the name, with no via AssessIQ caption, when logo_url is set", () => {
    sessionRef.logo_url = "/api/public/tenant-logo/t1?v=abc123abc123";
    const { container } = render(
      <MemoryRouter>
        <ThemeProvider theme="light" density="cozy">
          <AdminShell breadcrumbs={["Dashboard"]}>
            <p>page content</p>
          </AdminShell>
        </ThemeProvider>
      </MemoryRouter>,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/public/tenant-logo/t1?v=abc123abc123");
    expect(img.style.height).toBe("28px");
    // Name is visible next to the logo, so the logo alt is empty (no double read).
    expect(img.getAttribute("alt")).toBe("");
    expect(screen.getAllByText("Acme College").length).toBeGreaterThan(0);
    expect(screen.queryByText("via AssessIQ")).toBeNull();
  });

  it("sets the tab title to 'Org name · AssessIQ' and restores it on unmount", () => {
    sessionRef.logo_url = null;
    document.title = "AssessIQ";
    const { unmount } = render(
      <MemoryRouter>
        <ThemeProvider theme="light" density="cozy">
          <AdminShell breadcrumbs={["Dashboard"]}>
            <p>page content</p>
          </AdminShell>
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(document.title).toBe("Acme College · AssessIQ");
    unmount();
    expect(document.title).toBe("AssessIQ");
  });

  it("shows only the organisation name when logo_url is null", () => {
    sessionRef.logo_url = null;
    renderShell();
    expect(screen.queryByAltText("Acme College logo")).toBeNull();
    expect(screen.getAllByText("Acme College").length).toBeGreaterThan(0);
  });

  it("keeps the top bar, breadcrumbs and content inside landmarks (axe region)", () => {
    sessionRef.logo_url = null;
    render(
      <MemoryRouter>
        <ThemeProvider>
          <AdminShell breadcrumbs={["Home", "Page"]}><h1>Title</h1></AdminShell>
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });
});
