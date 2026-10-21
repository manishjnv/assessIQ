// AssessIQ — "Organisation logo" section of the tenant settings page (Logo phase L2).
//   L1  wrong type is rejected before any API call; an unreadable file is refused before upload
//   L6  the picked logo is resized to fit 600x200 (aspect kept, never enlarged) and sent as PNG
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

// Z-115: the browser resizes the logo with createImageBitmap + canvas. jsdom has
// neither, so stub both. The canvas size is read back to check the fit rule.
let canvasSizes: Array<{ width: number; height: number }> = [];
function stubImage(width: number, height: number): void {
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width, height, close: vi.fn() }));
}

beforeEach(() => {
  verifyTotpApi.mockResolvedValue(undefined);
  canvasSizes = [];
  stubImage(300, 100);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    canvasSizes.push({ width: this.width, height: this.height });
    return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(["png-bytes"], { type: "image/png" }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("TenantSettings — Organisation logo", () => {
  it("L1 rejects a wrong type before any API call, and refuses an unreadable file before upload", async () => {
    mockApi({});
    await renderLoaded();

    pick(new File(["x"], "logo.gif", { type: "image/gif" }));
    expect((await screen.findByRole("alert")).textContent).toContain("PNG or JPEG");
    expect((screen.getByRole("button", { name: "Upload logo" }) as HTMLButtonElement).disabled).toBe(true);

    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode failed")));
    pick(new File(["x"], "broken.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be read as an image"));
    expect(logoCalls()).toHaveLength(0);
  });

  it("L6 resizes to fit 600x200, keeps the aspect ratio and never enlarges", async () => {
    mockApi({});
    await renderLoaded();

    stubImage(1200, 300);
    pick(new File(["abc"], "wide.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    await screen.findByText("Logo updated.");
    expect(canvasSizes.at(-1)).toEqual({ width: 600, height: 150 });

    stubImage(200, 100);
    pick(new File(["abc"], "small.png", { type: "image/png" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    await waitFor(() => expect(logoCalls()).toHaveLength(2));
    expect(canvasSizes.at(-1)).toEqual({ width: 200, height: 100 });
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
    expect(JSON.parse(String(init.body))).toEqual({ content_base64: btoa("png-bytes") });
    expect(screen.getAllByAltText("Acme College logo")[0]!.getAttribute("src")).toBe(NEW_URL);
  });

  it("L3 remove asks for confirmation, DELETEs and clears the preview", async () => {
    mockApi({ logoUrl: "/api/public/tenant-logo/t1?v=oldoldoldold" });
    await renderLoaded();
    await screen.findAllByAltText("Acme College logo");

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
