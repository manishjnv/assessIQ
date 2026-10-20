// Z-21 — AdminShell help drawer (trigger, Ctrl+/, This page / Guide tabs) and the
// My account footer card. Uses the real help-system components with fetch stubbed.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@assessiq/ui-system";
import React from "react";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { enrolled: true } }));

vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: {
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" },
      tenant: { id: "t1", slug: "acme", name: "Acme College", logo_url: null },
      mfaStatus: "verified",
      totpEnrolled: sessionRef.enrolled,
    },
    loading: false,
    error: null,
  }),
  adminLogout: vi.fn(),
}));

import { AdminShell } from "../components/AdminShell.js";
import { openAdminGuide } from "../components/AdminHelp.js";

const ROWS: Record<string, Array<{ key: string; shortText: string; longMd: string | null }>> = {
  "admin.test.page": [
    { key: "admin.test.page.page", shortText: "About this page", longMd: "Page body text" },
    { key: "admin.test.page.save", shortText: "Save button", longMd: null },
  ],
  "admin.guide": [{ key: "admin.guide.step_1", shortText: "Step one title", longMd: "Step one body" }],
};

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const page = new URL(url, "http://x").searchParams.get("page") ?? "";
    return { ok: true, status: 200, json: async () => ROWS[page] ?? [] };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionRef.enrolled = true;
});

function renderShell(): void {
  render(
    <MemoryRouter>
      <ThemeProvider theme="light" density="cozy">
        <AdminShell breadcrumbs={["Test"]} helpPage="admin.test.page">
          <p>page content</p>
        </AdminShell>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("AdminShell — help drawer", () => {
  it("opens from the trigger and shows This page entries, then the Guide tab", async () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open help" }));
    expect(await screen.findByText("About this page")).toBeTruthy();
    expect(screen.getByText("Save button")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Guide" }));
    expect(await screen.findByText("Step one title")).toBeTruthy();
    expect(screen.getByText("Step one body")).toBeTruthy();
  });

  it("opens with Ctrl+/ and closes with Escape", async () => {
    renderShell();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    fireEvent.keyDown(document, { key: "/", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull());
  });

  it("openAdminGuide() opens the drawer on the Guide tab", async () => {
    renderShell();
    act(() => openAdminGuide());
    expect(await screen.findByText("Step one title")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Guide" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("AdminShell — My account footer", () => {
  it("shows 2FA On, Regenerate recovery codes and Sign out; no Help guide / Account security nav", () => {
    renderShell();
    const card = screen.getByRole("group", { name: "My account" });
    expect(card.textContent).toContain("On");
    expect(screen.getByText("Regenerate recovery codes")).toBeTruthy();
    expect(card.textContent).toContain("Sign out");
    // One place only: the account card holds Sign out and the email; the top bar has neither.
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    expect(card.textContent).toContain("admin@example.com");
    expect(screen.queryByText("Help guide")).toBeNull();
    expect(screen.queryByText("Account security")).toBeNull();
  });

  it("shows 2FA Off and the enrol action when not enrolled", () => {
    sessionRef.enrolled = false;
    renderShell();
    const card = screen.getByRole("group", { name: "My account" });
    expect(card.textContent).toContain("Off");
    expect(screen.getByText("Set up two-factor sign-in")).toBeTruthy();
    expect(screen.queryByText("Regenerate recovery codes")).toBeNull();
  });

  it("opens the regenerate dialog", () => {
    renderShell();
    fireEvent.click(screen.getByText("Regenerate recovery codes"));
    expect(screen.getByLabelText("Authenticator code")).toBeTruthy();
  });
});
