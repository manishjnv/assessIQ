// AssessIQ — tests for the "Candidate answer key" switch on the tenant settings page (Z-172).
//
//   C1  loads the saved value (off by default); Save starts disabled; help id is on the section
//   C2  turning it on enables Save; PATCH {enabled:true}; success feedback
//   C3  a fresh-MFA 401 opens the step-up and retries the save

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

import { AdminApiError } from "../api.js";
import { TenantSettings } from "../pages/tenant-settings.js";

const PATCH_PATH = "/admin/tenant-settings/candidate-answer-key";

function mockApi(opts: { on?: boolean; patch?: (init: RequestInit | undefined) => Promise<unknown> }): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/admin/tenant-settings") {
      return {
        retention_days: 730,
        updated_at: "2026-09-01T00:00:00.000Z",
        result_release_mode: "manual",
        candidate_answer_key: opts.on === true,
      };
    }
    if (path.startsWith("/admin/erased-candidates")) return { items: [], total: 0 };
    if (path === PATCH_PATH) return (opts.patch ?? (async () => ({})))(init);
    throw new Error(`unexpected adminApi call: ${path}`);
  });
}

const patchCalls = (): Array<[string, RequestInit]> =>
  adminApi.mock.calls.filter((c) => c[0] === PATCH_PATH) as Array<[string, RequestInit]>;
const box = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: /Let candidates review their answers after a Mock test/ }) as HTMLInputElement;
const saveBtn = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Save answer key setting" }) as HTMLButtonElement;

async function renderLoaded(): Promise<void> {
  render(<TenantSettings embedded />);
  fireEvent.click(await screen.findByRole("tab", { name: /Results/ }));
  await screen.findByRole("checkbox", { name: /Let candidates review their answers after a Mock test/ });
}

beforeEach(() => {
  verifyTotpApi.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("TenantSettings — Candidate answer key", () => {
  it("C1 loads off by default, Save disabled, section has its help id", async () => {
    mockApi({});
    await renderLoaded();
    expect(box().checked).toBe(false);
    expect(saveBtn().disabled).toBe(true);
    expect(document.querySelector('[data-help-id="admin.tenant_settings.candidate_answer_key"]')).not.toBeNull();
  });

  it("C2 turning it on enables Save; PATCHes {enabled:true} and confirms", async () => {
    mockApi({});
    await renderLoaded();
    fireEvent.click(box());
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await screen.findByText("Answer key setting saved.");
    const calls = patchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ enabled: true });
    expect(box().checked).toBe(true);
    expect(saveBtn().disabled).toBe(true);
  });

  it("C3 a fresh-MFA 401 opens the step-up, then retries the save", async () => {
    let first = true;
    mockApi({
      patch: async () => {
        if (first) {
          first = false;
          throw new AdminApiError(401, { code: "AUTHN_FAILED", message: "fresh totp required" });
        }
        return {};
      },
    });
    await renderLoaded();
    fireEvent.click(box());
    fireEvent.click(saveBtn());
    const code = await screen.findByLabelText(/6-digit|authenticator code/i);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Verify & save/ }));
    await screen.findByText("Answer key setting saved.");
    expect(patchCalls()).toHaveLength(2);
  });
});
