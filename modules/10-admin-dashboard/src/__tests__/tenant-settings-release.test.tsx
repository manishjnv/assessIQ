// AssessIQ — tests for the "Result release" section of the tenant settings page
// (scoring / result-release, spec 2026-10-01 SP2 — frontend half).
//
//   R1  loads the saved mode; Manual is the default, Save starts disabled
//   R2  picking Automatic enables Save; PATCH {mode:'auto'}; success feedback
//   R3  a fresh-MFA 401 opens the inline MFA step-up and retries the save
//   R4  other errors are shown and leave the choice unsaved
//   R5  an older API without result_release_mode starts with nothing selected
//   R6  the section carries its help id

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";

const { adminApi, verifyTotpApi } = vi.hoisted(() => ({
  adminApi: vi.fn(),
  verifyTotpApi: vi.fn(),
}));

vi.mock("../api.js", () => ({
  adminApi: (...a: unknown[]) => adminApi(...a),
  verifyTotpApi: (...a: unknown[]) => verifyTotpApi(...a),
  AdminApiError: class AdminApiError extends Error {
    status: number;
    apiError: { code: string; message: string; details?: Record<string, unknown> };
    constructor(
      status: number,
      apiError: { code: string; message: string; details?: Record<string, unknown> },
    ) {
      super(apiError.message);
      this.status = status;
      this.apiError = apiError;
      this.name = "AdminApiError";
    }
  },
}));

vi.mock("../session.js", () => ({
  useAdminSession: () => ({
    session: {
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" },
      tenant: { id: "t1", slug: "acme", name: "Acme College" },
      mfaStatus: "verified",
    },
    loading: false,
  }),
  fetchAdminWhoami: vi.fn().mockResolvedValue(null),
}));

vi.mock("../components/AdminShell.js", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "admin-shell" }, children),
}));

// Import AFTER mocks
import { AdminApiError } from "../api.js";
import { TenantSettings } from "../pages/tenant-settings.js";

const PATCH_PATH = "/admin/tenant-settings/result-release-mode";

/** Routes the page's GETs; PATCH behaviour is supplied per test. */
function mockApi(opts: {
  mode?: "manual" | "auto" | undefined;
  patch?: (init: RequestInit | undefined) => Promise<unknown>;
}): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/admin/tenant-settings") {
      return {
        retention_days: 730,
        updated_at: "2026-09-01T00:00:00.000Z",
        ...(opts.mode !== undefined ? { result_release_mode: opts.mode } : {}),
      };
    }
    if (path.startsWith("/admin/erased-candidates")) return { items: [], total: 0 };
    if (path === PATCH_PATH) return (opts.patch ?? (async () => ({})))(init);
    throw new Error(`unexpected adminApi call: ${path}`);
  });
}

const patchCalls = (): Array<[string, RequestInit]> =>
  adminApi.mock.calls.filter((c) => c[0] === PATCH_PATH) as Array<[string, RequestInit]>;

const radio = (name: RegExp): HTMLInputElement =>
  screen.getByRole("radio", { name }) as HTMLInputElement;
const saveBtn = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Save result release" }) as HTMLButtonElement;

/** Waits for the settings GET to finish (radios render only after the load). */
async function renderLoaded(): Promise<void> {
  render(<TenantSettings embedded />);
  await screen.findByRole("radio", { name: /Manual/ });
}

beforeEach(() => {
  verifyTotpApi.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("TenantSettings — Result release", () => {
  it("R1 loads the saved mode: Manual (default) selected, Save disabled, plain-language options", async () => {
    mockApi({ mode: "manual" });
    await renderLoaded();

    expect(radio(/Manual/).checked).toBe(true);
    expect(radio(/Automatic/).checked).toBe(false);
    expect(saveBtn().disabled).toBe(true);

    expect(screen.getByText(/You release each result yourself/)).toBeTruthy();
    expect(screen.getByText(/Results are released as soon as they are complete/)).toBeTruthy();
    expect(screen.getByText(/Switching to Automatic does not release results that are already waiting/)).toBeTruthy();
  });

  it("R2 picking Automatic enables Save; saving PATCHes {mode:'auto'} and confirms", async () => {
    mockApi({ mode: "manual" });
    await renderLoaded();

    fireEvent.click(radio(/Automatic/));
    expect(radio(/Automatic/).checked).toBe(true);
    expect(saveBtn().disabled).toBe(false);

    fireEvent.click(saveBtn());
    await screen.findByText("Results now release automatically.");

    const calls = patchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ mode: "auto" });

    // Saved: still Automatic, nothing left to save.
    expect(radio(/Automatic/).checked).toBe(true);
    expect(saveBtn().disabled).toBe(true);
  });

  it("R3 a fresh-MFA 401 opens the inline step-up, then retries the save", async () => {
    let first = true;
    mockApi({
      mode: "manual",
      patch: async () => {
        if (first) {
          first = false;
          throw new AdminApiError(401, { code: "UNAUTHENTICATED", message: "fresh totp required" });
        }
        return {};
      },
    });
    await renderLoaded();

    fireEvent.click(radio(/Automatic/));
    fireEvent.click(saveBtn());

    // Step-up appears in place; the picked option is kept.
    await screen.findByText(/needs a fresh authenticator check/);
    expect(radio(/Automatic/).checked).toBe(true);
    expect(patchCalls()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & save" }));

    await screen.findByText("Results now release automatically.");
    expect(verifyTotpApi).toHaveBeenCalledWith("123456");
    expect(patchCalls()).toHaveLength(2);
    expect(screen.queryByText(/needs a fresh authenticator check/)).toBeNull();
  });

  it("R4 other errors are shown and the choice stays unsaved", async () => {
    mockApi({
      mode: "manual",
      patch: async () => {
        throw new AdminApiError(500, { code: "INTERNAL", message: "Could not save right now." });
      },
    });
    await renderLoaded();

    fireEvent.click(radio(/Automatic/));
    fireEvent.click(saveBtn());

    const alert = await screen.findByText("Could not save right now.");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(saveBtn().disabled).toBe(false); // still dirty — can retry
    expect(screen.queryByText("Results now release automatically.")).toBeNull();
  });

  it("R5 an API without result_release_mode starts with nothing selected", async () => {
    mockApi({ mode: undefined });
    await renderLoaded();

    expect(radio(/Manual/).checked).toBe(false);
    expect(radio(/Automatic/).checked).toBe(false);
    expect(saveBtn().disabled).toBe(true);

    fireEvent.click(radio(/Manual/));
    expect(saveBtn().disabled).toBe(false);
  });

  it("R6 the section carries its help id and a labelled radio group", async () => {
    mockApi({ mode: "auto" });
    await renderLoaded();

    const section = document.querySelector('[data-help-id="admin.tenant_settings.result_release_mode"]');
    expect(section).not.toBeNull();
    expect(radio(/Automatic/).checked).toBe(true);

    const group = within(section as HTMLElement).getByRole("group", {
      name: /When do candidates receive their results/,
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
  });
});
