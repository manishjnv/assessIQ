// AssessIQ — "Organisation logo" section of the tenant settings page (Logo phase L2).
//   L1  wrong type / too large is rejected before any API call
//   L2  upload PUTs base64, preview updates
//   L3  remove (after confirm) DELETEs and clears the preview
//   L4  API error code maps to plain copy
//   L5  fresh-MFA 401 opens the step-up

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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

const LOGO_PATH = "/admin/tenant-settings/logo";
const NEW_URL = "/api/public/tenant-logo/t1?v=newnewnewnew";

function mockApi(opts: { logoUrl?: string | null; put?: () => Promise<unknown>; del?: () => Promise<unknown> }): void {
  adminApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/admin/tenant-settings") {
      return {
        retention_days: 730,
        updated_at: "2026-09-01T00:00:00.000Z",
        result_release_mode: "manual",
        logo: opts.logoUrl ? { url: opts.logoUrl, width: 200, height: 80, byte_size: 1000 } : null,
      };
    }
    if (path.startsWith("/admin/erased-candidates")) return { items: [], total: 0 };
    if (path === LOGO_PATH && init?.method === "PUT") return (opts.put ?? (async () => ({ logo: { url: NEW_URL } })))();
    if (path === LOGO_PATH && init?.method === "DELETE") return (opts.del ?? (async () => undefined))();
    throw new Error(`unexpected adminApi call: ${path}`);
  });
}

const logoCalls = (): unknown[][] => adminApi.mock.calls.filter((c) => c[0] === LOGO_PATH);
const fileInput = (): HTMLInputElement => screen.getByLabelText("Logo file") as HTMLInputElement;

function pick(file: File): void {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

async function renderLoaded(): Promise<void> {
  render(<TenantSettings embedded />);
  await screen.findByLabelText("Logo file");
  await waitFor(() => expect(adminApi).toHaveBeenCalledWith("/admin/tenant-settings"));
}

beforeEach(() => {
  verifyTotpApi.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("TenantSettings — Organisation logo", () => {
  it("L1 rejects a wrong type and an oversize file before any API call", async () => {
    mockApi({});
    await renderLoaded();

    pick(new File(["x"], "logo.gif", { type: "image/gif" }));
    expect((await screen.findByRole("alert")).textContent).toContain("PNG or JPEG");
    expect((screen.getByRole("button", { name: "Upload logo" }) as HTMLButtonElement).disabled).toBe(true);

    pick(new File([new Uint8Array(512 * 1024 + 1)], "big.png", { type: "image/png" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("512 KB"));
    expect(logoCalls()).toHaveLength(0);
  });

  it("L2 uploads base64 and the preview updates", async () => {
    mockApi({});
    await renderLoaded();
    await screen.findByText("No logo set.");

    pick(new File(["abc"], "logo.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));

    await screen.findByText("Logo updated.");
    const [, init] = logoCalls()[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ content_base64: "YWJj" });
    expect(screen.getByAltText("Acme College logo").getAttribute("src")).toBe(NEW_URL);
  });

  it("L3 remove asks for confirmation, DELETEs and clears the preview", async () => {
    mockApi({ logoUrl: "/api/public/tenant-logo/t1?v=oldoldoldold" });
    await renderLoaded();
    await screen.findByAltText("Acme College logo");

    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(logoCalls()).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove logo" }));

    await screen.findByText("Logo removed.");
    expect((logoCalls()[0] as [string, RequestInit])[1].method).toBe("DELETE");
    expect(screen.queryByAltText("Acme College logo")).toBeNull();
  });

  it("L4 maps an API error code to plain copy", async () => {
    mockApi({
      put: async () => {
        throw new AdminApiError(400, { code: "VALIDATION_FAILED", message: "bad", details: { code: "LOGO_BAD_DIMENSIONS" } });
      },
    });
    await renderLoaded();
    pick(new File(["abc"], "logo.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("between 64 and 2048 pixels");
  });

  it("L5 a fresh-MFA 401 opens the inline step-up", async () => {
    mockApi({
      put: async () => {
        throw new AdminApiError(401, { code: "UNAUTHORIZED", message: "mfa" });
      },
    });
    await renderLoaded();
    pick(new File(["abc"], "logo.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    expect(await screen.findByText(/fresh authenticator check/)).toBeTruthy();
  });
});
